import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getScenarios: vi.fn(),
  getScenarioById: vi.fn(),
  createScenario: vi.fn(),
  updateScenario: vi.fn(),
  deleteScenario: vi.fn(),
  createScenarioStep: vi.fn(),
  updateScenarioStep: vi.fn(),
  deleteScenarioStep: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  getFriendById: vi.fn(),
  computeNextDeliveryAt: vi.fn(),
  resolveStepContent: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

vi.mock('../services/scenario-stats.js', () => ({
  computeScenarioStats: vi.fn(),
}));

const { scenarios: scenariosModule } = await import('./scenarios.js');

interface ScenarioRow {
  id: string;
  name: string;
  description: string | null;
  trigger_type: string;
  trigger_tag_id: string | null;
  is_active: number;
  delivery_mode: string;
  created_at: string;
  updated_at: string;
  line_account_id: string | null;
  step_count: number;
}

function makeScenarioDb(rows: ScenarioRow[]) {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async all<_T>() {
          calls.push({ sql, binds: bound });
          if (/FROM scenarios s\b/i.test(sql) && /line_account_id IS NULL/i.test(sql)) {
            const [lineAccountId] = bound as [string];
            const filtered = rows.filter(
              (r) => r.line_account_id == null || r.line_account_id === lineAccountId,
            );
            return { results: filtered };
          }
          return { results: [] };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, calls };
}

type Role = 'owner' | 'admin' | 'staff';

type TestEnv = {
  Variables: { staff: { id: string; role: Role } };
  Bindings: { DB: D1Database };
};

function setupApp(db: D1Database, role: Role = 'owner') {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'test-staff', role });
    c.env = { DB: db };
    await next();
  });
  app.route('/', scenariosModule);
  return app;
}

const rowBase = {
  description: null,
  trigger_type: 'friend_add',
  trigger_tag_id: null,
  is_active: 1,
  delivery_mode: 'relative',
  created_at: '2026-05-20T00:00:00.000',
  updated_at: '2026-05-20T00:00:00.000',
  step_count: 0,
};

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
});

describe('GET /api/scenarios?lineAccountId=X', () => {
  test('includes both account-bound and global (NULL) scenarios', async () => {
    const rows: ScenarioRow[] = [
      { id: 's-global', name: 'global', line_account_id: null, ...rowBase },
      { id: 's-acc1', name: 'acc1', line_account_id: 'acc-1', ...rowBase },
      { id: 's-acc2', name: 'acc2', line_account_id: 'acc-2', ...rowBase },
    ];
    const { db, calls } = makeScenarioDb(rows);

    const res = await setupApp(db).request('/api/scenarios?lineAccountId=acc-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { id: string; lineAccountId: string | null }[] };
    expect(body.success).toBe(true);
    // webhook.ts:211 / liff.ts:878 trigger scenarios where line_account_id is
    // NULL (global) OR matches the active account. The list endpoint must
    // mirror that so the UI does not hide records the engine will fire.
    const ids = body.data.map((d) => d.id).sort();
    expect(ids).toEqual(['s-acc1', 's-global']);
    // Serializer surfaces the binding so the UI can distinguish 全アカ共通 from
    // an account-specific scenario.
    const globalRow = body.data.find((d) => d.id === 's-global');
    expect(globalRow?.lineAccountId).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/line_account_id IS NULL/);
    expect(calls[0].sql).toMatch(/s\.line_account_id = \?/);
    expect(calls[0].binds).toEqual(['acc-1']);
  });

  test('falls back to getScenarios helper when no lineAccountId is provided', async () => {
    dbMocks.getScenarios.mockResolvedValue([
      { id: 's-x', name: 'x', line_account_id: null, ...rowBase },
    ]);
    const { db } = makeScenarioDb([]);

    const res = await setupApp(db).request('/api/scenarios');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { id: string }[] };
    expect(body.data.map((d) => d.id)).toEqual(['s-x']);
    expect(dbMocks.getScenarios).toHaveBeenCalledTimes(1);
  });

  test('returns empty array when filter matches nothing and no globals exist', async () => {
    const rows: ScenarioRow[] = [
      { id: 's-other', name: 'other', line_account_id: 'acc-other', ...rowBase },
    ];
    const { db } = makeScenarioDb(rows);

    const res = await setupApp(db).request('/api/scenarios?lineAccountId=acc-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: unknown[] };
    expect(body.data).toEqual([]);
  });
});

// ----- role guard -----
// シナリオは登録した友だちへ自動配信が走る = 本番影響のある設定なので、
// 作成・編集・削除・手動登録は owner / admin 限定。閲覧のみ staff にも開放。

const createdScenarioRow = {
  id: 's-new',
  name: '新規',
  line_account_id: null,
  ...rowBase,
};

describe('POST /api/scenarios role guard', () => {
  const payload = { name: '新規', triggerType: 'friend_add' };

  test('staff is rejected with 403 and nothing is created', async () => {
    const { db } = makeScenarioDb([]);
    const res = await setupApp(db, 'staff').request('/api/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(403);
    expect(dbMocks.createScenario).not.toHaveBeenCalled();
  });

  test('admin can create (201)', async () => {
    dbMocks.createScenario.mockResolvedValue(createdScenarioRow);
    const { db } = makeScenarioDb([]);
    const res = await setupApp(db, 'admin').request('/api/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(201);
    expect(dbMocks.createScenario).toHaveBeenCalledTimes(1);
  });

  test('owner can create (201)', async () => {
    dbMocks.createScenario.mockResolvedValue(createdScenarioRow);
    const { db } = makeScenarioDb([]);
    const res = await setupApp(db, 'owner').request('/api/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(201);
  });
});

describe('POST /api/scenarios/:id/enroll/:friendId role guard', () => {
  const enrollment = {
    id: 'fs-1',
    friend_id: 'f-1',
    scenario_id: 's-1',
    current_step_order: 0,
    status: 'active',
    started_at: '2026-08-11T00:00:00.000',
    next_delivery_at: null,
    updated_at: '2026-08-11T00:00:00.000',
  };

  test('staff cannot enroll a friend into a scenario (403)', async () => {
    const { db } = makeScenarioDb([]);
    const res = await setupApp(db, 'staff').request('/api/scenarios/s-1/enroll/f-1', {
      method: 'POST',
    });
    expect(res.status).toBe(403);
    // 自動配信が起動する enrollFriendInScenario まで到達していないこと
    expect(dbMocks.enrollFriendInScenario).not.toHaveBeenCalled();
  });

  test('admin can enroll a friend (201)', async () => {
    dbMocks.getScenarioById.mockResolvedValue({ id: 's-1' });
    dbMocks.getFriendById.mockResolvedValue({ id: 'f-1' });
    dbMocks.enrollFriendInScenario.mockResolvedValue(enrollment);
    const { db } = makeScenarioDb([]);
    const res = await setupApp(db, 'admin').request('/api/scenarios/s-1/enroll/f-1', {
      method: 'POST',
    });
    expect(res.status).toBe(201);
    expect(dbMocks.enrollFriendInScenario).toHaveBeenCalledWith(expect.anything(), 'f-1', 's-1');
  });
});

describe('scenario mutations are owner/admin only', () => {
  test.each([
    ['PUT', '/api/scenarios/s-1', JSON.stringify({ name: 'x' })],
    ['DELETE', '/api/scenarios/s-1', undefined],
    ['POST', '/api/scenarios/s-1/steps', JSON.stringify({ stepOrder: 1 })],
    ['PUT', '/api/scenarios/s-1/steps/st-1', JSON.stringify({ stepOrder: 1 })],
    ['DELETE', '/api/scenarios/s-1/steps/st-1', undefined],
    ['POST', '/api/scenarios/s-1/steps/reorder', JSON.stringify({ stepIds: [] })],
  ])('%s %s returns 403 for staff', async (method, path, body) => {
    const { db } = makeScenarioDb([]);
    const res = await setupApp(db, 'staff').request(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body,
    });
    expect(res.status).toBe(403);
  });
});

describe('scenario reads stay open to staff', () => {
  test('staff can still list scenarios', async () => {
    dbMocks.getScenarios.mockResolvedValue([]);
    const { db } = makeScenarioDb([]);
    const res = await setupApp(db, 'staff').request('/api/scenarios');
    expect(res.status).toBe(200);
  });
});
