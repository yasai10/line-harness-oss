import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getAdPlatforms: vi.fn(),
  getAdPlatformById: vi.fn(),
  createAdPlatform: vi.fn(),
  updateAdPlatform: vi.fn(),
  deleteAdPlatform: vi.fn(),
  getAdConversionLogs: vi.fn(),
  getAdPlatformByName: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const adConversionMocks = { sendAdConversions: vi.fn() };
vi.mock('../services/ad-conversion.js', () => adConversionMocks);

const { adPlatforms } = await import('./ad-platforms.js');

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
  app.route('/', adPlatforms);
  return app;
}

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
  adConversionMocks.sendAdConversions.mockReset();
});

function json(app: ReturnType<typeof setupApp>, path: string, method: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// 広告プラットフォーム連携は config に外部APIのアクセストークン/ピクセルIDを
// 保持し、/test は実際に外部へCVを送信する。認証情報の登録・書き換えと外部送信を
// staff に許すべきではないため owner / admin 限定。
describe('ad-platforms の書き込み系は owner / admin', () => {
  test('staff は連携を登録できない', async () => {
    const res = await json(setupApp('staff'), '/api/ad-platforms', 'POST', {
      name: 'meta',
      config: { accessToken: 'x', pixelId: 'y' },
    });
    expect(res.status).toBe(403);
    expect(dbMocks.createAdPlatform).not.toHaveBeenCalled();
  });

  test('staff は連携設定を更新できない', async () => {
    const res = await json(setupApp('staff'), '/api/ad-platforms/p1', 'PUT', {
      config: { accessToken: 'x' },
    });
    expect(res.status).toBe(403);
    expect(dbMocks.updateAdPlatform).not.toHaveBeenCalled();
  });

  test('staff は連携を削除できない', async () => {
    const res = await json(setupApp('staff'), '/api/ad-platforms/p1', 'DELETE');
    expect(res.status).toBe(403);
    expect(dbMocks.deleteAdPlatform).not.toHaveBeenCalled();
  });

  test('staff はテスト送信できない(外部へのCV送信に到達しない)', async () => {
    const res = await json(setupApp('staff'), '/api/ad-platforms/test', 'POST', {
      platform: 'meta',
      eventName: 'Purchase',
    });
    expect(res.status).toBe(403);
    expect(dbMocks.getAdPlatformByName).not.toHaveBeenCalled();
    expect(adConversionMocks.sendAdConversions).not.toHaveBeenCalled();
  });

  test('admin は連携を登録できる', async () => {
    dbMocks.createAdPlatform.mockResolvedValue({
      id: 'p1',
      name: 'meta',
      display_name: 'Meta',
      config: '{}',
      is_active: 1,
      created_at: '2026-08-11T12:00:00.000+09:00',
    });
    const res = await json(setupApp('admin'), '/api/ad-platforms', 'POST', {
      name: 'meta',
      config: { accessToken: 'x', pixelId: 'y' },
    });
    expect(res.status).toBe(201);
    expect(dbMocks.createAdPlatform).toHaveBeenCalledTimes(1);
  });
});

describe('ad-platforms の参照系は staff にも開放', () => {
  test('staff は一覧を取得できる(config はマスク済み)', async () => {
    dbMocks.getAdPlatforms.mockResolvedValue([]);
    const res = await setupApp('staff').request('/api/ad-platforms');
    expect(res.status).toBe(200);
  });
});
