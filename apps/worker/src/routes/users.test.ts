import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getUsers: vi.fn(),
  getUserById: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
  linkFriendToUser: vi.fn(),
  getUserFriends: vi.fn(),
  getUserByEmail: vi.fn(),
  getUserByPhone: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const { users } = await import('./users.js');

type Role = 'owner' | 'admin' | 'staff';

type TestEnv = {
  Variables: { staff: { id: string; role: Role } };
  Bindings: { DB: D1Database };
};

const userRow = {
  id: 'u1',
  email: 'a@example.com',
  phone: null,
  external_id: null,
  display_name: 'A',
  created_at: '2026-08-11T12:00:00.000+09:00',
  updated_at: '2026-08-11T12:00:00.000+09:00',
};

function setupApp(role: Role = 'owner') {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'test-staff', role });
    c.env = { DB: {} as D1Database };
    await next();
  });
  app.route('/', users);
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

// users は CRM の顧客識別レコード(メール・電話・外部ID)で、friend との
// 紐付け(link)はアカウント横断の名寄せそのもの。誤操作すると別人のトーク
// 履歴が統合されるため owner / admin 限定。スタッフ管理の staff.ts とは別物。
describe('users の書き込み系は owner / admin', () => {
  test('staff は作成できない', async () => {
    const res = await json(setupApp('staff'), '/api/users', 'POST', { email: 'a@example.com' });
    expect(res.status).toBe(403);
    expect(dbMocks.createUser).not.toHaveBeenCalled();
  });

  test('staff は更新できない', async () => {
    const res = await json(setupApp('staff'), '/api/users/u1', 'PUT', { displayName: 'B' });
    expect(res.status).toBe(403);
    expect(dbMocks.updateUser).not.toHaveBeenCalled();
  });

  test('staff は削除できない', async () => {
    const res = await json(setupApp('staff'), '/api/users/u1', 'DELETE');
    expect(res.status).toBe(403);
    expect(dbMocks.deleteUser).not.toHaveBeenCalled();
  });

  test('staff は friend の紐付けができない', async () => {
    const res = await json(setupApp('staff'), '/api/users/u1/link', 'POST', { friendId: 'f1' });
    expect(res.status).toBe(403);
    expect(dbMocks.linkFriendToUser).not.toHaveBeenCalled();
  });

  test('admin は作成できる', async () => {
    dbMocks.createUser.mockResolvedValue(userRow);
    const res = await json(setupApp('admin'), '/api/users', 'POST', { email: 'a@example.com' });
    expect(res.status).toBe(201);
    expect(dbMocks.createUser).toHaveBeenCalledTimes(1);
  });

  test('owner は紐付けできる', async () => {
    dbMocks.linkFriendToUser.mockResolvedValue(undefined);
    const res = await json(setupApp('owner'), '/api/users/u1/link', 'POST', { friendId: 'f1' });
    expect(res.status).toBe(200);
    expect(dbMocks.linkFriendToUser).toHaveBeenCalledWith(expect.anything(), 'f1', 'u1');
  });
});

// 参照系は staff にも開放したまま。/api/users/match は POST だが
// メール/電話からの検索(読み取り)なので制限しない。
describe('users の参照系は staff にも開放', () => {
  test('staff は一覧を取得できる', async () => {
    dbMocks.getUsers.mockResolvedValue([]);
    const res = await setupApp('staff').request('/api/users');
    expect(res.status).toBe(200);
  });

  test('staff は match で検索できる', async () => {
    dbMocks.getUserByEmail.mockResolvedValue(userRow);
    const res = await json(setupApp('staff'), '/api/users/match', 'POST', {
      email: 'a@example.com',
    });
    expect(res.status).toBe(200);
  });
});
