import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// db 層は mock。ここで見たいのは「どのロールがどのメソッドを通せるか」だけで、
// 実際の SQL は packages/db 側のテストが担保している。
const dbMocks = {
  getCalendarConnections: vi.fn(),
  getCalendarConnectionById: vi.fn(),
  createCalendarConnection: vi.fn(),
  deleteCalendarConnection: vi.fn(),
  getCalendarBookings: vi.fn(),
  getCalendarBookingById: vi.fn(),
  createCalendarBooking: vi.fn(),
  updateCalendarBookingStatus: vi.fn(),
  updateCalendarBookingEventId: vi.fn(),
  getBookingsInRange: vi.fn(),
  toJstString: vi.fn((value: string) => value),
};
vi.mock('@line-crm/db', () => dbMocks);

vi.mock('../services/google-calendar.js', () => ({
  GoogleCalendarClient: class {
    createEvent = vi.fn(async () => ({ eventId: 'gcal-1' }));
    deleteEvent = vi.fn(async () => undefined);
  },
}));

const { calendar } = await import('./calendar.js');

type Role = 'owner' | 'admin' | 'staff';
type TestEnv = {
  Variables: { staff: { id: string; name: string; role: Role } };
  Bindings: { DB: D1Database };
};

function setupApp(role: Role = 'owner') {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'test-staff', name: 'Test Staff', role });
    c.env = { DB: {} as D1Database };
    await next();
  });
  app.route('/', calendar as unknown as Hono<TestEnv>);
  return app;
}

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) {
    if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
  }
  dbMocks.toJstString.mockImplementation((value: string) => value);
});

// Google Calendar 連携の接続情報 (access_token / refresh_token) の登録・削除と、
// 予約レコードの作成・キャンセルは、外部カレンダーへの書き込みまで波及する。
// owner / admin 限定にして、staff は 403 で弾く。空き枠・一覧の GET は現場の
// 日常業務なので staff のまま開放しておく。
describe('/api/integrations/google-calendar/* role guard', () => {
  const writes: [keyof typeof dbMocks, string, string, unknown][] = [
    ['createCalendarConnection', 'POST', '/api/integrations/google-calendar/connect', { calendarId: 'cal-1', authType: 'oauth', accessToken: 'tok' }],
    ['deleteCalendarConnection', 'DELETE', '/api/integrations/google-calendar/conn-1', undefined],
    ['createCalendarBooking', 'POST', '/api/integrations/google-calendar/book', { connectionId: 'conn-1', title: '面談', startAt: '2026-09-01T01:00:00.000Z', endAt: '2026-09-01T02:00:00.000Z' }],
    ['updateCalendarBookingStatus', 'PUT', '/api/integrations/google-calendar/bookings/b1/status', { status: 'cancelled' }],
  ];

  for (const [dbFn, method, path, body] of writes) {
    test(`staff is rejected with 403 on ${method} ${path}`, async () => {
      const res = await setupApp('staff').request(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(res.status).toBe(403);
      expect(dbMocks[dbFn]).not.toHaveBeenCalled();
    });
  }

  for (const role of ['admin', 'owner'] as const) {
    test(`${role} can connect a calendar`, async () => {
      dbMocks.createCalendarConnection.mockResolvedValue({
        id: 'conn-1', calendar_id: 'cal-1', auth_type: 'oauth', is_active: 1, created_at: 'x',
      });
      const res = await setupApp(role).request('/api/integrations/google-calendar/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calendarId: 'cal-1', authType: 'oauth' }),
      });
      expect(res.status).toBe(201);
      expect(dbMocks.createCalendarConnection).toHaveBeenCalled();
    });
  }

  test('staff can still list connections (GET is unguarded)', async () => {
    dbMocks.getCalendarConnections.mockResolvedValue([]);
    const res = await setupApp('staff').request('/api/integrations/google-calendar');
    expect(res.status).toBe(200);
  });
});
