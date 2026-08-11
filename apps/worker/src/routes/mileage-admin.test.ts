import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getStaffByApiKey: vi.fn().mockResolvedValue(null),
  getMileageAdminOverview: vi.fn(),
  getMileageRules: vi.fn(),
  getMileageRuleById: vi.fn(),
  createMileageRule: vi.fn(),
  updateMileageRule: vi.fn(),
  deleteMileageRule: vi.fn(),
  getScoringRules: vi.fn(),
  getScoringRuleById: vi.fn(),
  createScoringRule: vi.fn(),
  updateScoringRule: vi.fn(),
  deleteScoringRule: vi.fn(),
  getFriendScore: vi.fn(),
  getFriendScoreHistory: vi.fn(),
  addScore: vi.fn(),
  applyMileageRulesForEvent: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const { authMiddleware } = await import('../middleware/auth.js');
const { scoring } = await import('./scoring.js');
type Env = import('../index.js').Env;

const env = { DB: {} as D1Database, API_KEY: 'owner-key' } as unknown as Env['Bindings'];

function app() {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.route('/', scoring);
  return instance;
}

function call(path: string, init?: RequestInit) {
  return app().request(path, {
    ...init,
    headers: { Authorization: 'Bearer owner-key', 'Content-Type': 'application/json', ...init?.headers },
  }, env);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getStaffByApiKey.mockResolvedValue(null);
});

describe('mileage admin API', () => {
  it('queues a generic authenticated engagement event', async () => {
    dbMocks.applyMileageRulesForEvent.mockResolvedValue({ event: { id: 'event-1' }, granted: [], queued: true });
    const response = await call('/api/mileage/events', {
      method: 'POST',
      body: JSON.stringify({
        friendId: 'friend-1', eventType: 'community_lesson_completed',
        source: 'community', sourceEventId: 'lesson-1', subjectKey: 'lesson-A',
      }),
    });
    expect(response.status).toBe(202);
    expect(dbMocks.applyMileageRulesForEvent).toHaveBeenCalledWith(env.DB, expect.objectContaining({
      friendId: 'friend-1', eventType: 'community_lesson_completed', source: 'community',
    }));
  });

  it('returns a cross-account overview with bounded pagination', async () => {
    dbMocks.getMileageAdminOverview.mockResolvedValue({
      summary: { totalMembers: 10, totalAvailable: 200, activeMembers30d: 4, totalActions: 30 },
      members: [],
      pagination: { total: 10, limit: 100, offset: 0 },
    });
    const response = await call('/api/mileage/overview?accountId=account-1&search=%E7%94%B0&limit=999');
    expect(response.status).toBe(200);
    expect(dbMocks.getMileageAdminOverview).toHaveBeenCalledWith(env.DB, {
      accountId: 'account-1', search: '田', limit: 100, offset: 0,
    });
  });

  it('serializes editable mileage rules', async () => {
    dbMocks.getMileageRules.mockResolvedValue([{
      id: 'rule-1', program_id: 'default', name: 'メッセージ送信', event_type: 'message_received',
      source: 'line', amount: 1, initial_status: 'available', conditions: '{"dailyCapActions":5}',
      is_active: 1, created_at: '2026-08-09', updated_at: '2026-08-09',
    }]);
    const response = await call('/api/mileage/rules');
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Array<{ amount: number; conditions: { dailyCapActions: number } }> };
    expect(body.data[0]).toMatchObject({ amount: 1, conditions: { dailyCapActions: 5 } });
  });

  it('rejects a zero-mile rule update before touching D1', async () => {
    const response = await call('/api/mileage/rules/rule-1', {
      method: 'PUT', body: JSON.stringify({ amount: 0 }),
    });
    expect(response.status).toBe(400);
    expect(dbMocks.updateMileageRule).not.toHaveBeenCalled();
  });
});

// マイレージのルールはマイル (= 顧客への還元原資) の付与条件そのものなので、
// 作成・更新・削除は owner / admin 限定。staff は 403 で弾かれ D1 に到達しない。
// 一方 POST /api/mileage/events は他 Harness 製品からの汎用取り込み口 (staff
// ロールのキーで組まれた既存連携を壊さないため) 、GET は閲覧なので対象外。
describe('mileage admin role guard', () => {
  function callAsStaff(path: string, init?: RequestInit) {
    dbMocks.getStaffByApiKey.mockResolvedValue({ id: 'staff-1', name: 'Staff', role: 'staff' });
    return app().request(path, {
      ...init,
      headers: { Authorization: 'Bearer staff-key', 'Content-Type': 'application/json', ...init?.headers },
    }, env);
  }

  it('staff cannot create a mileage rule', async () => {
    const response = await callAsStaff('/api/mileage/rules', {
      method: 'POST',
      body: JSON.stringify({ name: 'ずる', eventType: 'message_received', source: 'line', amount: 100000 }),
    });
    expect(response.status).toBe(403);
    expect(dbMocks.createMileageRule).not.toHaveBeenCalled();
  });

  it('staff cannot update a mileage rule', async () => {
    const response = await callAsStaff('/api/mileage/rules/rule-1', {
      method: 'PUT', body: JSON.stringify({ amount: 100000 }),
    });
    expect(response.status).toBe(403);
    expect(dbMocks.updateMileageRule).not.toHaveBeenCalled();
  });

  it('staff cannot delete a mileage rule', async () => {
    const response = await callAsStaff('/api/mileage/rules/rule-1', { method: 'DELETE' });
    expect(response.status).toBe(403);
    expect(dbMocks.deleteMileageRule).not.toHaveBeenCalled();
  });

  it('staff can still read mileage rules', async () => {
    dbMocks.getMileageRules.mockResolvedValue([]);
    const response = await callAsStaff('/api/mileage/rules');
    expect(response.status).toBe(200);
  });

  it('POST /api/mileage/events stays open (cross-product ingestion path)', async () => {
    dbMocks.applyMileageRulesForEvent.mockResolvedValue({ event: { id: 'e1' }, granted: [], queued: true });
    const response = await callAsStaff('/api/mileage/events', {
      method: 'POST',
      body: JSON.stringify({
        friendId: 'friend-1', eventType: 'community_lesson_completed',
        source: 'community', sourceEventId: 'lesson-9',
      }),
    });
    expect(response.status).toBe(202);
  });

  it('owner can still create a mileage rule', async () => {
    dbMocks.createMileageRule.mockResolvedValue({
      id: 'rule-9', program_id: 'default', name: '新ルール', event_type: 'message_received',
      source: 'line', amount: 1, initial_status: 'available', conditions: null,
      is_active: 1, created_at: 'x', updated_at: 'x',
    });
    const response = await call('/api/mileage/rules', {
      method: 'POST',
      body: JSON.stringify({ name: '新ルール', eventType: 'message_received', source: 'line', amount: 1 }),
    });
    expect(response.status).toBe(201);
    expect(dbMocks.createMileageRule).toHaveBeenCalled();
  });
});
