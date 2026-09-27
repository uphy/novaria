/**
 * 練習のヒント。CPU の思考から「揃うまでの手順」と「揃ったときの形」を受け取り、
 * いま打つべき 1 手を、どの隕石をどこまで運ぶかの形で出す。
 *
 * 盤面は降ってくるたびに変わるので、そのたびに最善手を選び直すと、
 * 人が矢印に気づいて指を置くころに手本が替わってしまう。
 * そこで手本は手順ごと覚えておき、残りの手順を列の写しの上で動かしてまだ揃うあいだは替えない。
 * 替えるのは、揃わなくなったとき、揃い終えたとき、守りの要る列が出てきたときだけ。
 *
 * 守りの要否は段数ではなく時間で決める。
 * 列が埋まるまでの時間をいまのレベルの降り方から逆算し、人が崩すのにかかる時間を引いた余裕で見る
 */
import { VISIBLE_ROWS } from './constants';
import { groundPlans, planLump, type HintAim, type Move, type Plan } from './cpu';
import type { Game } from './game';
import { Kind, type Meteor } from './types';

/**
 * 人に合わせた見積もりの数値。`pnpm sim hint` が値を振って測るので、書き換えられる形で置く
 */
export const HINT_TUNING = {
  /** 盤面を見て手本に気づくまで（フレーム） */
  reactFrames: 60,
  /** 1 手を運ぶのにかかる時間（フレーム）。CPU の 1 手 20 フレームより遅く見積もる */
  moveFrames: 40,
  /** 列が埋まる時間は平均の降り方のこの割合で見積もる。どの列に降るかは運なので短めに取る */
  fillCaution: 0.6,
  /** 余裕（残り時間 − 人が 1 手で崩すのにかかる時間）がこれを切ったら守りの手本にする（フレーム） */
  guardFrames: 900,
  /** 余裕がこれを切ったら急ぎの守りにする（フレーム）。滅亡まで数え始めた列も急ぎ */
  urgentFrames: 120,
  /** 攻めの手本を選ぶとき、2 手目から 1 手ごとに値打ちから引くぶん。仕込みより、すぐ揃う手を先に出す */
  moveCost: 2,
};
/** 手本がまだ使えるかを確かめる間隔（フレーム） */
const RETHINK_FRAMES = 6;

/** 手本の段階。攻め（得点を稼ぐ）・守り・急ぎの守り */
export type HintTier = 'attack' | 'guard' | 'urgent';
/** 手の狙い。CPU の思考が出す狙いに、守りでだけ使う「一番上を上へ払う」を足したもの */
export type HintMove = HintAim | { kind: 'shoot' };

/** 手本の矢印。col 列の from（運ぶ隕石の今の row）から to（運び先の row）へ。row は世界座標 */
export interface HintArrow {
  col: number;
  from: number;
  to: number;
  aim: HintMove;
  tier: HintTier;
  /** 守りなら、守る列が滅亡するまでの見積もり（秒）。攻めなら null */
  seconds: number | null;
}

/** 列の中の 1 マス。row はその隕石の世界座標 */
interface Slot {
  meteor: Meteor;
  row: number;
}

interface Step {
  col: number;
  meteorId: number;
  /** 運び先の添字。それより前の手を打ち終えた列で数える */
  to: number;
}

interface Held {
  where: 'ground' | 'lump';
  lumpId: number;
  steps: Step[];
  /** 運び終えたとき matchKind が並ぶマス */
  pattern: { col: number; index: number }[];
  matchKind: Kind;
  aim: HintMove;
  /** 守りの手本なら守る列。攻めなら null */
  guard: number | null;
  /** 一番上を払う手本なら、払う隕石の id */
  shoot: number | null;
}

/**
 * 列 c が滅亡するまでの見積もり（フレーム）。
 * 滅亡まで数え始めていればその残り。まだなら、あと何個で大気圏に届くかに 1 個あたりの降る間隔を掛け、猶予を足す。
 * 落ちてくる途中の隕石は画面に見えているので数えに入れる（人に見えないものは使わない）
 */
export function columnLeft(game: Game, c: number): number {
  const timer = game.breakTimers[c];
  if (timer !== null) return timer;
  const falling = game.fallings.filter((f) => f.col === c && !f.shot).length;
  const rows = Math.max(0, VISIBLE_ROWS - game.ground[c].length - falling);
  return rows * game.columnFillFrames * HINT_TUNING.fillCaution + game.breakFrames;
}

/** 列 c の段階。余裕は、残り時間から人が 1 手で崩すのにかかる時間を引いたもの */
export function columnTier(game: Game, c: number): HintTier {
  if (game.breakTimers[c] !== null) return 'urgent';
  const margin = columnLeft(game, c) - HINT_TUNING.reactFrames - HINT_TUNING.moveFrames;
  if (margin < HINT_TUNING.urgentFrames) return 'urgent';
  if (margin < HINT_TUNING.guardFrames) return 'guard';
  return 'attack';
}

/** いちばん危ない列。守りの要る列が無ければ null */
function pressing(game: Game): { col: number; tier: HintTier; left: number } | null {
  let worst: { col: number; tier: HintTier; left: number } | null = null;
  for (let c = 0; c < game.cols; c++) {
    const tier = columnTier(game, c);
    if (tier === 'attack') continue;
    const left = columnLeft(game, c);
    if (worst === null || left < worst.left) worst = { col: c, tier, left };
  }
  return worst;
}

export class Hinter {
  private held: Held | null = null;
  private wait = 0;
  private game: Game | null = null;

  /** 1 tick ごとに呼ぶ。指で動かしているあいだは手本を替えない */
  update(game: Game): void {
    if (game !== this.game) {
      // 惑星めぐりで盤面が替わった。隕石の id は盤面ごとに振り直すので、前の手本は使えない
      this.game = game;
      this.held = null;
      this.wait = 0;
    }
    if (game.drag) return;
    if (--this.wait > 0) return;
    this.wait = RETHINK_FRAMES;

    const held = this.held;
    const valid = held !== null && current(game, held) !== null;
    const danger = pressing(game);
    // 守りの要る列が出てきたら、揃う途中の攻めの手本でも替える。
    // 守っている列より急ぐ列が出てきたときも替える
    const outranked =
      danger !== null &&
      held !== null &&
      (held.guard === null ||
        (held.guard !== danger.col && danger.tier === 'urgent' && columnTier(game, held.guard) !== 'urgent'));
    if (valid && !outranked) return;

    const next = think(game, danger);
    // 守りの手が見つからず攻めに戻るだけなら、使える攻めの手本はそのまま出し続ける
    if (valid && held.guard === null && next?.guard === null) return;
    this.held = next;
  }

  /** いま出す矢印。手本が無いか、揃え終えていれば null */
  arrow(game: Game): HintArrow | null {
    const h = this.held;
    if (!h || game !== this.game) return null;
    const step = current(game, h);
    if (!step) return null;
    const guard = h.guard;
    return {
      ...step,
      aim: h.aim,
      tier: guard === null ? 'attack' : columnTier(game, guard) === 'urgent' ? 'urgent' : 'guard',
      seconds: guard === null ? null : Math.max(1, Math.ceil(columnLeft(game, guard) / 60)),
    };
  }
}

/** 手本を選ぶ。守りの要る列があれば、先にその列を崩す手か払う手を探す */
function think(game: Game, danger: { col: number; left: number } | null): Held | null {
  if (danger) {
    const guard = guardPlan(game, danger.col, danger.left);
    if (guard) return guard;
  }
  const lump = planLump(game);
  if (lump) {
    return {
      where: 'lump',
      lumpId: lump.lumpId,
      steps: resolve(game, 'lump', lump.lumpId, lump.swaps),
      pattern: lump.pattern,
      matchKind: lump.matchKind,
      aim: { kind: 'chain' },
      guard: null,
      shoot: null,
    };
  }
  // CPU の値打ちは手数 1 つにつき 0.6 を引くだけで、速い手を前提にしている。人には手数がもっと重いので、さらに引く
  let best: { plan: Plan; score: number } | null = null;
  for (const plan of groundPlans(game, true)) {
    const score = plan.value - (plan.moves.length - 1) * HINT_TUNING.moveCost;
    if (best === null || score > best.score) best = { plan, score };
  }
  return best ? fromGround(game, best.plan, null) : null;
}

/**
 * col 列を崩す手本。人の手で間に合う手数の案のうち、その列から多く持ち上げるものを選ぶ。
 * 崩す手が無ければ、一番上を上へ払って時間を稼ぐ
 */
function guardPlan(game: Game, col: number, left: number): Held | null {
  let best: { plan: Plan; score: number } | null = null;
  for (const plan of groundPlans(game, true)) {
    const lifted = plan.lifted.get(col) ?? 0;
    if (lifted === 0) continue;
    if (HINT_TUNING.reactFrames + plan.moves.length * HINT_TUNING.moveFrames > left) continue;
    // 大気圏を抜けるぶんは戻ってこないので重く数える。手数は人には重いので、1 個多く打ち上げるより 1 手少ないほうを選ぶ
    const score = (plan.out.get(col) ?? 0) * 2 + lifted - plan.moves.length * 4 + plan.value * 0.1;
    if (best === null || score > best.score) best = { plan, score };
  }
  if (best) return fromGround(game, best.plan, col);
  const top = game.ground[col].at(-1);
  if (!top) return null;
  return {
    where: 'ground',
    lumpId: 0,
    steps: [],
    pattern: [],
    matchKind: Kind.Dust,
    aim: { kind: 'shoot' },
    guard: col,
    shoot: top.id,
  };
}

function fromGround(game: Game, plan: Plan, guard: number | null): Held {
  return {
    where: 'ground',
    lumpId: 0,
    steps: resolve(game, 'ground', 0, plan.moves),
    pattern: plan.pattern,
    matchKind: plan.matchKind,
    aim: plan.aim,
    guard,
    shoot: null,
  };
}

/** 添字で書いた手順を、運ぶ隕石の id で書き直す。前の手を打ったあとの列を写しの上で追う */
function resolve(game: Game, where: 'ground' | 'lump', lumpId: number, moves: Move[]): Step[] {
  const lists = new Map<number, Slot[]>();
  const steps: Step[] = [];
  for (const m of moves) {
    if (!lists.has(m.col)) lists.set(m.col, [...(column(game, where, lumpId, m.col) ?? [])]);
    const list = lists.get(m.col)!;
    const slot = list[m.from];
    if (!slot) return [];
    steps.push({ col: m.col, meteorId: slot.meteor.id, to: m.to });
    list.splice(m.to, 0, ...list.splice(m.from, 1));
  }
  return steps;
}

/**
 * いま打つ手。残りの手順を列の写しの上で打ってみて、揃う形にならなければ null（手本は古い）。
 * 揃え終えていても null
 */
function current(game: Game, h: Held): { col: number; from: number; to: number } | null {
  if (h.shoot !== null && h.guard !== null) {
    const stack = game.ground[h.guard];
    const top = stack.length - 1;
    if (top < 0 || stack[top].id !== h.shoot) return null;
    // 運び先は無い。一番上から上へ払う向きだけを出す
    return { col: h.guard, from: top, to: top + 1.5 };
  }
  const actual = new Map<number, Slot[]>();
  const lists = new Map<number, Slot[]>();
  const listOf = (col: number): Slot[] | null => {
    if (!lists.has(col)) {
      const list = column(game, h.where, h.lumpId, col);
      if (!list) return null;
      actual.set(col, list);
      lists.set(col, [...list]);
    }
    return lists.get(col)!;
  };
  let next: { col: number; from: number; to: number } | null = null;
  for (const step of h.steps) {
    const list = listOf(step.col);
    if (!list) return null;
    const i = list.findIndex((s) => s.meteor.id === step.meteorId);
    if (i < 0 || step.to >= list.length) return null;
    if (i === step.to) continue;
    // ここより前の手はどれも打ち終えているので、写しの添字と盤面の添字は同じ
    if (next === null) {
      const real = actual.get(step.col)!;
      next = { col: step.col, from: real[i].row, to: real[step.to].row };
    }
    list.splice(step.to, 0, ...list.splice(i, 1));
  }
  if (next === null) return null;
  for (const p of h.pattern) {
    if (listOf(p.col)?.[p.index]?.meteor.kind !== h.matchKind) return null;
  }
  return next;
}

/** 手本の列を下から並べる。カタマリが消えていれば null */
function column(game: Game, where: 'ground' | 'lump', lumpId: number, col: number): Slot[] | null {
  if (where === 'ground') return game.ground[col]?.map((meteor, row) => ({ meteor, row })) ?? null;
  const lump = game.lumps.find((l) => l.id === lumpId);
  if (!lump) return null;
  const cells = lump.cells.filter((c) => c.col === col).sort((a, b) => a.rel - b.rel);
  return cells.length > 0 ? cells.map((c) => ({ meteor: c.meteor, row: lump.y + c.rel })) : null;
}
