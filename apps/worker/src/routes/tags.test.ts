import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// Mock @line-crm/db so the route can be driven entirely from this file.
const dbMocks = {
  getTags: vi.fn(),
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  updateTagMileageSettings: vi.fn(),
  enqueueHistoricTagMileage: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

// Re-import after mock so the module picks up mocked deps.
const { tags } = await import('./tags.js');

type Role = 'owner' | 'admin' | 'staff';

type TestEnv = {
  Variables: { staff: { id: string; role: Role } };
  Bindings: { DB: D1Database };
};

function makeDbStub(): D1Database {
  return {} as unknown as D1Database;
}

function setupApp(role: Role = 'owner') {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'test-staff', role });
    c.env = { DB: makeDbStub() };
    await next();
  });
  app.route('/', tags);
  return app;
}

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
});

// DELETE /api/tags/:id はタグを消すと全友だちの紐付けも失われる破壊的操作なので
// owner / admin 限定。staff は 403 で弾かれ、DB には一切触れないこと。
describe('DELETE /api/tags/:id role guard', () => {
  test('staff is rejected with 403 and no DB write happens', async () => {
    const res = await setupApp('staff').request('/api/tags/t1', { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(dbMocks.deleteTag).not.toHaveBeenCalled();
  });

  test('admin can delete', async () => {
    dbMocks.deleteTag.mockResolvedValue(true);
    const res = await setupApp('admin').request('/api/tags/t1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(dbMocks.deleteTag).toHaveBeenCalledWith(expect.anything(), 't1');
  });

  test('owner can delete', async () => {
    dbMocks.deleteTag.mockResolvedValue(true);
    const res = await setupApp('owner').request('/api/tags/t1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(dbMocks.deleteTag).toHaveBeenCalledWith(expect.anything(), 't1');
  });
});

// 参照系 / 追加系は staff にも開放したままであることの回帰テスト
// (role guard を広げすぎて日常運用を壊していないかの確認)。
describe('tags read/create stay open to staff', () => {
  test('staff can list tags', async () => {
    dbMocks.getTags.mockResolvedValue([]);
    const res = await setupApp('staff').request('/api/tags');
    expect(res.status).toBe(200);
  });

  test('staff can create a tag', async () => {
    dbMocks.createTag.mockResolvedValue({
      id: 't-new',
      name: 'VIP',
      color: '#fff',
      created_at: '2026-08-11T00:00:00.000',
    });
    const res = await setupApp('staff').request('/api/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'VIP' }),
    });
    expect(res.status).toBe(201);
  });
});

// PATCH /api/tags/:id/mileage はタグ付与時のマイル還元額と倍率を決める設定で、
// 保存すると過去分の遡及付与まで enqueue される (= 顧客への還元原資が動く)。
// owner / admin 限定で、staff は 403 かつ D1 にも遡及キューにも到達しないこと。
describe('PATCH /api/tags/:id/mileage role guard', () => {
  const body = JSON.stringify({ rewardMiles: 100000, multiplierBps: 100000 });
  const headers = { 'Content-Type': 'application/json' };

  test('staff is rejected with 403 and nothing is written or enqueued', async () => {
    const res = await setupApp('staff').request('/api/tags/t1/mileage', {
      method: 'PATCH', headers, body,
    });
    expect(res.status).toBe(403);
    expect(dbMocks.updateTagMileageSettings).not.toHaveBeenCalled();
    expect(dbMocks.enqueueHistoricTagMileage).not.toHaveBeenCalled();
  });

  for (const role of ['admin', 'owner'] as const) {
    test(`${role} can configure tag mileage`, async () => {
      dbMocks.updateTagMileageSettings.mockResolvedValue({
        id: 't1', name: 'VIP', color: '#fff', created_at: '2026-08-11T00:00:00.000',
      });
      dbMocks.enqueueHistoricTagMileage.mockResolvedValue(3);
      const res = await setupApp(role).request('/api/tags/t1/mileage', {
        method: 'PATCH', headers, body,
      });
      expect(res.status).toBe(200);
      expect(dbMocks.updateTagMileageSettings).toHaveBeenCalled();
    });
  }
});
