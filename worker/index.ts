/// <reference types="@cloudflare/workers-types" />
/**
 * 配信と API を兼ねる Worker。
 * `/api/` 以外は `dist/` の静的ファイルをそのまま返すので、ゲーム本体はこれまでどおり静的配信のまま。
 */
import { validCode } from '../src/online/protocol';
import { scores } from './scores';
import type { Env } from './types';

export { Arena } from './arena';

const json = (data: unknown, status = 200): Response =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * 対戦の待ち合わせ場所を決める。
 * 合言葉なしは全員が同じ場所（`lobby`）に入り、合言葉ありは言葉ごとに別の場所になる。
 * 合言葉が読めない形なら null を返して断る
 */
function arenaRoom(url: URL): string | null {
  const code = url.searchParams.get('code');
  if (code === null) return 'lobby';
  return validCode(code) ? `room:${code}` : null;
}

/** オンライン対戦の WebSocket を Durable Object につなぐ */
function versus(request: Request, env: Env, url: URL): Response | Promise<Response> {
  if (!env.ARENA) return json({ error: 'オンライン対戦は今使えない' }, 503);
  const room = arenaRoom(url);
  if (room === null) return json({ error: '合言葉が正しくない' }, 400);
  return env.ARENA.get(env.ARENA.idFromName(room)).fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    // 別のサイトに置いたページから書き込まれないようにする
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return json({ error: '呼び出し元が違う' }, 403);
    if (request.headers.get('Sec-Fetch-Site') === 'cross-site') {
      return json({ error: '呼び出し元が違う' }, 403);
    }
    if (request.method === 'POST' && !origin) return json({ error: '呼び出し元を確かめられない' }, 403);

    if (url.pathname === '/api/versus') return versus(request, env, url);

    if (url.pathname === '/api/scores' || url.pathname === '/api/scores/name' || url.pathname === '/api/scores/delete') {
      try {
        return await scores(request, env, url.pathname);
      } catch {
        // ランキングが落ちてもゲームは遊べる。ここで握って 503 を返す
        return json({ error: 'ランキングは今使えない' }, 503);
      }
    }
    return json({ error: '見つからない' }, 404);
  },
};
