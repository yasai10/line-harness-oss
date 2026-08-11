import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getTrafficPools: vi.fn(),
  getTrafficPoolById: vi.fn(),
  getTrafficPoolBySlug: vi.fn(),
  createTrafficPool: vi.fn(),
  updateTrafficPool: vi.fn(),
  deleteTrafficPool: vi.fn(),
  getPoolAccounts: vi.fn(),
  addPoolAccount: vi.fn(),
  removePoolAccount: vi.fn(),
  togglePoolAccount: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const { trafficPools } = await import('./traffic-pools.js');

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
  app.route('/', trafficPools);
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

// 流入プールは /pool/:slug でどの LINE アカウントへ友だち追加を振り分けるかを
// 決める配信基盤設定。切り替えると新規友だちの行き先が変わるため owner / admin。
describe('traffic-pools の書き込み系は owner / admin', () => {
  test('staff はプールを作成できない', async () => {
    const res = await json(setupApp('staff'), '/api/traffic-pools', 'POST', {
      slug: 'main',
      name: 'メイン',
      activeAccountId: 'acc-1',
    });
    expect(res.status).toBe(403);
    expect(dbMocks.createTrafficPool).not.toHaveBeenCalled();
  });

  test('staff はプールを削除できない', async () => {
    const res = await json(setupApp('staff'), '/api/traffic-pools/p1', 'DELETE');
    expect(res.status).toBe(403);
    expect(dbMocks.deleteTrafficPool).not.toHaveBeenCalled();
  });

  test('staff はプールにアカウントを追加できない', async () => {
    const res = await json(setupApp('staff'), '/api/traffic-pools/p1/accounts', 'POST', {
      lineAccountId: 'acc-2',
    });
    expect(res.status).toBe(403);
    expect(dbMocks.addPoolAccount).not.toHaveBeenCalled();
  });

  test('staff は振り分け先を切り替えられない', async () => {
    const res = await json(setupApp('staff'), '/api/traffic-pools/p1/accounts/a1', 'PUT', {
      isActive: true,
    });
    expect(res.status).toBe(403);
    expect(dbMocks.togglePoolAccount).not.toHaveBeenCalled();
  });

  test('staff はプールからアカウントを外せない', async () => {
    const res = await json(setupApp('staff'), '/api/traffic-pools/p1/accounts/a1', 'DELETE');
    expect(res.status).toBe(403);
    expect(dbMocks.removePoolAccount).not.toHaveBeenCalled();
  });

  test('admin は振り分け先を切り替えられる', async () => {
    dbMocks.togglePoolAccount.mockResolvedValue({ id: 'a1', is_active: 1 });
    const res = await json(setupApp('admin'), '/api/traffic-pools/p1/accounts/a1', 'PUT', {
      isActive: true,
    });
    expect(res.status).toBe(200);
    expect(dbMocks.togglePoolAccount).toHaveBeenCalledWith(expect.anything(), 'a1', true);
  });

  test('owner はプールを作成できる', async () => {
    dbMocks.createTrafficPool.mockResolvedValue({ id: 'p1', slug: 'main', name: 'メイン' });
    const res = await json(setupApp('owner'), '/api/traffic-pools', 'POST', {
      slug: 'main',
      name: 'メイン',
      activeAccountId: 'acc-1',
    });
    expect(res.status).toBe(201);
    expect(dbMocks.createTrafficPool).toHaveBeenCalledTimes(1);
  });
});

describe('traffic-pools の参照系は staff にも開放', () => {
  test('staff は一覧を取得できる', async () => {
    dbMocks.getTrafficPools.mockResolvedValue([]);
    const res = await setupApp('staff').request('/api/traffic-pools');
    expect(res.status).toBe(200);
  });

  test('staff はプール内アカウントを参照できる', async () => {
    dbMocks.getPoolAccounts.mockResolvedValue([]);
    const res = await setupApp('staff').request('/api/traffic-pools/p1/accounts');
    expect(res.status).toBe(200);
  });
});
