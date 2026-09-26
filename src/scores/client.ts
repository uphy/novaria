/**
 * ランキングへの送り手。
 * 端末に遊び手の id と名前を持ち、1 人用の結果を送って順位を受け取る。
 * ランキングが落ちていてもゲームは遊べる。送れなかったぶんは端末に置いて、次の機会に送り直す。
 */
import { SCORE_RULES, normalizeName, validName, validUserId } from './model';
import type { Ranking, Submission } from './model';

const PLAYER = 'novaria.player.v1';
const PENDING = 'novaria.score.pending.v1';
/** 待たせ続けない。この秒数で諦めて、ゲームに戻る */
const TIMEOUT = 8000;

export interface Player {
  id: string;
  name: string;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // 履歴を残さない設定の端末では localStorage が使えない。遊べなくはしない
    return null;
  }
}

/**
 * 制限時間つきの取り消し合図。
 * `AbortSignal.timeout` は Safari 16（iOS 16）より前の端末に無い。
 * 呼んだ時点で例外になると送る処理ごと失敗して、その端末では「送れなかった」が出続けるので、
 * `AbortController` と `setTimeout` で自前に組む
 */
function timeoutSignal(): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), TIMEOUT);
  return controller.signal;
}

/**
 * 遊び手の id（UUID v4）。
 * `crypto.randomUUID` も Safari 15.4 より前の端末に無い。
 * 無ければ乱数から同じ形を組む（`validUserId` が通す形にする）
 */
function newUserId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // 版（4）と variant（8〜b）の桁は UUID v4 の決まりどおりに固定する
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 保存できなくても遊びは止めない */
  }
}

/**
 * 端末に置いてある中身。名前はまだ決めていないことがある。
 * ranked が false なら、本人が「ランキングから消す」を選んでいて、結果を送らない
 */
interface Stored {
  id?: unknown;
  name?: unknown;
  ranked?: unknown;
}

function stored(): Stored | null {
  try {
    const value: unknown = JSON.parse(read(PLAYER) ?? 'null');
    return value && typeof value === 'object' ? (value as Stored) : null;
  } catch {
    return null;
  }
}

/** id と名前を書く。ランキングに載せない設定は、書き換えずにそのまま残す */
function writePlayer(id: string, name: string): void {
  const ranked = stored()?.ranked === false ? { ranked: false } : {};
  write(PLAYER, JSON.stringify({ id, name, ...ranked }));
}

/** ランキングに結果を送るか。本人が「ランキングから消す」を選ぶまでは送る */
export function rankingEnabled(): boolean {
  return stored()?.ranked !== false;
}

/**
 * この端末の id。初めて開いたときに 1 度だけ発行し、以後は変えない。
 * 名前とは切り離してあるので、名前を決めていなくても id は持っている
 * （名前を聞くのは、ランキングや対戦で他の人に見せるときだけ）
 */
export function ensureUserId(): string {
  const raw = stored();
  const id = typeof raw?.id === 'string' && validUserId(raw.id) ? raw.id : newUserId();
  const name = typeof raw?.name === 'string' && validName(raw.name) ? raw.name : '';
  writePlayer(id, name);
  return id;
}

/** 前にも開いたことのある端末か（遊び手の id をもう持っているか）。`ensureUserId` より先に呼ぶ */
export function hasUserId(): boolean {
  const raw = stored();
  return typeof raw?.id === 'string' && validUserId(raw.id);
}

/** 端末に覚えている遊び手。まだ名前を決めていなければ null */
export function loadPlayer(): Player | null {
  const raw = stored();
  if (typeof raw?.id !== 'string' || typeof raw.name !== 'string') return null;
  return validUserId(raw.id) && validName(raw.name) ? { id: raw.id, name: raw.name } : null;
}

/**
 * 名前を決める。id は名前より先に発行してあるので、ここでは名前だけが変わる。
 * 名前だけを変えると、ランキングの同じ行の名前が変わる
 */
export function savePlayer(name: string): Player | null {
  const value = normalizeName(name);
  if (!validName(value)) return null;
  const player: Player = { id: ensureUserId(), name: value };
  writePlayer(player.id, player.name);
  return player;
}

/** 送れずに残っている結果。次に開いたときに送り直す */
function pending(): Submission | null {
  try {
    const value: unknown = JSON.parse(read(PENDING) ?? 'null');
    return value && typeof value === 'object' ? (value as Submission) : null;
  } catch {
    return null;
  }
}

async function post(body: Submission, signal?: AbortSignal): Promise<Ranking | null> {
  const response = await fetch('/api/scores', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? timeoutSignal(),
  });
  // 中身が悪くて断られたぶんは、何度送っても通らないので捨てる
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      write(PENDING, 'null');
    }
    throw new Error(`ランキングに送れなかった (${response.status})`);
  }
  write(PENDING, 'null');
  const result = (await response.json()) as Ranking;
  return result.self ? result : null;
}

/**
 * 1 人用の結果を送る。返ってくるのは自分の行と全体の人数。
 * 送れなかったら端末に置いて、次に開いたときに送り直す（`flushPending`）
 */
export async function submitScore(
  player: Player,
  run: { score: number; launched: number; maxCombo: number; seconds: number },
): Promise<Ranking | null> {
  if (!rankingEnabled()) return null;
  const body: Submission = { userId: player.id, name: player.name, rules: SCORE_RULES, ...run };
  write(PENDING, JSON.stringify(body));
  try {
    return await post(body);
  } catch {
    return null;
  }
}

/**
 * まだ名前を決めていないときの結果を、端末に取っておく。
 * あとで名前を決めたら `flushPending` がこれを送る。
 * 残すのは一番よかった 1 回だけ（何回も遊んでから名前を決めても、その人の自己最高が載る）
 */
export function holdScore(run: {
  score: number;
  launched: number;
  maxCombo: number;
  seconds: number;
}): void {
  if (!rankingEnabled()) return;
  const kept = pending();
  if (kept && kept.score >= run.score) return;
  const body: Submission = { userId: ensureUserId(), name: '', rules: SCORE_RULES, ...run };
  write(PENDING, JSON.stringify(body));
}

/**
 * ランキングに出ている名前を付け替える。
 * 名前を変えても、次の結果を送るまで古い名前のままだと分かりにくい。
 * まだ 1 度も送っていなければ、向こうには何も無いので何も起きない
 */
export async function renamePlayer(player: Player): Promise<void> {
  try {
    await fetch('/api/scores/name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: player.id, name: player.name }),
      signal: timeoutSignal(),
    });
  } catch {
    /* 付け替えられなくても、次に結果を送るときに新しい名前になる */
  }
}

/**
 * 前に送れなかった結果と、名前を決める前に取っておいた結果を送る。
 * 起動したときと、名前を決めたときに呼ぶ
 */
export async function flushPending(): Promise<void> {
  const body = pending();
  if (!body) return;
  if (!rankingEnabled()) {
    write(PENDING, 'null');
    return;
  }
  const player = loadPlayer();
  // 名前が無いと向こうが受け取らない。決まるまで端末に置いたままにする
  if (!player) return;
  // 名前を変えたあとなら、いまの名前で送り直す
  body.name = player.name;
  try {
    await post(body);
  } catch {
    /* 次に開いたときにまた試す */
  }
}

/**
 * 自分の行をランキングから消し、以後は結果を送らない。
 * 消せたら true。電波が無いなどで消せなかったら、設定は変えずに false を返す
 * （載せない設定なのに行が残っている、というずれを作らない）
 */
export async function leaveRanking(): Promise<boolean> {
  const userId = ensureUserId();
  try {
    const response = await fetch('/api/scores/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
      signal: timeoutSignal(),
    });
    if (!response.ok) return false;
  } catch {
    return false;
  }
  const raw = stored();
  write(PLAYER, JSON.stringify({ id: userId, name: typeof raw?.name === 'string' ? raw.name : '', ranked: false }));
  write(PENDING, 'null');
  return true;
}

/** ランキングにまた載せる。次に 1 人用を遊んだ結果から送る */
export function joinRanking(): void {
  const raw = stored();
  const name = typeof raw?.name === 'string' ? raw.name : '';
  write(PLAYER, JSON.stringify({ id: ensureUserId(), name }));
}

/** 上位と自分の順位を取る。落ちていたら例外を投げる（呼び出し側で案内を出す） */
export async function fetchRanking(userId: string | null, signal?: AbortSignal): Promise<Ranking> {
  const query = userId ? `?self=${encodeURIComponent(userId)}` : '';
  const response = await fetch(`/api/scores${query}`, {
    signal: signal ?? timeoutSignal(),
  });
  if (!response.ok) throw new Error(`ランキングを取れなかった (${response.status})`);
  const result = (await response.json()) as Ranking;
  if (!Array.isArray(result.scores)) throw new Error('ランキングの中身が読めない');
  return result;
}
