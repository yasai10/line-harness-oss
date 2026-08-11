import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// Mock @line-crm/db / LINE SDK / 送信サービスを全て差し替え、
// role guard の分岐だけを純粋に検証できるようにする。
const dbMocks = {
  getBroadcasts: vi.fn(),
  getBroadcastById: vi.fn(),
  createBroadcast: vi.fn(),
  updateBroadcast: vi.fn(),
  deleteBroadcast: vi.fn(),
  getLineAccountById: vi.fn(),
  getFriendsByTag: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(() => ({})),
}));

const broadcastServiceMocks = {
  processBroadcastSend: vi.fn(),
  buildMessage: vi.fn(),
  processQueuedBroadcasts: vi.fn(),
};
vi.mock('../services/broadcast.js', () => broadcastServiceMocks);

vi.mock('../services/dedup-broadcast.js', () => ({
  computeDedupBroadcastPreview: vi.fn(),
}));

vi.mock('../services/segment-send.js', () => ({
  processSegmentSend: vi.fn(),
}));

// Re-import after mocks so the module picks up mocked deps.
const { broadcasts } = await import('./broadcasts.js');

type Role = 'owner' | 'admin' | 'staff';

type TestEnv = {
  Variables: { staff: { id: string; role: Role } };
  Bindings: {
    DB: D1Database;
    LINE_CHANNEL_ACCESS_TOKEN: string;
    WORKER_URL: string;
  };
};

// prepare().bind().run() が常に changes=1 を返す D1 スタブ。
// 送信ルートの atomic lock (`UPDATE ... WHERE status IN ('draft','scheduled')`)
// を「ロック取得成功」として通すために使う。
function makeDbStub(changes = 1): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        run: vi.fn(async () => ({ meta: { changes } })),
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [] })),
      })),
    })),
    batch: vi.fn(async () => []),
  } as unknown as D1Database;
}

function setupApp(role: Role = 'owner', dbStub: D1Database = makeDbStub()) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'test-staff', role });
    c.env = {
      DB: dbStub,
      LINE_CHANNEL_ACCESS_TOKEN: 'token',
      WORKER_URL: 'https://worker.example',
    };
    await next();
  });
  app.route('/', broadcasts);
  return app;
}

// target_type='all' / status='draft' → 即時送信パス (最短で 200 に到達する形)
const draftBroadcast = {
  id: 'b-1',
  title: 'お知らせ',
  message_type: 'text',
  message_content: 'hello',
  target_type: 'all',
  target_tag_id: null,
  status: 'draft',
  scheduled_at: null,
  sent_at: null,
  total_count: 0,
  success_count: 0,
  line_account_id: null,
  track_links: 1,
  created_at: '2026-08-11T00:00:00.000',
};

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
  for (const fn of Object.values(broadcastServiceMocks)) fn.mockReset();
});

// 一斉配信は本番影響が最も大きい操作。staff が誤って/勝手に送信できないよう
// owner / admin 限定であること、かつ 403 のときは送信処理に一切入らないこと。
describe('POST /api/broadcasts/:id/send role guard', () => {
  test('staff is rejected with 403 before any send work happens', async () => {
    const res = await setupApp('staff').request('/api/broadcasts/b-1/send', { method: 'POST' });
    expect(res.status).toBe(403);
    // guard より手前で止まっている = 配信対象の解決すら走っていない
    expect(dbMocks.getBroadcastById).not.toHaveBeenCalled();
    expect(broadcastServiceMocks.processBroadcastSend).not.toHaveBeenCalled();
  });

  test('admin can send', async () => {
    dbMocks.getBroadcastById.mockResolvedValue(draftBroadcast);
    broadcastServiceMocks.processBroadcastSend.mockResolvedValue(undefined);

    const res = await setupApp('admin').request('/api/broadcasts/b-1/send', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(broadcastServiceMocks.processBroadcastSend).toHaveBeenCalledTimes(1);
  });

  test('owner can send', async () => {
    dbMocks.getBroadcastById.mockResolvedValue(draftBroadcast);
    broadcastServiceMocks.processBroadcastSend.mockResolvedValue(undefined);

    const res = await setupApp('owner').request('/api/broadcasts/b-1/send', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(broadcastServiceMocks.processBroadcastSend).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/broadcasts/:id/send-segment role guard', () => {
  const conditions = { operator: 'AND', rules: [{ type: 'tag_exists', value: 't1' }] };

  test('staff is rejected with 403', async () => {
    const res = await setupApp('staff').request('/api/broadcasts/b-1/send-segment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conditions }),
    });
    expect(res.status).toBe(403);
    expect(dbMocks.getBroadcastById).not.toHaveBeenCalled();
  });

  test('admin can queue a segment send (202)', async () => {
    dbMocks.getBroadcastById.mockResolvedValue(draftBroadcast);

    const res = await setupApp('admin').request('/api/broadcasts/b-1/send-segment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conditions }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { success: boolean; queued: boolean };
    expect(body.success).toBe(true);
    expect(body.queued).toBe(true);
  });
});

// 下書きの作成・編集は staff にも許可したままである回帰テスト。
describe('broadcast draft CRUD stays open to staff', () => {
  test('staff can list broadcasts', async () => {
    dbMocks.getBroadcasts.mockResolvedValue([]);
    const res = await setupApp('staff').request('/api/broadcasts');
    expect(res.status).toBe(200);
  });
});
