import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// We assert on the SQL/binds the route forwards to D1. The DB-helper path
// (no lineAccountId query) is mocked separately on @line-crm/db.
const dbMocks = {
  getAutomations: vi.fn(),
  getAutomationById: vi.fn(),
  createAutomation: vi.fn(),
  updateAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  getAutomationLogs: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const { automations } = await import('./automations.js');

interface AutomationRow {
  id: string;
  name: string;
  description: string | null;
  event_type: string;
  conditions: string;
  actions: string;
  is_active: number;
  priority: number;
  created_at: string;
  updated_at: string;
  line_account_id: string | null;
}

function makeAutomationDb(rows: AutomationRow[]) {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async all() {
          calls.push({ sql, binds: bound });
          // NULL-aware filter: row matches when its line_account_id is NULL
          // (global) OR equals the bound lineAccountId.
          if (/FROM automations\b/i.test(sql) && /line_account_id IS NULL/i.test(sql)) {
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

function setupApp(db: D1Database, role: Role = 'owner') {
  const app = new Hono<{
    Bindings: { DB: D1Database };
    Variables: { staff: { id: string; role: Role } };
  }>();
  app.use('*', async (c, next) => {
    c.env = { DB: db };
    // authMiddleware normally does this; injected here so requireRole on the
    // CRUD routes has an identity to check.
    c.set('staff', { id: 'test-staff', role });
    await next();
  });
  app.route('/', automations);
  return app;
}

const rowBase = {
  description: null,
  event_type: 'message_received',
  conditions: '{}',
  actions: '[]',
  is_active: 1,
  priority: 0,
  created_at: '2026-05-20T00:00:00.000',
  updated_at: '2026-05-20T00:00:00.000',
};

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
});

describe('GET /api/automations?lineAccountId=X', () => {
  test('includes both account-bound and global (NULL) automations', async () => {
    const rows: AutomationRow[] = [
      { id: 'a-global', name: 'global', line_account_id: null, ...rowBase },
      { id: 'a-acc1', name: 'acc1', line_account_id: 'acc-1', ...rowBase },
      { id: 'a-acc2', name: 'acc2', line_account_id: 'acc-2', ...rowBase },
    ];
    const { db, calls } = makeAutomationDb(rows);

    const res = await setupApp(db).request('/api/automations?lineAccountId=acc-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { id: string; lineAccountId: string | null }[];
    };
    expect(body.success).toBe(true);
    const ids = body.data.map((d) => d.id).sort();
    // The engine (event-bus.ts:149) fires automations whose line_account_id
    // is NULL OR equal to the active account. The list endpoint must mirror
    // that scope, otherwise globals + freshly-created records disappear in
    // the UI even though they will still execute.
    expect(ids).toEqual(['a-acc1', 'a-global']);
    // Scope must be surfaced so callers can tell globals from account-bound
    // rows — otherwise the UI cannot safely offer per-account edit/disable.
    const byId = new Map(body.data.map((d) => [d.id, d.lineAccountId] as const));
    expect(byId.get('a-global')).toBeNull();
    expect(byId.get('a-acc1')).toBe('acc-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/line_account_id IS NULL/);
    expect(calls[0].sql).toMatch(/line_account_id = \?/);
    expect(calls[0].binds).toEqual(['acc-1']);
  });

  test('falls back to getAutomations helper when no lineAccountId is provided', async () => {
    dbMocks.getAutomations.mockResolvedValue([
      { id: 'a-x', name: 'x', line_account_id: null, ...rowBase },
    ]);
    const { db } = makeAutomationDb([]);

    const res = await setupApp(db).request('/api/automations');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { id: string }[] };
    expect(body.data.map((d) => d.id)).toEqual(['a-x']);
    expect(dbMocks.getAutomations).toHaveBeenCalledTimes(1);
  });

  test('returns empty array when filter matches nothing and no globals exist', async () => {
    const rows: AutomationRow[] = [
      { id: 'a-other', name: 'other', line_account_id: 'acc-other', ...rowBase },
    ];
    const { db } = makeAutomationDb(rows);

    const res = await setupApp(db).request('/api/automations?lineAccountId=acc-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: unknown[] };
    expect(body.data).toEqual([]);
  });
});

// =====================================================
// Role guard — オートメーションは send_message / send_webhook を無人で実行する
// =====================================================

describe('automation CRUD role guard', () => {
  const { db } = makeAutomationDb([]);

  const sendMessageRule = {
    name: 'staff rule',
    eventType: 'message_received',
    actions: [{ type: 'send_message', content: 'hi' }],
  };

  test('staff cannot create an automation (403, no DB write)', async () => {
    const res = await setupApp(db, 'staff').request('/api/automations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sendMessageRule),
    });
    expect(res.status).toBe(403);
    expect(dbMocks.createAutomation).not.toHaveBeenCalled();
  });

  test('staff cannot update an automation (403, no DB write)', async () => {
    const res = await setupApp(db, 'staff').request('/api/automations/a-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: true }),
    });
    expect(res.status).toBe(403);
    expect(dbMocks.updateAutomation).not.toHaveBeenCalled();
  });

  test('staff cannot delete an automation (403, no DB write)', async () => {
    const res = await setupApp(db, 'staff').request('/api/automations/a-1', {
      method: 'DELETE',
    });
    expect(res.status).toBe(403);
    expect(dbMocks.deleteAutomation).not.toHaveBeenCalled();
  });

  test('admin can create an automation', async () => {
    dbMocks.createAutomation.mockResolvedValue({
      id: 'a-new',
      name: 'staff rule',
      event_type: 'message_received',
      actions: JSON.stringify(sendMessageRule.actions),
      is_active: 1,
      priority: 0,
      line_account_id: null,
      created_at: '2026-08-11T00:00:00.000',
    });
    const res = await setupApp(db, 'admin').request('/api/automations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sendMessageRule),
    });
    expect(res.status).toBe(201);
    expect(dbMocks.createAutomation).toHaveBeenCalledOnce();
  });

  test('owner can delete an automation', async () => {
    dbMocks.deleteAutomation.mockResolvedValue(undefined);
    const res = await setupApp(db, 'owner').request('/api/automations/a-1', {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(dbMocks.deleteAutomation).toHaveBeenCalledOnce();
  });

  // 閲覧・実行ログは staff の日常業務なので開放したままであることの回帰テスト。
  test('staff can still list automations', async () => {
    dbMocks.getAutomations.mockResolvedValue([]);
    const res = await setupApp(db, 'staff').request('/api/automations');
    expect(res.status).toBe(200);
  });

  test('staff can still read automation logs', async () => {
    dbMocks.getAutomationLogs.mockResolvedValue([]);
    const res = await setupApp(db, 'staff').request('/api/automations/a-1/logs');
    expect(res.status).toBe(200);
  });
});
