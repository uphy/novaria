/**
 * オンライン対戦でやり取りする中身と、その詰め方。
 * 端末（`src/online/match.ts`）と Worker（`worker/arena.ts`）の両方から使うので、
 * ブラウザの API にも Workers の API にも触らない。
 *
 * 相手から届いた中身は Worker が素通しするだけなので、全部疑ってかかる。
 * 読めない中身は `parseMessage` が null にして、受け取る側では捨てる。
 */
import { KIND_COUNT, type Kind, type RivalView } from '../core/types';

/** 盤面を 1 枚送る間隔（フレーム）。1 秒に 10 枚 */
export const BOARD_INTERVAL_FRAMES = 6;

/** 1 枚の盤面に詰める空中のマスの上限。これを超えるぶんは捨てる */
const MAX_AIR_CELLS = 120;

/** 地面の 1 マスを表す文字の起点。種類 0 が 'a' */
const KIND_BASE = 97;

/** 合言葉の長さ。口で伝えられる程度に収める */
export const CODE_MAX = 16;

/**
 * 相手の盤面 1 枚。ミニ盤面に描くだけなので、位置は 1/4 マスまで丸める。
 * 1 枚 300 バイトほどで、1 秒 10 枚でも 3KB/秒に収まる
 */
export interface BoardPacket {
  t: 'board';
  /** 地面。列ごとに、下から 1 マス 1 文字（'a' + 種類） */
  g: string[];
  /** 空中（カタマリと落下中）。[列, 高さ * 4, 種類] の繰り返し */
  a: number[];
  /** 滅亡までの近さ（0〜100）。相手の枠を赤く点滅させるのに使う */
  d: number;
  /** 相手のフレーム数。点滅の位相に使う */
  f: number;
}

/** 相手へ届ける中身。Worker は中身を見ずにそのまま相手へ流す */
export type PlayMessage =
  | BoardPacket
  /** 打ち上げたぶんの攻撃の隕石。相手の盤面に n 個降る */
  | { t: 'attack'; n: number }
  /** 自分の惑星が滅亡した。f は対戦が始まってからのフレーム数 */
  | { t: 'over'; f: number };

/** Worker が出す合図 */
export type ServerMessage =
  /** 相手待ち。合言葉でつないだときはその言葉を返す */
  | { t: 'waiting'; code: string | null }
  /** 相手が見つかった。seed は両者で同じ（同じ順番で隕石が降る） */
  | { t: 'start'; seed: number; name: string }
  /** 相手の接続が切れた */
  | { t: 'left' }
  /** 混んでいてつなげない */
  | { t: 'busy' }
  /** 眠らせない用の応答。中身は使わない */
  | { t: 'pong' };

export type Message = PlayMessage | ServerMessage;

/**
 * 合言葉を、つなぎ先を決められる形に整える。
 * 口で伝えたときに食い違わないよう、前後の空白と制御文字を落として小文字に揃える
 */
export function normalizeCode(value: string): string {
  const trimmed = value.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ').trim().toLowerCase();
  return Array.from(trimmed).slice(0, CODE_MAX).join('').trim();
}

export function validCode(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return value === normalizeCode(value) && Array.from(value).length >= 1;
}

/** 自分の盤面を、相手のミニ盤面に描ける形に詰める */
export function encodeBoard(game: {
  ground: { kind: Kind }[][];
  lumps: { y: number; cells: { col: number; rel: number; meteor: { kind: Kind } }[] }[];
  fallings: { col: number; y: number; meteor: { kind: Kind } }[];
  frame: number;
  dangerRatio(): number;
}): BoardPacket {
  const g = game.ground.map((col) =>
    col.map((m) => String.fromCharCode(KIND_BASE + m.kind)).join(''),
  );
  const a: number[] = [];
  const put = (col: number, row: number, kind: Kind): void => {
    if (a.length >= MAX_AIR_CELLS * 3) return;
    a.push(col, Math.round(row * 4), kind);
  };
  for (const lump of game.lumps) {
    for (const cell of lump.cells) put(cell.col, lump.y + cell.rel, cell.meteor.kind);
  }
  for (const f of game.fallings) put(f.col, f.y, f.meteor.kind);
  return { t: 'board', g, a, d: Math.round(game.dangerRatio() * 100), f: game.frame };
}

/** 受け取った盤面。ミニ盤面を描くのに要る分だけを持つ */
class ReceivedBoard implements RivalView {
  constructor(
    readonly cols: number,
    readonly frame: number,
    private readonly danger: number,
    private readonly height: number,
    private readonly cells: { col: number; row: number; meteor: { kind: Kind } }[],
  ) {}

  dangerRatio(): number {
    return this.danger;
  }

  peak(): number {
    return this.height;
  }

  allCells(): Iterable<{ col: number; row: number; meteor: { kind: Kind } }> {
    return this.cells;
  }
}

/** 届いた盤面を描ける形に戻す */
export function decodeBoard(packet: BoardPacket): RivalView {
  const cells: { col: number; row: number; meteor: { kind: Kind } }[] = [];
  packet.g.forEach((col, c) => {
    for (let r = 0; r < col.length; r++) {
      cells.push({ col: c, row: r, meteor: { kind: (col.charCodeAt(r) - KIND_BASE) as Kind } });
    }
  });
  for (let i = 0; i + 2 < packet.a.length; i += 3) {
    cells.push({
      col: packet.a[i],
      row: packet.a[i + 1] / 4,
      meteor: { kind: packet.a[i + 2] as Kind },
    });
  }
  const height = packet.g.reduce((top, col) => Math.max(top, col.length), 0);
  return new ReceivedBoard(packet.g.length, packet.f, packet.d / 100, height, cells);
}

const int = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** 地面の列が、知っている種類の文字だけでできているか */
function validGround(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > 16) return false;
  return value.every(
    (col) =>
      typeof col === 'string' &&
      col.length <= 40 &&
      [...col].every((ch) => {
        const kind = ch.charCodeAt(0) - KIND_BASE;
        return kind >= 0 && kind < KIND_COUNT;
      }),
  );
}

function validAir(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length > MAX_AIR_CELLS * 3 || value.length % 3 !== 0) {
    return false;
  }
  for (let i = 0; i < value.length; i += 3) {
    if (!int(value[i], 0, 15) || !int(value[i + 1], -8, 400) || !int(value[i + 2], 0, KIND_COUNT - 1)) {
      return false;
    }
  }
  return true;
}

/**
 * 届いた文字列を、知っている合図に読み直す。読めなければ null。
 * 相手の端末が送ってくる中身なので、形が違うものは全部ここで落とす
 */
export function parseMessage(text: string): Message | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const m = value as Record<string, unknown>;
  switch (m.t) {
    case 'board':
      return validGround(m.g) && validAir(m.a) && int(m.d, 0, 100) && int(m.f, 0, 60 * 60 * 24)
        ? { t: 'board', g: m.g, a: m.a, d: m.d, f: m.f }
        : null;
    case 'attack':
      return int(m.n, 1, 360) ? { t: 'attack', n: m.n } : null;
    case 'over':
      return int(m.f, 0, 60 * 60 * 24) ? { t: 'over', f: m.f } : null;
    case 'waiting':
      return m.code === null || validCode(m.code) ? { t: 'waiting', code: m.code } : null;
    case 'start':
      return int(m.seed, 1, 0x7fffffff) && typeof m.name === 'string' && m.name.length <= 64
        ? { t: 'start', seed: m.seed, name: m.name }
        : null;
    case 'left':
      return { t: 'left' };
    case 'busy':
      return { t: 'busy' };
    case 'pong':
      return { t: 'pong' };
    default:
      return null;
  }
}
