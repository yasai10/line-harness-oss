import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getLinkBaseUrl: vi.fn(),
  setLinkBaseUrl: vi.fn(),
  getTrackedLinkBaseUrl: vi.fn(),
  setTrackedLinkBaseUrl: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const { accountSettings } = await import('./account-settings.js');

type Role = 'owner' | 'admin' | 'staff';

type TestEnv = {
  Variables: { staff: { id: string; role: Role } };
  Bindings: { DB: D1Database };
};

const run = vi.fn();
const first = vi.fn();

function makeDbStub(): D1Database {
  return {
    prepare: () => ({
      bind: () => ({ run, first }),
    }),
  } as unknown as D1Database;
}

function setupApp(role: Role = 'owner') {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'test-staff', role });
    c.env = { DB: makeDbStub() };
    await next();
  });
  app.route('/', accountSettings);
  return app;
}

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
  run.mockReset();
  run.mockResolvedValue(undefined);
  first.mockReset();
  first.mockResolvedValue(null);
});

function putJson(app: ReturnType<typeof setupApp>, path: string, body: unknown) {
  return app.request(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// link_base_url / tracked_link_base_url は sentinel '__global__' に保存される
// アカウント横断のグローバル設定。短縮リンク・計測リンクの配信先ドメインを
// 丸ごと差し替えるため、公開済みリンクを一括で壊す/別ドメインへ流すことが
// できる。line-accounts.ts の LINE アカウント CRUD と同じ「アカウント基盤設定」
// クラスなので、admin にも開放せず owner 専用にしている。
describe('account-settings global base URL は owner 専用', () => {
  for (const path of [
    '/api/account-settings/link-base-url',
    '/api/account-settings/tracked-link-base-url',
  ]) {
    test(`staff は ${path} を変更できない`, async () => {
      const res = await putJson(setupApp('staff'), path, { value: 'https://evil.example' });
      expect(res.status).toBe(403);
      expect(dbMocks.setLinkBaseUrl).not.toHaveBeenCalled();
      expect(dbMocks.setTrackedLinkBaseUrl).not.toHaveBeenCalled();
    });

    test(`admin も ${path} を変更できない`, async () => {
      const res = await putJson(setupApp('admin'), path, { value: 'https://ok.example' });
      expect(res.status).toBe(403);
      expect(dbMocks.setLinkBaseUrl).not.toHaveBeenCalled();
      expect(dbMocks.setTrackedLinkBaseUrl).not.toHaveBeenCalled();
    });
  }

  test('owner は link-base-url を変更できる', async () => {
    dbMocks.setLinkBaseUrl.mockResolvedValue(undefined);
    const res = await putJson(setupApp('owner'), '/api/account-settings/link-base-url', {
      value: 'https://links.example',
    });
    expect(res.status).toBe(200);
    expect(dbMocks.setLinkBaseUrl).toHaveBeenCalledWith(
      expect.anything(),
      '__global__',
      'https://links.example',
    );
  });

  test('owner は tracked-link-base-url を変更できる', async () => {
    dbMocks.setTrackedLinkBaseUrl.mockResolvedValue(undefined);
    const res = await putJson(setupApp('owner'), '/api/account-settings/tracked-link-base-url', {
      value: 'https://t.example',
    });
    expect(res.status).toBe(200);
    expect(dbMocks.setTrackedLinkBaseUrl).toHaveBeenCalledWith(
      expect.anything(),
      '__global__',
      'https://t.example',
    );
  });
});

// テスト送信先はアカウント単位の運用設定(誤送信の影響も本人宛のみ)なので
// グローバル設定より一段緩い owner / admin。
describe('test-recipients は owner / admin', () => {
  test('staff は 403 で DB に到達しない', async () => {
    const res = await putJson(setupApp('staff'), '/api/account-settings/test-recipients', {
      accountId: 'acc-1',
      friendIds: ['f1'],
    });
    expect(res.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  test('admin は更新できる', async () => {
    const res = await putJson(setupApp('admin'), '/api/account-settings/test-recipients', {
      accountId: 'acc-1',
      friendIds: ['f1'],
    });
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

// 参照系は全ロールに開放したまま(GET は制限しない方針)。
describe('GET は staff にも開放', () => {
  test('staff は link-base-url を参照できる', async () => {
    dbMocks.getLinkBaseUrl.mockResolvedValue('https://links.example');
    const res = await setupApp('staff').request('/api/account-settings/link-base-url');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: 'https://links.example' });
  });
});
