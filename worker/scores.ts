import { SCORE_RULES, validName, validSubmission, validUserId } from '../src/scores/model';
import { DELETE_OWN, RENAME, UPSERT_SCORE } from './scores-sql';
import type { RankedScore } from '../src/scores/model';
import type { Env } from './types';

const json = (data: unknown, status = 200): Response =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

/** ランキングに出す上位の数 */
const TOP = 50;
/** 並び順は「得点が高い順、同点なら先に出したほうが上」。順位の計算も表の並びもこの 1 か所で決める */
const ORDER = 'score DESC, created_at, user_id';
const HIGHER = `(score > ?2 OR (score = ?2 AND (created_at < ?3 OR (created_at = ?3 AND user_id < ?4))))`;

/**
 * 表に出す列。遊び手の id は出さない。id は名前の付け替えや行を消すときの合い鍵なので、
 * 他の人に見えると、その人の名前を書き換えたり行を消したりできてしまう
 */
const COLUMNS = 'name, score, launched, max_combo AS maxCombo, seconds';

interface Row {
  name: string;
  score: number;
  launched: number;
  maxCombo: number;
  seconds: number;
}

/** 順位を数えるのに要る、並び順の鍵 */
interface Key {
  score: number;
  createdAt: number;
  userId: string;
}

/** 上位から数えて何位か。同点のときは先に出したほうが上 */
async function rankOf(db: D1Database, row: Key): Promise<number> {
  const result = await db
    .prepare(`SELECT COUNT(*) AS above FROM scores WHERE rules = ?1 AND ${HIGHER}`)
    .bind(SCORE_RULES, row.score, row.createdAt, row.userId)
    .first<{ above: number }>();
  return (result?.above ?? 0) + 1;
}

async function selfRow(db: D1Database, userId: string): Promise<RankedScore | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS}, created_at AS createdAt FROM scores WHERE rules = ? AND user_id = ?`)
    .bind(SCORE_RULES, userId)
    .first<Row & { createdAt: number }>();
  if (!row) return null;
  const { createdAt, ...rest } = row;
  return { ...rest, rank: await rankOf(db, { score: row.score, createdAt, userId }) };
}

async function total(db: D1Database): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS total FROM scores WHERE rules = ?')
    .bind(SCORE_RULES)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** 上位 50 人と、指定された人の順位を返す */
async function list(db: D1Database, userId: string | null): Promise<Response> {
  const rows = await db
    .prepare(`SELECT ${COLUMNS} FROM scores WHERE rules = ? ORDER BY ${ORDER} LIMIT ${TOP}`)
    .bind(SCORE_RULES)
    .all<Row>();
  const scores: RankedScore[] = rows.results.map((row, i) => ({ ...row, rank: i + 1 }));
  return json({
    total: await total(db),
    scores,
    self: userId ? await selfRow(db, userId) : null,
  });
}

/** 自己最高だけを残して書き込む。前より低い得点は順位だけ返す */
async function submit(request: Request, db: D1Database): Promise<Response> {
  const body = await request.text();
  if (body.length > 2048) return json({ error: '送る中身が大きすぎる' }, 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json({ error: '送る中身が読めない' }, 400);
  }
  if (!validSubmission(parsed)) return json({ error: '送る中身が正しくない' }, 400);
  const s = parsed;

  const now = Date.now();
  // 生の IP は残さない。日付を混ぜたハッシュにして、送りすぎを止めるためだけに使う
  const identity = `${Math.floor(now / 86400000)}:${request.headers.get('CF-Connecting-IP') ?? 'local'}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  const submitter = Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join('');

  const result = await db
    .prepare(UPSERT_SCORE)
    .bind(
      s.userId,
      SCORE_RULES,
      s.name,
      s.score,
      s.launched,
      s.maxCombo,
      s.seconds,
      now,
      submitter,
      now - 3600000,
    )
    .run();

  const self = await selfRow(db, s.userId);
  if (!self) return json({ error: '送りすぎ。しばらく待ってから試す' }, 429);
  return json({ self, total: await total(db) }, result.meta.changes ? 201 : 200);
}

/**
 * 名前だけを付け替える。得点は触らない。
 * 名前を変えたときに、次の結果を送るまでランキングが古い名前のままにならないようにする
 */
async function rename(request: Request, db: D1Database): Promise<Response> {
  if (request.method !== 'POST') return json({ error: '使えない呼び出し' }, 405);
  const body = await request.text();
  if (body.length > 512) return json({ error: '送る中身が大きすぎる' }, 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json({ error: '送る中身が読めない' }, 400);
  }
  const value = parsed as { userId?: unknown; name?: unknown };
  if (!validUserId(value.userId) || !validName(value.name)) {
    return json({ error: '送る中身が正しくない' }, 400);
  }
  await db.prepare(RENAME).bind(value.name, value.userId).run();
  // まだ 1 度も送っていない人は、ランキングに行が無い。それでも成功として返す
  return json({ self: await selfRow(db, value.userId), total: await total(db) });
}

/**
 * 自分の行をランキングから消す（「記録」の「ランキングから消す」）。
 * 合い鍵は端末にだけある遊び手の id で、表には出していない
 */
async function remove(request: Request, db: D1Database): Promise<Response> {
  if (request.method !== 'POST') return json({ error: '使えない呼び出し' }, 405);
  const body = await request.text();
  if (body.length > 512) return json({ error: '送る中身が大きすぎる' }, 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json({ error: '送る中身が読めない' }, 400);
  }
  const value = parsed as { userId?: unknown };
  if (!validUserId(value.userId)) return json({ error: '送る中身が正しくない' }, 400);
  const result = await db.prepare(DELETE_OWN).bind(value.userId).run();
  return json({ removed: result.meta.changes });
}

export async function scores(request: Request, env: Env, path: string): Promise<Response> {
  if (!env.SCORES_DB) return json({ error: 'ランキングはいま使えない' }, 503);
  if (path === '/api/scores/name') return await rename(request, env.SCORES_DB);
  if (path === '/api/scores/delete') return await remove(request, env.SCORES_DB);
  if (request.method === 'GET') {
    const self = new URL(request.url).searchParams.get('self');
    if (self !== null && !validUserId(self)) return json({ error: 'id が正しくない' }, 400);
    return await list(env.SCORES_DB, self);
  }
  if (request.method === 'POST') return await submit(request, env.SCORES_DB);
  return json({ error: '使えない呼び出し' }, 405);
}
