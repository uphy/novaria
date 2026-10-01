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
 * 列が埋まるまでの時間をいまのレベルの降り方から逆算し、その列を崩す一番早い手に人がかかる時間と比べる
 */
import { VISIBLE_ROWS } from './constants';
import { groundPlans, planLump, type HintAim, type Move, type Plan } from './cpu';
import { forecastDock } from './dock';
import type { Game } from './game';
import { Kind, isRareMetal, type Meteor } from './types';

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
  /**
   * 列の残り時間が「その列を崩す一番早い手にかかる時間」にこれを足したものを切ったら守りの手本にする（フレーム）。
   * 固定の秒数で決めると、レベルが上がって 1 段が速く積もるころには低い列まで守りになった
   */
  guardSpare: 240,
  /** 残り時間が「崩す一番早い手にかかる時間」にこれを足したものを切ったら急ぎの守りにする（フレーム） */
  urgentSpare: 60,
  /** 崩す手が見つからない列は、揃える形を作るのにこれだけ手がかかると見積もる */
  unknownMoves: 3,
  /** 攻めの手本を選ぶとき、2 手目から 1 手ごとに値打ちから引くぶん。仕込みより、すぐ揃う手を先に出す */
  moveCost: 2,
  /** 連鎖をつなぐ方針を使うか。`pnpm sim hint` が方針なしと比べるために切る */
  chainPolicy: true,
  /** 空中にカタマリがあって連鎖が切れないあいだ、次の点火に使えると見積もる時間（フレーム） */
  airWindow: 180,
  /** ドッキングを狙う方針を使うか。`pnpm sim hint` が方針なしと比べるために切る */
  dockPolicy: true,
  /** ドッキングの手本は、人が打つのがこれだけ遅れても当たるものに限る（フレーム） */
  dockSlack: 20,
  /** レアメタルを打ち上げる方針を使うか。`pnpm sim hint` が方針なしと比べるために切る */
  rarePolicy: true,
};
/** 手本がまだ使えるかを確かめる間隔（フレーム） */
const RETHINK_FRAMES = 6;
/** 守っている列よりこれだけ早く滅亡しそうな列が出たら、そちらへ乗り換える（フレーム） */
const SWITCH_FRAMES = 60;

/** 手本の段階。攻め（得点を稼ぐ）・守り・急ぎの守り */
export type HintTier = 'attack' | 'guard' | 'urgent';
/**
 * 手本の方針。どの方針で手を選んだかをそのまま出す（手を選んだあとに説明を貼るのではない）。
 * - guard … 守る。滅亡しそうな列を崩す
 * - air … 空中で組み替える。浮いているカタマリの中で揃え直して、もう一段上げる
 * - dock … ドッキングを狙う。浮いているカタマリに、地面で点火したカタマリを下から当てて一緒に押し上げる
 * - chain … 連鎖をつなぐ。切れる前に次の点火を打つ。得点は「マス数 × 連鎖倍率」なので得点のほとんどがここで決まる
 * - rare … レアメタルを打ち上げる。レアメタルごと宇宙へ出せる点火を打つ（1 個 10,000 点）
 * - build … 大きく揃える。連鎖が切れていて余裕があるときに、大きく上がる形を作る
 */
export type HintPolicy = 'guard' | 'air' | 'dock' | 'chain' | 'rare' | 'build';
/** 手の狙い。CPU の思考が出す狙いに、急ぎの守りでだけ使う「一番上を上へ払う」を足したもの */
export type HintMove = HintAim | { kind: 'shoot' };

/** 手本の矢印。col 列の from（運ぶ隕石の今の row）から to（運び先の row）へ。row は世界座標 */
export interface HintArrow {
  col: number;
  from: number;
  to: number;
  aim: HintMove;
  tier: HintTier;
  policy: HintPolicy;
  /** 守りなら、守る列が滅亡するまでの見積もり（秒）。攻めなら null */
  seconds: number | null;
  /** いまの連鎖の数（0 なら切れている） */
  combo: number;
  /** 連鎖が切れるまでの残り（秒）。切れていれば 0、空中にカタマリがあって減っていなければ null */
  comboLeft: number | null;
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
  policy: HintPolicy;
  /** ドッキングを狙う手本なら、その案。打つまでに当たらなくなっていないかを確かめ直すのに使う */
  dock: Plan | null;
}

/** 列の危なさ。left は滅亡までの見積もり、need はその列を崩す一番早い手にかかる時間（どちらもフレーム） */
interface Pressure {
  col: number;
  tier: HintTier;
  left: number;
  need: number;
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

/**
 * ゲームの速さ（1 が通常）。ヒントを使うときだけ遅くできる。
 * 人の手の速さ（`HINT_TUNING` の気づくまで・1 手・余裕）は実時間なので、ゲームのフレーム数に直すときにこれを掛ける。
 * 半分の速さなら、人が 1 秒かかるあいだにゲームは 30 フレームしか進まない
 */
let pace = 1;

/** 実時間のフレーム数を、いまの速さのゲームのフレーム数に直す */
function human(frames: number): number {
  return frames * pace;
}

/** 手を打ち切るまでに人がかかる時間（ゲームのフレーム） */
function handFrames(moves: number): number {
  return human(HINT_TUNING.reactFrames + moves * HINT_TUNING.moveFrames);
}

/**
 * 列ごとの危なさ。段数ではなく時間で見る。
 * 残り時間が、その列を崩す一番早い手にかかる時間に少し足したものを切ったら守り、ほとんど足りなければ急ぎ
 */
function assess(game: Game, plans: Plan[]): Pressure[] {
  const fastest = new Map<number, number>();
  for (const plan of plans) {
    for (const [c, lifted] of plan.lifted) {
      if (lifted === 0) continue;
      fastest.set(c, Math.min(fastest.get(c) ?? Infinity, plan.moves.length));
    }
  }
  const result: Pressure[] = [];
  for (let c = 0; c < game.cols; c++) {
    const left = columnLeft(game, c);
    const need = handFrames(fastest.get(c) ?? HINT_TUNING.unknownMoves);
    const tier: HintTier =
      game.breakTimers[c] !== null || left < need + human(HINT_TUNING.urgentSpare)
        ? 'urgent'
        : left < need + human(HINT_TUNING.guardSpare)
          ? 'guard'
          : 'attack';
    result.push({ col: c, tier, left, need });
  }
  return result;
}

/** いちばん早く滅亡しそうな、守りの要る列。無ければ null */
function pressing(pressures: Pressure[]): Pressure | null {
  let worst: Pressure | null = null;
  for (const p of pressures) {
    if (p.tier === 'attack') continue;
    if (worst === null || p.left < worst.left) worst = p;
  }
  return worst;
}

export class Hinter {
  private held: Held | null = null;
  private wait = 0;
  private game: Game | null = null;
  /** 最後に考えたときの列ごとの危なさ。矢印の色を毎フレーム決めるのに使う */
  private pressures: Pressure[] = [];
  /** 最後に渡されたゲームの速さ。矢印に出す秒数を実時間に直すのに使う */
  private speed = 1;

  /**
   * 1 tick ごとに呼ぶ。指で動かしているあいだは手本を替えない。
   * speed はゲームの速さ（1 が通常）。遅くしているほど、人は同じ実時間でゲームの先まで手を打てる
   */
  update(game: Game, speed = 1): void {
    pace = speed;
    this.speed = speed;
    if (game !== this.game) {
      // 惑星めぐりで盤面が替わった。隕石の id は盤面ごとに振り直すので、前の手本は使えない
      this.game = game;
      this.held = null;
      this.wait = 0;
      this.pressures = [];
    }
    if (game.drag) return;
    if (--this.wait > 0) return;
    this.wait = RETHINK_FRAMES;

    const plans = groundPlans(game, true);
    this.pressures = assess(game, plans);
    const held = this.held;
    const now = held !== null ? current(game, held) : null;
    // ドッキングの手本は、残りの手を打つまでに相手が着地したり通り過ぎたりしたら使えない
    const valid = now !== null && (held!.dock === null || docks(game, held!.dock, now.left));
    const danger = pressing(this.pressures);
    // 守りの要る列が出てきたら、揃う途中の攻めの手本でも替える。
    // 守っている列より早く滅亡しそうな列が出てきたときも、赤くなるのを待たずに乗り換える
    const outranked =
      (danger !== null &&
        held !== null &&
        (held.guard === null ||
          (held.guard !== danger.col && danger.left < this.pressures[held.guard].left - SWITCH_FRAMES))) ||
      // 大きく揃える手本の途中で連鎖が始まり、残りの手数では切れるまでに間に合わないなら、連鎖をつなぐ手に替える
      (danger === null &&
        held !== null &&
        held.policy === 'build' &&
        game.combo > 0 &&
        HINT_TUNING.chainPolicy &&
        handFrames(current(game, held)?.left ?? 0) > chainBudget(game));
    if (valid && !outranked) return;

    const next = think(game, plans, danger);
    // 守りの手が見つからず同じ方針に戻るだけなら、使える手本はそのまま出し続ける
    if (valid && held !== null && held.guard === null && next?.guard === null && next.policy === held.policy) return;
    this.held = next;
  }

  /** いま出す矢印。手本が無いか、揃え終えていれば null */
  arrow(game: Game): HintArrow | null {
    const h = this.held;
    if (!h || game !== this.game) return null;
    const step = current(game, h);
    if (!step) return null;
    const guard = h.guard;
    const comboLeft = game.comboLeft();
    const base = {
      col: step.col,
      from: step.from,
      to: step.to,
      aim: h.aim,
      policy: h.policy,
      combo: game.combo,
      // 札に出す秒数は実時間。遅くしているぶん長くなる
      comboLeft: comboLeft === null ? null : comboLeft / 60 / this.speed,
    };
    if (guard === null) return { ...base, tier: 'attack', seconds: null };
    const left = columnLeft(game, guard);
    const need = this.pressures[guard]?.need ?? handFrames(1);
    return {
      ...base,
      tier:
        game.breakTimers[guard] !== null || left < need + HINT_TUNING.urgentSpare * this.speed ? 'urgent' : 'guard',
      seconds: Math.max(1, Math.ceil(left / 60 / this.speed)),
    };
  }
}

/**
 * 連鎖が切れるまでに次の点火に使える時間（フレーム）。
 * 空中にカタマリがあるあいだは切れないが、落ちてきて燃えカスが還元されれば切れるので、決まった長さで見積もる
 */
function chainBudget(game: Game): number {
  return game.comboLeft() ?? HINT_TUNING.airWindow;
}

/**
 * plan を残り moves 手で打ち終えたとき、浮いているカタマリに当たるか。
 * 人は見積もりより早く打つことも遅れることもあるので、手早く打った場合・見積もりどおりの場合・少し遅れた場合の
 * どれでも当たるものだけにする
 */
function docks(game: Game, plan: Plan, moves: number): boolean {
  const delay = handFrames(moves);
  const early = Math.max(0, delay - human(HINT_TUNING.moveFrames));
  return [early, delay, delay + human(HINT_TUNING.dockSlack)].every((d) => forecastDock(game, plan, d) !== null);
}

/**
 * ドッキングを狙う手本。浮いているカタマリの下の列で点火する案のうち、人の手で打っても当たるものを選ぶ。
 * 当たる相手が大きいほど、一緒に押し上げて宇宙へ出せる隕石が多い
 */
function dockPlan(game: Game, plans: Plan[]): Held | null {
  if (game.lumps.length === 0) return null;
  const under = new Set(game.lumps.flatMap((l) => l.cells.map((c) => c.col)));
  let best: { plan: Plan; score: number } | null = null;
  for (const plan of plans) {
    if (plan.moves.length > 2 || !plan.pattern.some((c) => under.has(c.col))) continue;
    if (!docks(game, plan, plan.moves.length)) continue;
    const hit = forecastDock(game, plan, handFrames(plan.moves.length))!;
    const score = hit.size * 2 + plan.pattern.length - plan.moves.length * HINT_TUNING.moveCost;
    if (best === null || score > best.score) best = { plan, score };
  }
  if (!best) return null;
  return { ...fromGround(game, best.plan, null, 'dock'), dock: best.plan };
}

/**
 * 手本を選ぶ。方針は上から順に見て、打てる手がある最初の方針にする。
 * 守る → 空中で組み替える → レアメタルを打ち上げる → ドッキングを狙う → 連鎖をつなぐ → 大きく揃える
 */
function think(game: Game, plans: Plan[], danger: Pressure | null): Held | null {
  if (danger) {
    const guard = guardPlan(game, plans, danger);
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
      policy: 'air',
      dock: null,
    };
  }
  // レアメタルは 1 個で 1 試合の得点の 1 割を超えるので、宇宙へ出せる点火があればドッキングより先に打つ
  const launch = HINT_TUNING.rarePolicy ? rareLaunchPlan(game, plans) : null;
  if (launch) return launch;
  if (HINT_TUNING.dockPolicy) {
    const dock = dockPlan(game, plans);
    if (dock) return dock;
  }
  if (game.combo > 0 && HINT_TUNING.chainPolicy) {
    const chain = chainPlan(game, plans);
    if (chain) return chain;
  }
  // CPU の値打ちは手数 1 つにつき 0.6 を引くだけで、速い手を前提にしている。人には手数がもっと重いので、さらに引く
  let best: { plan: Plan; score: number } | null = null;
  for (const plan of plans) {
    const score = plan.value - (plan.moves.length - 1) * HINT_TUNING.moveCost;
    if (best === null || score > best.score) best = { plan, score };
  }
  return best ? fromGround(game, best.plan, null, 'build') : null;
}

/** 地面に居座っているレアメタル。列と、列の中の添字 */
function rareMetals(game: Game): { col: number; index: number; meteor: Meteor }[] {
  const found: { col: number; index: number; meteor: Meteor }[] = [];
  game.ground.forEach((stack, col) =>
    stack.forEach((meteor, index) => {
      if (isRareMetal(meteor.kind)) found.push({ col, index, meteor });
    }),
  );
  return found;
}

/** plan の手を打ち終えたとき、列 col の中で隕石 id がいる添字 */
function indexAfter(game: Game, plan: Plan, col: number, id: number): number {
  const list = game.ground[col].map((m) => m.id);
  for (const m of plan.moves) {
    if (m.col !== col) continue;
    list.splice(m.to, 0, ...list.splice(m.from, 1));
  }
  return list.indexOf(id);
}

/**
 * レアメタルを宇宙へ出す点火の手本。点火すると大気圏を抜ける隕石は列の上から数えるので、
 * 手を打ち終えたあとのレアメタルの段がその中に入っていれば一緒に抜ける。手数の少ないものを選ぶ
 */
function rareLaunchPlan(game: Game, plans: Plan[]): Held | null {
  const rares = rareMetals(game);
  if (rares.length === 0) return null;
  let best: { plan: Plan; score: number } | null = null;
  for (const plan of plans) {
    let launched = 0;
    for (const r of rares) {
      const out = plan.out.get(r.col) ?? 0;
      if (out === 0) continue;
      if (indexAfter(game, plan, r.col, r.meteor.id) >= game.ground[r.col].length - out) launched++;
    }
    if (launched === 0) continue;
    const score = launched * 10 - plan.moves.length * HINT_TUNING.moveCost + plan.value * 0.1;
    if (best === null || score > best.score) best = { plan, score };
  }
  return best ? fromGround(game, best.plan, null, 'rare') : null;
}

/**
 * 連鎖をつなぐ手本。切れるまでに人の手で打ち切れる案のうち、点火するマスが多く、手数の少ないものを選ぶ。
 * 点火の得点は「マス数 × 連鎖倍率」なので、倍率が乗っているうちはマス数がそのまま得点になる
 */
function chainPlan(game: Game, plans: Plan[]): Held | null {
  const budget = chainBudget(game);
  let best: { plan: Plan; score: number } | null = null;
  for (const plan of plans) {
    if (handFrames(plan.moves.length) > budget) continue;
    const cells = plan.aim.kind === 'chain' ? 3 : plan.aim.count;
    const score = cells * 2 - plan.moves.length * HINT_TUNING.moveCost + plan.value * 0.1;
    if (best === null || score > best.score) best = { plan, score };
  }
  return best ? fromGround(game, best.plan, null, 'chain') : null;
}

/**
 * 危ない列を崩す手本。人の手で間に合う手数の案のうち、その列から多く持ち上げるものを選ぶ。
 * 崩す手が無く、急ぎのときだけ一番上を上へ払って時間を稼ぐ。
 * 払っても 1 個ぶんの時間しか稼げないので、まだ間に合うときは出さない
 */
function guardPlan(game: Game, plans: Plan[], danger: Pressure): Held | null {
  const col = danger.col;
  let best: { plan: Plan; score: number } | null = null;
  for (const plan of plans) {
    const lifted = plan.lifted.get(col) ?? 0;
    if (lifted === 0) continue;
    if (handFrames(plan.moves.length) > danger.left) continue;
    // 大気圏を抜けるぶんは戻ってこないので重く数える。手数は人には重いので、1 個多く打ち上げるより 1 手少ないほうを選ぶ
    const score = (plan.out.get(col) ?? 0) * 2 + lifted - plan.moves.length * 4 + plan.value * 0.1;
    if (best === null || score > best.score) best = { plan, score };
  }
  if (best) return fromGround(game, best.plan, col, 'guard');
  if (danger.tier !== 'urgent') return null;
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
    policy: 'guard',
    dock: null,
  };
}

function fromGround(game: Game, plan: Plan, guard: number | null, policy: HintPolicy): Held {
  return {
    where: 'ground',
    lumpId: 0,
    steps: resolve(game, 'ground', 0, plan.moves),
    pattern: plan.pattern,
    matchKind: plan.matchKind,
    aim: plan.aim,
    guard,
    shoot: null,
    policy,
    dock: null,
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
 * いま打つ手と、それを含めた残りの手数。残りの手順を列の写しの上で打ってみて、揃う形にならなければ null（手本は古い）。
 * 揃え終えていても null
 */
function current(game: Game, h: Held): { col: number; from: number; to: number; left: number } | null {
  if (h.shoot !== null && h.guard !== null) {
    const stack = game.ground[h.guard];
    const top = stack.length - 1;
    if (top < 0 || stack[top].id !== h.shoot) return null;
    // 運び先は無い。一番上から上へ払う向きだけを出す
    return { col: h.guard, from: top, to: top + 1.5, left: 1 };
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
  let next: { col: number; from: number; to: number; left: number } | null = null;
  for (const step of h.steps) {
    const list = listOf(step.col);
    if (!list) return null;
    const i = list.findIndex((s) => s.meteor.id === step.meteorId);
    if (i < 0 || step.to >= list.length) return null;
    if (i === step.to) continue;
    // ここより前の手はどれも打ち終えているので、写しの添字と盤面の添字は同じ
    if (next === null) {
      const real = actual.get(step.col)!;
      next = { col: step.col, from: real[i].row, to: real[step.to].row, left: 0 };
    }
    next.left++;
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
