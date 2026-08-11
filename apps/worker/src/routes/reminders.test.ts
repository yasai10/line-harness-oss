import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getReminders: vi.fn(),
  getReminderById: vi.fn(),
  createReminder: vi.fn(),
  updateReminder: vi.fn(),
  deleteReminder: vi.fn(),
  getReminderSteps: vi.fn(),
  createReminderStep: vi.fn(),
  deleteReminderStep: vi.fn(),
  enrollFriendInReminder: vi.fn(),
  getFriendReminders: vi.fn(),
  cancelFriendReminder: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const { reminders } = await import('./reminders.js');

type Role = 'owner' | 'admin' | 'staff';

type TestEnv = {
  Variables: { staff: { id: string; role: Role } };
  Bindings: { DB: D1Database };
};

function setupApp(role: Role = 'owner') {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'test-staff', role });
    c.env = { DB: {} as D1Database };
    await next();
  });
  app.route('/', reminders);
  return app;
}

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
});

function json(app: ReturnType<typeof setupApp>, path: string, method: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// リマインダは「対象日を基準に自動でLINEを送る」仕組みで、scenarios.ts と
// 同じ自動配信クラス。既存方針(シナリオ自動配信の起点は admin 以上)に
// 合わせて、定義の編集も友だちの登録(enroll)も owner / admin 限定にする。
describe('reminders の書き込み系は owner / admin', () => {
  test('staff はリマインダを作成できない', async () => {
    const res = await json(setupApp('staff'), '/api/reminders', 'POST', { name: '前日確認' });
    expect(res.status).toBe(403);
    expect(dbMocks.createReminder).not.toHaveBeenCalled();
  });

  test('staff はリマインダを削除できない', async () => {
    const res = await json(setupApp('staff'), '/api/reminders/r1', 'DELETE');
    expect(res.status).toBe(403);
    expect(dbMocks.deleteReminder).not.toHaveBeenCalled();
  });

  test('staff はステップを追加できない', async () => {
    const res = await json(setupApp('staff'), '/api/reminders/r1/steps', 'POST', {
      offsetMinutes: -60,
      messageType: 'text',
      messageContent: 'まもなくです',
    });
    expect(res.status).toBe(403);
    expect(dbMocks.createReminderStep).not.toHaveBeenCalled();
  });

  test('staff は友だちを登録できない(自動配信の起点)', async () => {
    const res = await json(setupApp('staff'), '/api/reminders/r1/enroll/f1', 'POST', {
      targetDate: '2026-08-20',
    });
    expect(res.status).toBe(403);
    expect(dbMocks.enrollFriendInReminder).not.toHaveBeenCalled();
  });

  test('staff は登録済みリマインダを取り消せない', async () => {
    const res = await json(setupApp('staff'), '/api/friend-reminders/fr1', 'DELETE');
    expect(res.status).toBe(403);
    expect(dbMocks.cancelFriendReminder).not.toHaveBeenCalled();
  });

  test('admin は作成できる', async () => {
    dbMocks.createReminder.mockResolvedValue({
      id: 'r1',
      name: '前日確認',
      created_at: '2026-08-11T12:00:00.000+09:00',
    });
    const res = await json(setupApp('admin'), '/api/reminders', 'POST', { name: '前日確認' });
    expect(res.status).toBe(201);
    expect(dbMocks.createReminder).toHaveBeenCalledTimes(1);
  });

  test('owner は友だちを登録できる', async () => {
    dbMocks.enrollFriendInReminder.mockResolvedValue({
      id: 'e1',
      friend_id: 'f1',
      reminder_id: 'r1',
      target_date: '2026-08-20',
      status: 'scheduled',
    });
    const res = await json(setupApp('owner'), '/api/reminders/r1/enroll/f1', 'POST', {
      targetDate: '2026-08-20',
    });
    expect(res.status).toBe(201);
    expect(dbMocks.enrollFriendInReminder).toHaveBeenCalledTimes(1);
  });
});

describe('reminders の参照系は staff にも開放', () => {
  test('staff は一覧を取得できる', async () => {
    dbMocks.getReminders.mockResolvedValue([]);
    const res = await setupApp('staff').request('/api/reminders');
    expect(res.status).toBe(200);
  });

  test('staff は友だちのリマインダを参照できる', async () => {
    dbMocks.getFriendReminders.mockResolvedValue([]);
    const res = await setupApp('staff').request('/api/friends/f1/reminders');
    expect(res.status).toBe(200);
  });
});
