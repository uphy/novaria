/**
 * CPU の思考。対戦の相手と、バランス計測（`pnpm sim`）の両方で使う。
 * 指でなぞるのと同じ `grab` → `dragBy` → `release` を通すので、
 * 「なぞる途中で揃ったらそこで置く」のような人と同じ制約がそのまま効く。
 */
import { Game } from './game';
import { ATTACK, MAX_IGNITION_RUN, MIN_IGNITION_RUN, PHYSICS, SCREEN_OUT_ROW } from './constants';
import { Kind } from './types';

/** 1 手 = ある列の隕石を、その列の中の別の位置へ運ぶ */
interface Move {
  col: number;
  from: number;
  to: number;
}

/** CPU の強さ。手の速さ、空中で揃え直すか、攻撃量の補正で決まる */
export interface CpuStyle {
  /** 1 手を打つ間隔（フレーム）。短いほど速く動く */
  readonly moveFrames: number;
  /** 空中のカタマリの中でも揃え直すか（第二次点火を狙うか） */
  readonly chains: boolean;
  /**
   * CPU が送る攻撃の隕石の倍率。
   * 原作も難易度ごとに変換率を調整している。
   * 手の速さだけを変えても、速い CPU は自分も多く攻撃を受けるので強さの差が出なかった
   */
  readonly attackScale: number;
  /**
   * 縦にもそろえ、高く積もった列を崩しにいくか（`planGuarded`）。
   * 切ると横そろえだけの `planHigh` になり、1 列が高く積もったまま自滅する
   */
  readonly guard: boolean;
}

export type CpuLevel = 'easy' | 'normal' | 'hard';

/**
 * 対戦で選べる 3 段階。
 * 以前は `pnpm sim` の 4 段階の速さをそのまま使っていたが、
 * どの段でも盤面が攻撃の隕石で埋まって遊べなかったので、手の間隔と倍率を一段ずつ緩めた。
 * 倍率を下げると降る量がそのまま減り、間隔を空けると CPU が打ち上げる回数自体が減る。
 * そのあと、ふつうとつよいは 1 列が高く積もって自滅するばかりで 2 分ほどで倒せたので、
 * 列を見張る思考（`guard`）に替え、そのぶん間隔と倍率を緩め直した（docs/decisions.md「CPU の強さ」）
 */
export const CPU_STYLES: Record<CpuLevel, CpuStyle> = {
  easy: { moveFrames: 54, chains: false, attackScale: 0.2, guard: false },
  normal: { moveFrames: 40, chains: false, attackScale: 0.3, guard: true },
  hard: { moveFrames: 20, chains: true, attackScale: 0.5, guard: true },
};

/**
 * 原作の上級者と同じ考え方で手を選ぶ。
 * 山の高いところで点火するほど持ち上げる隕石が少なく、大気圏まで届きやすい。
 * だから「できるだけ高い row で、隣り合う 3 列に同じ柄を運んで横にそろえる」手を探す。
 * 横にしかそろえず、列の高さも見ないので、1 列だけが高く積もると崩せずに滅亡する。
 * 「よわい」と、人の代わりに遊ばせる計測（`pnpm sim tour` など）はこちらを使う
 */
function planHigh(game: Game): Move[] | null {
  const cols = game.cols;
  const height = (c: number) => game.ground[c].length;
  const isNormal = (c: number, r: number) => {
    const m = game.ground[c][r];
    return m !== undefined && m.kind !== Kind.Dust;
  };

  let best: { moves: Move[]; row: number } | null = null;

  // 横そろえ: 隣り合う 3 列の同じ row に同じ柄を集める
  for (let c = 0; c + 2 < cols; c++) {
    const trio = [c, c + 1, c + 2];
    const maxRow = Math.min(...trio.map(height)) - 1;
    for (let r = maxRow; r >= 0; r--) {
      if (best !== null && r <= best.row) break;
      const kinds = new Set<Kind>();
      for (const col of trio) {
        for (let i = r; i < height(col); i++) if (isNormal(col, i)) kinds.add(game.ground[col][i].kind);
      }
      for (const kind of kinds) {
        const moves: Move[] = [];
        let ok = true;
        for (const col of trio) {
          if (game.ground[col][r]?.kind === kind) continue;
          // r より上にある同じ柄を r まで下ろす（下から運び上げるより手数が読みやすい）
          let found = -1;
          for (let i = r + 1; i < height(col); i++) {
            if (isNormal(col, i) && game.ground[col][i].kind === kind) {
              found = i;
              break;
            }
          }
          if (found < 0) {
            for (let i = r - 1; i >= 0; i--) {
              if (isNormal(col, i) && game.ground[col][i].kind === kind) {
                found = i;
                break;
              }
            }
          }
          if (found < 0) {
            ok = false;
            break;
          }
          moves.push({ col, from: found, to: r });
        }
        if (ok && moves.length > 0 && (best === null || r > best.row)) best = { moves, row: r };
      }
    }
  }
  return best?.moves ?? null;
}

/** 地面で点火させる 1 つの案。運ぶ手と、その値打ち */
interface Candidate {
  moves: Move[];
  value: number;
  /** 何を狙った手か。ヒントに添える説明に使う */
  aim: HintAim;
}

/**
 * 手の狙い。ヒントの矢印に添えて出す。
 * - chain … 空中のカタマリの中で揃え直す（連続点火）
 * - ignite … この 1 手で揃って点火する。breaks は高く積もった列が低くなるか
 * - setup … あと left 手で揃う、その 1 手目（仕込み）
 */
export type HintAim =
  | { kind: 'chain' }
  | { kind: 'ignite'; vertical: boolean; count: number; breaks: boolean }
  | { kind: 'setup'; vertical: boolean; count: number; left: number };

/**
 * 点火したカタマリがどれだけ上がるかを見積もる（マス）。
 * `Game.applyThrust` と `Game.updateLumps` の上昇と同じ式を、1 本の柱として回す。
 * 空中での組み替えや、上から降ってきて押し下げられるぶんは見ない
 */
function riseOf(game: Game, mass: number, count: number, vertical: boolean, bottom: boolean): number {
  const p = game.planet;
  const m = Math.pow(Math.max(1, mass * p.lumpMassScale), PHYSICS.massExponent);
  const bonus = (bottom ? p.bottomBonus : 1) * Math.pow(p.reigniteScale, game.combo);
  const accel = (p.thrust * count * bonus * (vertical ? p.columnThrustScale : 1)) / m;
  const gravity = p.gravity ?? PHYSICS.gravity;
  let vy = (p.kick * count * bonus) / m;
  let y = 0;
  for (let f = 0; f < 600; f++) {
    const thrusting = f < p.thrustTime;
    if (thrusting) vy += accel;
    if (vy <= 0 && !thrusting) break;
    vy = Math.min(PHYSICS.maxRiseSpeed, vy - gravity);
    y += vy;
  }
  return y;
}

/**
 * 列の高さの危なさ。低いうちは 0 で、滅亡の判定（12 段）に近づくほど急に重くなる。
 * 数え上げが始まっている列はさらに重い
 */
function peril(height: number, counting: boolean): number {
  const over = Math.max(0, height - 6);
  return over * over + (counting ? 40 : 0);
}

/**
 * 手を選ぶ。候補は 2 通り。
 *
 * - 横そろえ … 隣り合う 3 列の同じ row に同じ柄を集める
 * - 縦そろえ … 1 列の中で同じ柄を 3 つ重ねる。高く積もった 1 列を崩せるのはこれだけ
 *
 * どの候補も「点火したら何マス上がり、何個が大気圏を抜けるか」を上昇の式で見積もり、
 * 相手へ送れる量と、高い列がどれだけ低くなるかで値打ちを付ける。
 * `planHigh` だけでは 1 列だけが高く積もると崩す手が無く、ほぼ毎回その 1 列で滅亡していた
 */
function planGuarded(game: Game): Candidate | null {
  const cols = game.cols;
  const ground = game.ground;
  const height = (c: number) => ground[c].length;
  const kindAt = (c: number, r: number): Kind | null => {
    const m = ground[c]?.[r];
    return m !== undefined && m.kind !== Kind.Dust ? m.kind : null;
  };
  const counting = (c: number) => game.breakTimers[c] !== null;
  let before = 0;
  for (let c = 0; c < cols; c++) before += peril(height(c), counting(c));

  /**
   * 列ごとの点火位置（pivot）から上を持ち上げたときの値打ち。
   * 点火した隕石は燃えカスになって軽くなる（`PHYSICS.dustMass`）
   */
  const judge = (
    pivots: Map<number, number>,
    ignited: number,
    vertical: boolean,
    moves: number,
  ): { value: number; relief: number } => {
    let mass = 0;
    let base = Infinity;
    for (const [c, pivot] of pivots) {
      base = Math.min(base, pivot);
      for (let r = pivot; r < height(c); r++) {
        const m = ground[c][r];
        mass += m.kind === Kind.Dust ? PHYSICS.dustMass : 1;
      }
    }
    mass -= ignited * (1 - PHYSICS.dustMass);
    const rise = riseOf(game, mass, ignited, vertical, base === 0);
    let units = 0;
    let lifted = 0;
    let after = before;
    for (const [c, pivot] of pivots) {
      let out = 0;
      for (let r = pivot; r < height(c); r++) {
        lifted++;
        if (r + rise < SCREEN_OUT_ROW) continue;
        out++;
        // 点火したマスは燃えカスとして抜ける。攻撃力は通常の 1/3
        const burnt = r < pivot + (vertical ? ignited : 1);
        units += burnt || ground[c][r].kind === Kind.Dust ? ATTACK.unitDust : ATTACK.unitNormal;
      }
      after += peril(height(c) - out, false) - peril(height(c), counting(c));
    }
    return {
      value: units / ATTACK.unitsPerMeteor + (before - after) * 0.5 + lifted * 0.05 - moves * 0.6,
      relief: before - after,
    };
  };

  let best: Candidate | null = null;
  const offer = (moves: Move[], pivots: Map<number, number>, ignited: number, vertical: boolean) => {
    if (moves.length === 0) return;
    const { value, relief } = judge(pivots, ignited, vertical, moves.length);
    if (best !== null && value <= best.value) return;
    const aim: HintAim =
      moves.length === 1
        ? { kind: 'ignite', vertical, count: ignited, breaks: relief > 0 }
        : { kind: 'setup', vertical, count: ignited, left: moves.length };
    best = { moves, value, aim };
  };

  // 横そろえ: 隣り合う 3 列の同じ row に同じ柄を集める
  for (let c = 0; c + 2 < cols; c++) {
    const trio = [c, c + 1, c + 2];
    const maxRow = Math.min(...trio.map(height)) - 1;
    for (let r = maxRow; r >= 0; r--) {
      const kinds = new Set<Kind>();
      for (const col of trio) {
        for (let i = 0; i < height(col); i++) {
          const k = kindAt(col, i);
          if (k !== null) kinds.add(k);
        }
      }
      for (const kind of kinds) {
        const moves: Move[] = [];
        let ok = true;
        for (const col of trio) {
          if (kindAt(col, r) === kind) continue;
          // いちばん近い同じ柄を r まで運ぶ
          let found = -1;
          for (let d = 1; d < height(col) && found < 0; d++) {
            if (kindAt(col, r + d) === kind) found = r + d;
            else if (kindAt(col, r - d) === kind) found = r - d;
          }
          if (found < 0) {
            ok = false;
            break;
          }
          moves.push({ col, from: found, to: r });
        }
        if (!ok) continue;
        // 両隣に同じ柄が並んでいれば 4〜5 個の点火になる
        const pivots = new Map(trio.map((col) => [col, r]));
        for (let x = c - 1; x >= 0 && pivots.size < MAX_IGNITION_RUN && kindAt(x, r) === kind; x--) pivots.set(x, r);
        for (let x = c + 3; x < cols && pivots.size < MAX_IGNITION_RUN && kindAt(x, r) === kind; x++) pivots.set(x, r);
        offer(moves, pivots, pivots.size, false);
      }
    }
  }

  // 縦そろえ: 1 列の中の同じ柄 3 つを、いちばん上のものの下へ寄せて重ねる
  for (let c = 0; c < cols; c++) {
    const byKind = new Map<Kind, number[]>();
    for (let i = 0; i < height(c); i++) {
      const k = kindAt(c, i);
      if (k === null) continue;
      if (!byKind.has(k)) byKind.set(k, []);
      byKind.get(k)!.push(i);
    }
    for (const rows of byKind.values()) {
      for (let j = 0; j + 2 < rows.length; j++) {
        const [a, b, top] = [rows[j], rows[j + 1], rows[j + 2]];
        // 真ん中を top の 1 つ下へ、下を 2 つ下へ。先に上側を動かせば、残りの添字はずれない
        const moves: Move[] = [];
        if (b !== top - 1) moves.push({ col: c, from: b, to: top - 1 });
        if (a !== top - 2) moves.push({ col: c, from: a, to: top - 2 });
        offer(moves, new Map([[c, top - 2]]), MIN_IGNITION_RUN, true);
      }
    }
  }
  return best as Candidate | null;
}

/** 空中のカタマリの 1 列の中で、from 番と to 番（下から数えた添字）の隕石を入れ替える手 */
interface LumpSwap {
  lumpId: number;
  col: number;
  from: number;
  to: number;
}

/**
 * 空中のカタマリの中でそろえ直す手を探す（第二次点火）。
 * 原作ではここが一番の稼ぎどころで、点火を重ねるほど高く飛ぶ。
 * 返すのは列ごとの入れ替え。列はどれも別なので、どの順に入れ替えても同じになる
 */
function planLump(game: Game): LumpSwap[] | null {
  for (const lump of game.lumps) {
    const byCol = new Map<number, number[]>();
    for (const cell of lump.cells) {
      if (!byCol.has(cell.col)) byCol.set(cell.col, []);
      byCol.get(cell.col)!.push(cell.rel);
    }
    const cols = [...byCol.keys()].sort((a, b) => a - b);
    for (let i = 0; i + 2 < cols.length; i++) {
      const trio = [cols[i], cols[i + 1], cols[i + 2]];
      if (trio[1] !== trio[0] + 1 || trio[2] !== trio[0] + 2) continue;
      const lists = trio.map((c) => lump.cells.filter((x) => x.col === c).sort((a, b) => a.rel - b.rel));
      const maxRel = Math.min(...lists.map((l) => l[l.length - 1].rel));
      for (let rel = maxRel; rel >= 0; rel--) {
        const kinds = new Set<Kind>();
        for (const list of lists) for (const cell of list) if (cell.meteor.kind !== Kind.Dust) kinds.add(cell.meteor.kind);
        for (const kind of kinds) {
          const swaps: LumpSwap[] = [];
          let ok = true;
          for (const list of lists) {
            const to = list.findIndex((c) => c.rel === rel);
            if (to < 0) {
              ok = false;
              break;
            }
            if (list[to].meteor.kind === kind) continue;
            const from = list.findIndex((c) => c.meteor.kind === kind && c.rel !== rel);
            if (from < 0) {
              ok = false;
              break;
            }
            swaps.push({ lumpId: lump.id, col: list[0].col, from, to });
          }
          if (ok && swaps.length > 0) return swaps;
        }
      }
    }
  }
  return null;
}

/** 空中のカタマリの中の入れ替えを、そのまま盤面に当てる */
function applySwap(game: Game, swap: LumpSwap): void {
  const lump = game.lumps.find((l) => l.id === swap.lumpId);
  if (!lump) return;
  const list = lump.cells.filter((c) => c.col === swap.col).sort((a, b) => a.rel - b.rel);
  const a = list[swap.from];
  const b = list[swap.to];
  if (!a || !b) return;
  const tmp = a.meteor;
  a.meteor = b.meteor;
  b.meteor = tmp;
}

/**
 * ヒントに出す 1 手。地面なら `ground[col]` の、空中ならカタマリ `lumpId` の col 列の、
 * from 番の隕石を to 番まで指で運ぶ（添字は下から数える）
 */
export interface Suggestion {
  kind: 'ground' | 'lump';
  lumpId: number;
  col: number;
  from: number;
  to: number;
  aim: HintAim;
}

/**
 * いまの盤面で「強い」の CPU が打つ最初の 1 手。練習のヒントに出す。
 * 見るのは地面と空中のカタマリだけで、これから降ってくる隕石は見ない（人に見えないものを使わない）
 */
export function suggest(game: Game): Suggestion | null {
  if (game.over) return null;
  const swap = planLump(game)?.[0];
  if (swap) return { kind: 'lump', ...swap, aim: { kind: 'chain' } };
  const plan = planGuarded(game);
  const move = plan?.moves[0];
  return plan && move ? { kind: 'ground', lumpId: 0, ...move, aim: plan.aim } : null;
}

/**
 * 1 手ぶんだけ盤面を動かす。人が指でなぞるのと同じ道を通す。
 * 直接 splice すると、なぞる途中で揃ってそこで止まる挙動が測れない。
 * 掴む位置に空中のカタマリがあると grab がそちらを取るので、その手は捨てる
 */
function applyMove(game: Game, move: Move): void {
  const stack = game.ground[move.col];
  if (move.from >= stack.length || move.to >= stack.length) return;
  if (!game.grab(move.col, move.from)) return;
  if (game.drag?.kind !== 'ground') {
    game.release();
    return;
  }
  game.dragBy(move.to - move.from);
  game.release();
}

/** 1 つの盤面を遊ぶ CPU。`game.tick()` の前に `think()` を呼ぶ */
export class Cpu {
  private queue: Move[] = [];
  private cooldown = 0;

  constructor(
    readonly game: Game,
    readonly style: CpuStyle,
  ) {}

  /** 頃合いなら 1 手だけ動かす。間隔が空いていなければ何もしない */
  think(): void {
    if (this.game.over) return;
    if (this.cooldown > 0) {
      this.cooldown--;
      return;
    }
    this.cooldown = this.style.moveFrames;

    // 空中に塊があれば、まずその中でそろえ直す（第二次点火のほうが強い）
    const swaps = this.style.chains ? planLump(this.game) : null;
    if (swaps) {
      for (const swap of swaps) applySwap(this.game, swap);
      return;
    }
    if (this.style.guard) {
      // 盤面は 1 手ごとに変わる（降ってくる・着地する）ので、毎回考え直して最初の 1 手だけ打つ
      const move = planGuarded(this.game)?.moves[0];
      if (move) applyMove(this.game, move);
      return;
    }
    if (this.queue.length === 0) this.queue = planHigh(this.game) ?? [];
    const move = this.queue.shift();
    if (move) applyMove(this.game, move);
  }
}
