import {
  ATTACK,
  BURN_FRAMES,
  NOVARIA,
  GRID_ROWS,
  IGNITION_GRACE_FRAMES,
  LAUNCH_COMBO_GRACE_FRAMES,
  MAX_IGNITION_RUN,
  MIN_IGNITION_RUN,
  PHYSICS,
  Planet,
  RARE_METAL_INTERVAL_FRAMES,
  SCORE,
  SCREEN_OUT_ROW,
  SHOOT_CHARGE_ROWS,
  VISIBLE_ROWS,
  WARN_ROWS,
  lerpLevel,
  levelCurve,
} from './constants';
import { Rng } from './rng';
import { Falling, Kind, LaunchStat, Lump, LumpCell, Meteor, isRareMetal } from './types';

export interface GameOptions {
  seed?: number;
  planet?: Planet;
  /** レアメタルを出すか。テストでは切る */
  rareMetal?: boolean;
}

/** 掴んでいる隕石。ground は地面の山、lump は空中のカタマリ */
export interface Drag {
  kind: 'ground' | 'lump';
  lumpId: number;
  col: number;
  /** その列の中での添字（下から 0） */
  index: number;
  /** マス目からのずれ（-0.5〜0.5）。描画だけに効く */
  offset: number;
  /** シュートのために上へ押し込んだ量（マス） */
  charge: number;
}

/** 指で 1 マス動かした操作。動かした音を鳴らすのに使う */
export interface DragMove {
  kind: Drag['kind'];
  /** 動かした隕石の動いたあとの添字（下から 0）。音程に使う */
  row: number;
  /** 上へ動かしたか */
  up: boolean;
  /** 動かした指 */
  finger: number;
}

/** 点火が起きたことを描画側へ知らせる */
export interface IgnitionEvent {
  cells: { col: number; row: number }[];
  combo: number;
  vertical: boolean;
  score: number;
}

/** 点火判定のために、地面と空中のカタマリを同じ格子に並べたときの 1 マス */
interface WorldCell {
  col: number;
  row: number;
  meteor: Meteor;
  /** 空中のカタマリのマスならそのカタマリ。地面なら null */
  lump: Lump | null;
}

export interface Events {
  ignitions: IgnitionEvent[];
  /** スクリーンアウトした隕石の列 */
  screenOut: number[];
  /** そのうちレアメタルだった数 */
  screenOutRare: number;
  landed: number;
  /** 着地したうち、空中のカタマリだった数（`landed` にも含む） */
  lumpLanded: number;
  /** 還元されて通常の隕石に戻った燃えカスの数 */
  reverted: number;
  airDock: number;
  /** シュートが降ってくる隕石と相殺した回数 */
  shootCancel: number;
  /** シュートを撃った回数 */
  shot: number;
  /** 指で 1 マス動かした操作。同じフレームに何度も動けば並ぶ */
  moves: DragMove[];
  /** なぞる途中で揃って指から離れた */
  locked: boolean;
  /** レアメタルが降ってきた列。null なら降っていない */
  rareMetal: number | null;
  /** このフレームに相手へ送った攻撃の隕石の個数。対戦していないときは誰も受け取らない */
  attackSent: number;
  /** このフレームに相手から降ってきた攻撃の隕石の個数 */
  attackTaken: number;
  /** 攻撃の隕石が降ってきた列。相手の盤面のどこに刺さったかを描くのに使う */
  attackColumns: number[];
  /** 危ない列がある（滅亡までの数え上げが始まっている） */
  danger: boolean;
  /** 予兆の列がある。まだ数え上げは始まっていない */
  warn: boolean;
  screenClear: boolean;
  gameOver: boolean;
}

export function emptyEvents(): Events {
  return {
    ignitions: [],
    screenOut: [],
    screenOutRare: 0,
    moves: [],
    locked: false,
    lumpLanded: 0,
    reverted: 0,
    landed: 0,
    airDock: 0,
    shootCancel: 0,
    shot: 0,
    rareMetal: null,
    attackSent: 0,
    attackTaken: 0,
    attackColumns: [],
    danger: false,
    warn: false,
    screenClear: false,
    gameOver: false,
  };
}

/**
 * 点火した隕石が燃えている強さ（1 が点火の瞬間、0 が燃え終わり）。見た目だけのもの。
 *
 * 点火したフレームからの経過で出す。燃えカスの還元までの残り（`Meteor.revert`）は
 * 地面に着いているあいだしか減らないので、そちらで測ると空中のカタマリが燃えっぱなしになる
 */
export function burnHeat(m: Meteor, frame: number): number {
  if (m.kind !== Kind.Dust || m.ignitedAt < 0) return 0;
  const since = frame - m.ignitedAt;
  if (since < 0 || since >= BURN_FRAMES) return 0;
  return 1 - since / BURN_FRAMES;
}

export class Game {
  readonly planet: Planet;
  readonly cols: number;
  /** 地面の山。ground[col][row]（下から積む） */
  ground: Meteor[][] = [];
  fallings: Falling[] = [];
  lumps: Lump[] = [];
  /** 列ごとの滅亡までの残りフレーム。null なら安全 */
  breakTimers: (number | null)[] = [];
  /**
   * 列ごとの予兆。あと 1 段で滅亡の判定に届く。
   * 数え上げはまだ始まっていないので、崩せば消える
   */
  warnings: boolean[] = [];
  /**
   * 列ごとの、滅亡しうる塔の高さ。燃えカスを含む列と空中のカタマリが覆う列は 0。
   * 発射台の灯に使う（`WATCH_ROWS` から光る）
   */
  towers: number[] = [];

  frame = 0;
  score = 0;
  launched: LaunchStat = { normal: 0, dust: 0, rare: 0 };
  maxCombo = 0;
  over = false;
  /** 加速を押しているか */
  boost = false;

  /**
   * 指ごとの掴み。両手で別々の列を運べる（原作はタッチペン 1 本なので 1 つだけ）。
   * 1 つの列を 2 本の指で掴むことはできない。入れ替えがぶつかって結果が決まらなくなるため
   */
  drags = new Map<number, Drag>();

  /** 掴みのどれか 1 つ。指を区別しない CPU とテスト向け */
  get drag(): Drag | null {
    for (const d of this.drags.values()) return d;
    return null;
  }

  /**
   * 相手へ送るのを待っている攻撃力。通常の隕石 1 個で 3、燃えカス 1 個で 1 溜まり、
   * 3 で相手に 1 個降る（`ATTACK`）。対戦していないときも溜まるが、受け取る相手がいない
   */
  private attackUnits = 0;
  /** 最後に打ち上げたフレーム。ここから間が空くと溜まったぶんを送る */
  private lastLaunchFrame = -ATTACK.sendDelayFrames;

  private rng: Rng;
  private nextId = 1;
  private nextLumpId = 1;
  private spawnTimer = 0;
  private rareTimer = RARE_METAL_INTERVAL_FRAMES;
  private rareEnabled: boolean;
  /** 揃いができてから点火するまでの猶予 */
  private groundGrace = IGNITION_GRACE_FRAMES;
  /**
   * 連続点火の回数。燃えカスが盤面から無くなるとリセットされる（原作どおり）。
   * 着地してから揃え直すディレイドステップジャンプでも続く。
   */
  private chainCombo = 0;
  /**
   * 打ち上げたあと、連鎖をつないでおく残りフレーム。
   * 長さは `LAUNCH_COMBO_GRACE_FRAMES`（docs/decisions.md「打ち上げても連鎖は切らない」）
   */
  private comboGrace = 0;
  /** 全消しの得点を、空になっているあいだ何度も入れないための印 */
  private screenCleared = false;
  private events: Events = emptyEvents();
  /** 先読みの写しか。写しでは新しく降らせない（`fork`） */
  private forked = false;

  constructor(opts: GameOptions = {}) {
    this.planet = opts.planet ?? NOVARIA;
    this.cols = this.planet.cols;
    this.rng = new Rng(opts.seed ?? 1);
    this.rareEnabled = opts.rareMetal ?? true;
    for (let c = 0; c < this.cols; c++) {
      this.ground.push([]);
      this.breakTimers.push(null);
      this.warnings.push(false);
      this.towers.push(0);
    }
    this.setupInitialField();
  }

  // ---------------------------------------------------------------- レベル

  /** 0（開始）〜1（最大）。時間経過で上がり、下がらない */
  get level(): number {
    return levelCurve(this.frame / this.planet.rampFrames);
  }

  private get fallSpeed(): number {
    const base = lerpLevel(this.planet.fallStart, this.planet.fallMax, this.level);
    return this.boost ? base * this.planet.boostRate : base;
  }

  private get spawnInterval(): number {
    const base = lerpLevel(this.planet.spawnStart, this.planet.spawnMax, this.level);
    return this.boost ? base / this.planet.boostRate : base;
  }

  /**
   * 1 つの列に隕石が 1 個降るまでの平均のフレーム数（加速していないとき）。
   * 降る列は一様に選ぶので、降る間隔に列の数を掛けたものになる。ヒントが列の残り時間を見積もるのに使う
   */
  get columnFillFrames(): number {
    return lerpLevel(this.planet.spawnStart, this.planet.spawnMax, this.level) * this.cols;
  }

  /** 燃えカスが還元されるまでのフレーム数。描画が「点火してから何フレーム経ったか」を出すのにも使う */
  get revertDustFrames(): number {
    return Math.round(lerpLevel(this.planet.revertDustStart, this.planet.revertDustMax, this.level));
  }

  /** 相手から降ってきた攻撃の隕石が還元されるまでのフレーム数 */
  /**
   * 惑星ごとに差し替える物理。惑星が値を持っていなければ `PHYSICS` の共通値を使う。
   * 上がり方と落ち方が惑星の性格そのものなので、ここだけ惑星から引く
   */
  private get gravity(): number {
    return this.planet.gravity ?? PHYSICS.gravity;
  }

  private get lumpFallGravity(): number {
    return this.planet.lumpFallGravity ?? PHYSICS.lumpFallGravity;
  }

  private get maxLumpFallSpeed(): number {
    return this.planet.maxLumpFallSpeed ?? PHYSICS.maxLumpFallSpeed;
  }

  private get revertAtkFrames(): number {
    return Math.round(lerpLevel(this.planet.revertAtkStart, this.planet.revertAtkMax, this.level));
  }

  /** 相手へ送るのを待っている攻撃の隕石の個数。対戦の表示に使う */
  get pendingAttack(): number {
    return Math.floor(this.attackUnits / ATTACK.unitsPerMeteor);
  }

  /**
   * いま続いている連鎖の回数。0 なら切れていて、次の点火は 1 から数え直す。
   * 得点の 8 割はこの倍率で決まるので、画面に出す（docs/decisions.md「連鎖を見せる」）
   */
  get combo(): number {
    return this.chainCombo;
  }

  /**
   * 連鎖が切れるまでの残りフレーム。
   * 空中にカタマリがあるあいだは切れないので null（まだ減り始めていない）。
   * 燃えカスが 1 つも無ければ 0
   */
  comboLeft(): number | null {
    if (this.chainCombo === 0) return 0;
    if (this.lumps.length > 0) return null;
    let left = this.comboGrace;
    for (const col of this.ground) {
      for (const m of col) if (m.kind === Kind.Dust) left = Math.max(left, m.revert);
    }
    return left;
  }

  /**
   * 連鎖が切れるまでの残り（0〜1）。帯に描くのに使う。
   * 空中にカタマリがあるあいだは切れないので 1。
   * 満ちた状態の長さは、還元を待っているのか打ち上げの猶予なのかで変わる
   */
  comboRatio(): number {
    if (this.chainCombo === 0) return 0;
    if (this.lumps.length > 0) return 1;
    let left = 0;
    let full = this.revertDustFrames;
    for (const col of this.ground) {
      for (const m of col) if (m.kind === Kind.Dust) left = Math.max(left, m.revert);
    }
    if (this.comboGrace > left) {
      left = this.comboGrace;
      full = LAUNCH_COMBO_GRACE_FRAMES;
    }
    return Math.max(0, Math.min(1, left / full));
  }

  /** いまのレベルでの猶予の全長（フレーム）。残りを割って帯に描くのに使う */
  get breakFrames(): number {
    return Math.round(lerpLevel(this.planet.graceStart, this.planet.graceMax, this.level));
  }

  // ---------------------------------------------------------------- 初期化

  /**
   * 開幕に 3 段分を置く。原作は開始直後に点火が起きないよう
   * 「開始時点火防止用隕石」を混ぜるが、生成の手順は不明なので
   * ここでは揃いが出ない種類を選び直して積む。
   */
  private setupInitialField(): void {
    for (let row = 0; row < 3; row++) {
      for (let c = 0; c < this.cols; c++) {
        let kind = this.rollKind();
        for (let tries = 0; tries < 20 && this.wouldMatchAt(c, row, kind); tries++) {
          kind = this.rollKind();
        }
        this.ground[c].push(this.makeMeteor(kind));
      }
    }
  }

  /** その位置に置くと 3 つ以上並ぶか */
  private wouldMatchAt(col: number, row: number, kind: Kind): boolean {
    const at = (c: number, r: number): Kind | null => {
      if (c < 0 || c >= this.cols) return null;
      const m = this.ground[c][r];
      return m ? m.kind : null;
    };
    let run = 1;
    for (let c = col - 1; at(c, row) === kind; c--) run++;
    for (let c = col + 1; at(c, row) === kind; c++) run++;
    if (run >= MIN_IGNITION_RUN) return true;
    run = 1;
    for (let r = row - 1; at(col, r) === kind; r--) run++;
    return run >= MIN_IGNITION_RUN;
  }

  private makeMeteor(kind: Kind): Meteor {
    return { id: this.nextId++, kind, revert: 0, fromAttack: false, ignitedAt: -1 };
  }

  private rollKind(): Kind {
    const rates = this.planet.rates;
    const idx = this.rng.weighted(rates.map((r) => r[1]));
    return rates[idx][0];
  }

  /**
   * 先読みのための写し。ヒントが「この手を打ったら何フレーム後にどうなるか」を試すのに使う。
   * 人に見えないものは使わないので、写しではまだ降っていない隕石を降らせない。
   * 燃えカスが何に戻るかも乱数で決まるので、乱数は本物と別の列にする（本物の先を覗かない）
   */
  fork(): Game {
    const g = Object.create(Game.prototype) as Game;
    Object.assign(g, this);
    // 隕石はどれも 1 か所にしかいないので、まとめて写せば掴んでいる隕石とカタマリの隕石も食い違わない
    const data = structuredClone({
      ground: this.ground,
      fallings: this.fallings,
      lumps: this.lumps,
      drags: this.drags,
      breakTimers: this.breakTimers,
      warnings: this.warnings,
      towers: this.towers,
      launched: this.launched,
    });
    Object.assign(g, data);
    g.rng = new Rng(0x5eed ^ this.frame);
    g.events = emptyEvents();
    g.forked = true;
    return g;
  }

  // ---------------------------------------------------------------- 入力

  /**
   * 指が触れたマスの隕石を掴む。掴めなければ false。
   * row は世界座標（下が 0）。`finger` は指の番号で、同じ指がすでに掴んでいれば持ち替える。
   * 別の指が掴んでいる列は掴めない
   */
  grab(col: number, row: number, finger = 0): boolean {
    if (this.over) return false;
    this.drags.delete(finger);
    if (col < 0 || col >= this.cols) return false;
    for (const d of this.drags.values()) if (d.col === col) return false;
    const r = Math.floor(row);
    // 空中のカタマリを優先する（手前に見えているものを掴める）
    for (const lump of this.lumps) {
      const list = this.columnOfLump(lump, col);
      if (list.length === 0) continue;
      // カタマリは小数の高さを漂うので、浮いている量を引いてから切り捨てる。
      // 先に lump.y + rel を切り捨てて指の行と比べると、端数が 0.5 を越えたところで
      // 1 マス上の隕石を掴んでしまい、一番上では掴めずに指が空振りする
      const rel = Math.floor(row - lump.y);
      const i = list.findIndex((c) => c.rel === rel);
      if (i >= 0) {
        this.drags.set(finger, { kind: 'lump', lumpId: lump.id, col, index: i, offset: 0, charge: 0 });
        return true;
      }
    }
    if (r >= 0 && r < this.ground[col].length) {
      this.drags.set(finger, { kind: 'ground', lumpId: 0, col, index: r, offset: 0, charge: 0 });
      return true;
    }
    return false;
  }

  /** 指の移動量（マス単位、上が正）を渡す。掴んだ隕石が列の中を上下する */
  dragBy(deltaRows: number, finger = 0): void {
    const d = this.drags.get(finger);
    if (!d || this.over) return;
    const list = this.dragList(d);
    if (!list) {
      this.drags.delete(finger);
      return;
    }
    d.offset += deltaRows;
    while (d.offset >= 0.5 && d.index + 1 < list.length) {
      const from = d.index;
      this.swapInList(d, list, d.index, d.index + 1);
      d.index++;
      d.offset -= 1;
      this.events.moves.push({ kind: d.kind, row: d.index, up: true, finger });
      if (this.lockIfMatched(finger, d, from)) return;
    }
    while (d.offset <= -0.5 && d.index - 1 >= 0) {
      const from = d.index;
      this.swapInList(d, list, d.index, d.index - 1);
      d.index--;
      d.offset += 1;
      this.events.moves.push({ kind: d.kind, row: d.index, up: false, finger });
      if (this.lockIfMatched(finger, d, from)) return;
    }
    // 列の一番上をさらに上へ払うとシュート（原作どおり）
    if (d.index === list.length - 1) {
      if (d.offset > 0.5) {
        d.charge += d.offset - 0.5;
        d.offset = 0.5;
        if (d.kind === 'ground' && d.charge >= SHOOT_CHARGE_ROWS) this.shoot(finger, d.col);
      }
    }
    if (d.index === 0) d.offset = Math.max(d.offset, -0.5);
  }

  /** 指を離す。`finger` を省くとすべての指を離す */
  release(finger?: number): void {
    if (finger === undefined) this.drags.clear();
    else this.drags.delete(finger);
  }

  /** 条件に当たる掴みを外す。盤面が変わって、掴んでいた添字が別の隕石を指しうるときに使う */
  private dropDrags(hit: (d: Drag, finger: number) => boolean): void {
    for (const [finger, d] of [...this.drags]) if (hit(d, finger)) this.drags.delete(finger);
  }

  /**
   * カタマリの着地・合体・点火で盤面の形が変わったあと、掴みを隕石の今いる場所へ付け直す。
   * 掴みは添字で覚えているので、形が変わると別の隕石を指すか、列ごと無くなる。
   * `held` は形が変わる前の `heldMeteors()`。隕石が盤面から消えていたら離す。
   * 付け直さずに外していたころは、運んでいるカタマリが着地した瞬間に指から離れていた
   */
  private rebindDrags(held: Map<Meteor, number>): void {
    for (const [meteor, finger] of held) {
      const d = this.drags.get(finger);
      if (!d) continue;
      const index = this.ground[d.col].indexOf(meteor);
      if (index >= 0) {
        if (d.kind !== 'ground') d.charge = 0;
        Object.assign(d, { kind: 'ground', lumpId: 0, index });
        continue;
      }
      const lump = this.lumps.find((l) => l.cells.some((c) => c.meteor === meteor));
      if (lump) {
        const i = this.columnOfLump(lump, d.col).findIndex((c) => c.meteor === meteor);
        Object.assign(d, { kind: 'lump', lumpId: lump.id, index: i });
        continue;
      }
      this.drags.delete(finger);
    }
  }

  /** 掴んでいる列の index 番の隕石 */
  private meteorAt(d: Drag, index: number): Meteor | null {
    if (d.kind === 'ground') return this.ground[d.col][index] ?? null;
    const lump = this.lumps.find((l) => l.id === d.lumpId);
    if (!lump) return null;
    return this.columnOfLump(lump, d.col)[index]?.meteor ?? null;
  }

  /**
   * 入れ替えた 2 個のどちらかが揃いに入ったら、指を離していなくてもそこで置く。
   * そうしないと、指を速く動かしたときに揃う位置を素通りしてしまう。
   * 1 フレームに何マスも進むと、揃った盤面が 1 度も tick に現れないため
   * （`from` は入れ替え前に掴んでいた隕石がいた添字。いまは相手がそこにいる）。
   * 置いたあとは普通の点火の流れに乗り、猶予フレームを経て点火する
   */
  private lockIfMatched(finger: number, d: Drag, from: number): boolean {
    const ids = new Set<number>();
    for (const m of [this.meteorAt(d, d.index), this.meteorAt(d, from)]) {
      if (m) ids.add(m.id);
    }
    if (ids.size === 0) return false;

    const grid = this.worldGrid();
    const runs = this.findRuns(
      (col, row) => grid.get(`${col},${row}`)?.meteor ?? null,
      this.cols,
      GRID_ROWS,
    );
    for (const key of runs.cells) {
      const meteor = grid.get(key)?.meteor;
      if (meteor && ids.has(meteor.id)) {
        this.drags.delete(finger);
        this.events.locked = true;
        return true;
      }
    }
    return false;
  }

  /**
   * 列の一番上の隕石を上へ弾く。それだけでは点火しない。
   * 上昇中のカタマリに当たれば合体して押し上げ、降ってくる同じ柄に当たれば相殺する。
   */
  private shoot(finger: number, col: number): void {
    const stack = this.ground[col];
    const meteor = stack.pop();
    if (!meteor) return;
    this.fallings.push({
      meteor,
      col,
      y: stack.length,
      vy: PHYSICS.shootSpeed,
      shot: true,
    });
    this.events.shot++;
    this.drags.delete(finger);
    this.breakTimers[col] = null;
  }

  private dragList(d: Drag): Meteor[] | null {
    if (d.kind === 'ground') {
      const list = this.ground[d.col];
      return d.index < list.length ? list : null;
    }
    const lump = this.lumps.find((l) => l.id === d.lumpId);
    if (!lump) return null;
    const cells = this.columnOfLump(lump, d.col);
    return d.index < cells.length ? cells.map((c) => c.meteor) : null;
  }

  private swapInList(d: Drag, list: Meteor[], a: number, b: number): void {
    if (d.kind === 'ground') {
      const g = this.ground[d.col];
      [g[a], g[b]] = [g[b], g[a]];
      return;
    }
    const lump = this.lumps.find((l) => l.id === d.lumpId)!;
    const cells = this.columnOfLump(lump, d.col);
    const tmp = cells[a].meteor;
    cells[a].meteor = cells[b].meteor;
    cells[b].meteor = tmp;
    void list;
  }

  /** カタマリの 1 列ぶんを下から順に返す */
  private columnOfLump(lump: Lump, col: number): LumpCell[] {
    return lump.cells.filter((c) => c.col === col).sort((a, b) => a.rel - b.rel);
  }

  // ---------------------------------------------------------------- 1 tick

  /**
   * 1 フレーム進める。
   * `events` は tick の頭ではなく末尾で入れ替える。
   * 頭で作り直していたころは、tick と tick のあいだの指の操作（シュート・移動）が
   * もう読み終わった前のフレームの `Events` に入り、呼び出し側に届かなかった
   */
  tick(): Events {
    if (this.over) return this.takeEvents();

    this.frame++;
    this.spawn();
    this.updateFallings();
    this.updateLumps();
    this.resolveIgnitions();
    this.updateDust();
    this.updateBreak();
    this.checkScreenClear();
    this.sendAttack();

    this.events.gameOver = this.over;
    return this.takeEvents();
  }

  /** 溜まった出来事を取り出し、次のフレームぶんを空にする */
  private takeEvents(): Events {
    const out = this.events;
    this.events = emptyEvents();
    return out;
  }

  // ---------------------------------------------------------------- 落下

  private spawn(): void {
    if (this.forked) return;
    this.spawnTimer -= 1;
    if (this.spawnTimer > 0) return;
    this.spawnTimer = this.spawnInterval;

    if (this.rareEnabled) {
      this.rareTimer -= this.spawnInterval;
      if (this.rareTimer <= 0) {
        this.rareTimer = RARE_METAL_INTERVAL_FRAMES;
        // 母星ノヴァリアは「火花」のみ（原作の資料の「レアメタル」の項）。
        // 惑星めぐりの先では「輪」が降る星もある
        this.dropRareMetal(this.planet.rareKind ?? Kind.Spark);
        return;
      }
    }

    // 積みの低い列に寄せて降らせると遊びやすいが、原作は列を選ばないので一様に選ぶ
    const col = this.rng.int(this.cols);
    this.fallings.push({
      meteor: this.makeMeteor(this.rollKind()),
      col,
      y: SCREEN_OUT_ROW,
      vy: 0,
      shot: false,
    });
  }

  /**
   * レアメタルは積もっている隕石の縦 1 列を壊しながら落ち、必ず最下部に着地する（原作どおり）。
   */
  private dropRareMetal(kind: Kind): void {
    const col = this.rng.int(this.cols);
    this.ground[col] = [];
    for (const lump of this.lumps) {
      lump.cells = lump.cells.filter((c) => c.col !== col);
    }
    this.lumps = this.lumps.filter((l) => l.cells.length > 0);
    this.fallings = this.fallings.filter((f) => f.col !== col);
    this.ground[col].push(this.makeMeteor(kind));
    this.breakTimers[col] = null;
    this.events.rareMetal = col;
    this.dropDrags((d) => d.col === col);
  }

  private updateFallings(): void {
    const speed = this.fallSpeed;
    const remain: Falling[] = [];
    // シュートの相殺で消えた隕石。この回の走査から外す
    const removed = new Set<Falling>();
    for (const f of this.fallings) {
      if (removed.has(f)) continue;
      if (f.shot) {
        if (this.updateShot(f, remain, removed)) remain.push(f);
        continue;
      }
      f.vy = -speed;
      f.y += f.vy;
      const landedOn = this.landingTargetFor(f);
      if (landedOn === 'ground') {
        this.ground[f.col].push(f.meteor);
        this.events.landed++;
        continue;
      }
      if (landedOn) {
        // カタマリの上に乗る。乗った重みでカタマリを押し下げる
        const top = this.columnOfLump(landedOn, f.col);
        const rel = top.length > 0 ? top[top.length - 1].rel + 1 : Math.round(f.y - landedOn.y);
        landedOn.cells.push({ col: f.col, rel, meteor: f.meteor });
        landedOn.vy -= PHYSICS.pushDownMeteor;
        this.events.landed++;
        continue;
      }
      remain.push(f);
    }
    this.fallings = remain;
  }

  /**
   * シュートで上へ弾いた隕石を進める。残すなら true。
   * 同じ柄の降ってくる隕石に当たれば相殺し、上昇中のカタマリに当たれば合体して押し上げる（原作どおり）。
   * 画面外へは出ない。
   */
  private updateShot(f: Falling, remain: Falling[], removed: Set<Falling>): boolean {
    f.vy -= this.gravity;
    f.y += f.vy;

    // 降ってくる同じ柄との相殺
    for (const other of this.fallings) {
      if (other === f || other.shot || other.col !== f.col || removed.has(other)) continue;
      if (other.meteor.kind !== f.meteor.kind) continue;
      if (Math.abs(other.y - f.y) < 0.9) {
        this.addScore(SCORE.shootCancel);
        this.events.shootCancel++;
        // まだ走査していない隕石でも確実に消えるように、両方を除外する
        removed.add(other);
        const idx = remain.indexOf(other);
        if (idx >= 0) remain.splice(idx, 1);
        return false;
      }
    }

    // 上昇中のカタマリに当たると合体して押し上げる
    for (const lump of this.lumps) {
      const cells = this.columnOfLump(lump, f.col);
      if (cells.length === 0) continue;
      const bottom = lump.y + cells[0].rel;
      if (f.y >= bottom - 1 && f.y <= bottom + cells.length) {
        lump.cells.push({ col: f.col, rel: cells[0].rel - 1, meteor: f.meteor });
        this.normalize(lump);
        lump.vy += PHYSICS.shootPush;
        return false;
      }
    }

    // 画面の上端では止まる。落ちてきたら普通の落下に戻す
    if (f.y >= SCREEN_OUT_ROW - 1) {
      f.y = SCREEN_OUT_ROW - 1;
      f.vy = Math.min(0, f.vy);
    }
    if (f.vy <= 0 && f.y <= this.ground[f.col].length) {
      this.ground[f.col].push(f.meteor);
      this.events.landed++;
      return false;
    }
    if (f.vy <= -PHYSICS.maxFallSpeed) f.shot = false;
    return true;
  }

  /** 降ってきた隕石が何に着いたか。'ground' か カタマリ か null */
  private landingTargetFor(f: Falling): 'ground' | Lump | null {
    for (const lump of this.lumps) {
      const cells = this.columnOfLump(lump, f.col);
      if (cells.length === 0) continue;
      const topRow = lump.y + cells[cells.length - 1].rel;
      if (f.y <= topRow + 1 && f.y > topRow - 1) return lump;
    }
    if (f.y <= this.ground[f.col].length) return 'ground';
    return null;
  }

  // ------------------------------------------------------------ カタマリ

  private updateLumps(): void {
    for (const lump of this.lumps) {
      if (lump.thrustFrames > 0) {
        lump.vy += lump.thrustAccel;
        lump.thrustFrames--;
      }
      // 加速中はカタマリの落下も速くなる（原作どおり）
      const accel = this.boost && lump.thrustFrames <= 0 ? PHYSICS.boostFallScale : 1;
      // 上がっているあいだは強い重力で減速させ、下り始めたら緩い重力に切り替えて徐々に落とす。
      // 上昇の高さ（＝スクリーンアウトする数）は変えずに、降りてくるまでの時間だけを伸ばす
      const rising = lump.vy > 0 || lump.thrustFrames > 0;
      lump.vy -= (rising ? this.gravity : this.lumpFallGravity) * accel;
      lump.vy = Math.max(
        -this.maxLumpFallSpeed * accel,
        Math.min(PHYSICS.maxRiseSpeed, lump.vy),
      );
      lump.y += lump.vy;
      this.screenOut(lump);
    }
    this.lumps = this.lumps.filter((l) => l.cells.length > 0);
    const held = this.heldMeteors();
    this.dock();
    this.landLumps();
    this.rebindDrags(held);
  }

  /** 画面上端（大気圏）を越えた隕石から順に消える */
  private screenOut(lump: Lump): void {
    // 掴んでいる隕石が消えたときだけ指から離す。
    // 同じカタマリの別の隕石が抜けるたびに離していたころは、上がりきる手前で
    // 毎フレーム指が外れ、空中のカタマリをほとんど動かせなかった
    const held = this.heldMeteors();
    const remain: LumpCell[] = [];
    for (const cell of lump.cells) {
      if (lump.y + cell.rel >= SCREEN_OUT_ROW) {
        this.countLaunch(cell.meteor);
        const finger = held.get(cell.meteor);
        if (finger !== undefined) this.drags.delete(finger);
        this.events.screenOut.push(cell.col);
        if (isRareMetal(cell.meteor.kind)) this.events.screenOutRare++;
      } else {
        remain.push(cell);
      }
    }
    lump.cells = remain;
  }

  private countLaunch(m: Meteor): void {
    if (isRareMetal(m.kind)) {
      this.launched.rare++;
      this.addScore(SCORE.launchRare);
    } else if (m.kind === Kind.Dust) {
      this.launched.dust++;
      this.addScore(SCORE.launchDust);
    } else {
      this.launched.normal++;
      this.addScore(SCORE.launchNormal);
    }
    // 燃えカスの攻撃力は通常の 1/3（原作の値）
    this.attackUnits += m.kind === Kind.Dust ? ATTACK.unitDust : ATTACK.unitNormal;
    this.lastLaunchFrame = this.frame;
    // 盤面から燃えカスが消えるのは、還元されたときと宇宙へ出したときの 2 つ。
    // 出したほうで連鎖が切れると、届かなかったときより上手い手が損をする
    this.comboGrace = LAUNCH_COMBO_GRACE_FRAMES;
  }

  /**
   * 溜まった攻撃の隕石を相手へ送る。
   * 原作は「最後の打ち上げから 1 秒のあいだ追加が無かったとき」に飛ぶ。
   * 打ち上げ続けているあいだは溜め続けられるが、上限に達したらそこで送る
   */
  private sendAttack(): void {
    const ready = this.pendingAttack;
    if (ready <= 0) return;
    const quiet = this.frame - this.lastLaunchFrame >= ATTACK.sendDelayFrames;
    if (!quiet && ready < ATTACK.maxPending) return;
    this.attackUnits -= ready * ATTACK.unitsPerMeteor;
    this.events.attackSent = ready;
  }

  /**
   * 相手からの攻撃の隕石が降ってくる。燃えカスとして降り、着地して時間が経つと色付きに還元する（原作どおり）。
   * 降る列の決め方は原作の資料に無い。1 列に積むと理不尽なので、列を一巡りしながら散らす。
   * 実際に降った個数を返す（tick の外から呼ぶので、呼び出し側が `Events` に足す）。
   * `into` を渡すと、降った列をそこに書く。相手の盤面のどこに刺さったかを描くのに使う
   */
  receiveAttack(count: number, into: Events | null = null): number {
    if (count <= 0 || this.over) return 0;
    const order = [...Array(this.cols).keys()];
    for (let i = order.length - 1; i > 0; i--) {
      const j = this.rng.int(i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    if (into) into.attackColumns = order.slice(0, Math.min(count, this.cols));
    for (let i = 0; i < count; i++) {
      this.fallings.push({
        // 攻撃で降ってくるぶんは、相手の惑星で燃え終わったあとの燃えカス。こちらでは燃えない
        meteor: {
          id: this.nextId++,
          kind: Kind.Dust,
          revert: this.revertAtkFrames,
          fromAttack: true,
          ignitedAt: -1,
        },
        col: order[i % this.cols],
        // 同じ列に重ねるぶんは 1 マスずつ上に置く。落下の速さは同じなので間隔は保たれる
        y: SCREEN_OUT_ROW + Math.floor(i / this.cols),
        vy: 0,
        shot: false,
      });
    }
    return count;
  }

  /** 1 列でも重なっているカタマリ同士は空中で合体する（空中ドッキング） */
  private dock(): void {
    for (let i = 0; i < this.lumps.length; i++) {
      for (let j = i + 1; j < this.lumps.length; j++) {
        const a = this.lumps[i];
        const b = this.lumps[j];
        if (!this.overlaps(a, b)) continue;
        this.merge(a, b);
        this.lumps.splice(j, 1);
        this.addScore(SCORE.airDock);
        this.events.airDock++;
        j--;
      }
    }
  }

  private overlaps(a: Lump, b: Lump): boolean {
    for (const ca of a.cells) {
      const ra = a.y + ca.rel;
      for (const cb of b.cells) {
        if (cb.col !== ca.col) continue;
        if (Math.abs(b.y + cb.rel - ra) < 1) return true;
      }
    }
    return false;
  }

  /** b を a に取り込む。コンボは高い方、速度は上向きに速い方を引き継ぐ */
  private merge(a: Lump, b: Lump): void {
    // 同じマスに 2 個重ならないよう、埋まっていたら上へ積み直す
    const occupied = new Set(a.cells.map((c) => `${c.col},${c.rel}`));
    for (const cell of [...b.cells].sort((x, y) => x.rel - y.rel)) {
      let rel = Math.round(b.y + cell.rel - a.y);
      while (occupied.has(`${cell.col},${rel}`)) rel++;
      occupied.add(`${cell.col},${rel}`);
      a.cells.push({ col: cell.col, rel, meteor: cell.meteor });
    }
    a.combo = Math.max(a.combo, b.combo);
    if (b.vy > a.vy) {
      a.vy = b.vy;
      a.thrustFrames = Math.max(a.thrustFrames, b.thrustFrames);
      a.thrustAccel = Math.max(a.thrustAccel, b.thrustAccel);
    }
    this.normalize(a);
  }

  /** 列ごとに rel を詰め直し、最下段を 0 に揃える */
  private normalize(lump: Lump): void {
    if (lump.cells.length === 0) return;
    const min = Math.min(...lump.cells.map((c) => c.rel));
    for (const c of lump.cells) c.rel -= min;
    lump.y += min;
  }

  /**
   * 落ちてきたカタマリが山に触れたら、触れた列だけ山に混ざる。
   * 触れていない列は別のカタマリとして落ち続ける（段差のある盤面で瞬間移動しないように）。
   */
  private landLumps(): void {
    const remain: Lump[] = [];
    for (const lump of this.lumps) {
      if (lump.vy > 0) {
        remain.push(lump);
        continue;
      }
      const landing: number[] = [];
      for (const col of this.lumpCols(lump)) {
        const cells = this.columnOfLump(lump, col);
        if (lump.y + cells[0].rel <= this.ground[col].length) landing.push(col);
      }
      if (landing.length === 0) {
        remain.push(lump);
        continue;
      }
      for (const col of landing) {
        for (const cell of this.columnOfLump(lump, col)) this.ground[col].push(cell.meteor);
      }
      this.events.landed++;
      this.events.lumpLanded++;
      lump.cells = lump.cells.filter((c) => !landing.includes(c.col));
      if (lump.cells.length > 0) {
        this.normalize(lump);
        remain.push(lump);
      }
    }
    this.lumps = remain;
  }

  private lumpCols(lump: Lump): number[] {
    return [...new Set(lump.cells.map((c) => c.col))].sort((a, b) => a - b);
  }

  // ---------------------------------------------------------------- 点火

  /**
   * 盤面全体を 1 つの格子として見て点火を判定する。
   * 地面の山と空中のカタマリを同じ格子に置くので、原作どおり
   * 空中のカタマリと地面（や別のカタマリ）を横につないで揃えられる。
   */
  private resolveIgnitions(): void {
    const grid = this.worldGrid();
    const runs = this.findRuns((col, row) => grid.get(`${col},${row}`)?.meteor ?? null, this.cols, GRID_ROWS);

    if (runs.cells.size === 0) {
      this.groundGrace = IGNITION_GRACE_FRAMES;
      return;
    }
    if (this.groundGrace > 0) {
      this.groundGrace--;
      return;
    }
    this.groundGrace = IGNITION_GRACE_FRAMES;
    this.ignite(runs, grid);
  }

  /** 盤面の隕石を世界座標（row は四捨五入）の格子に並べる */
  private worldGrid(): Map<string, WorldCell> {
    const grid = new Map<string, WorldCell>();
    for (let c = 0; c < this.cols; c++) {
      for (let r = 0; r < this.ground[c].length; r++) {
        grid.set(`${c},${r}`, { col: c, row: r, meteor: this.ground[c][r], lump: null });
      }
    }
    for (const lump of this.lumps) {
      for (const cell of [...lump.cells].sort((a, b) => a.rel - b.rel)) {
        let row = Math.round(lump.y + cell.rel);
        if (row < 0) row = 0;
        // 地面と重なる瞬間があるので、埋まっていたら上の空きへ寄せる。
        // 落とすとその隕石が点火判定から消えてしまう
        while (row < GRID_ROWS && grid.has(`${cell.col},${row}`)) row++;
        if (row >= GRID_ROWS) continue;
        grid.set(`${cell.col},${row}`, { col: cell.col, row, meteor: cell.meteor, lump });
      }
    }
    return grid;
  }

  /**
   * 点火して 1 つのカタマリを作る。
   * 点火位置から上にある隕石は、地面のぶんも空中のカタマリのぶんもまとめて持ち上がり、
   * 点火位置より下は置いていく。
   */
  private ignite(runs: { cells: Set<string>; vertical: boolean }, grid: Map<string, WorldCell>): void {
    const ignited = this.parseKeys(runs.cells);

    // 列ごとの点火位置（一番下の点火マス）
    const pivotByCol = new Map<number, number>();
    for (const { col, row } of ignited) {
      const cur = pivotByCol.get(col);
      if (cur === undefined || row < cur) pivotByCol.set(col, row);
    }
    let baseRow = Infinity;
    for (const pivot of pivotByCol.values()) baseRow = Math.min(baseRow, pivot);

    // 持ち上げる範囲を集める
    const taken: WorldCell[] = [];
    for (const [col, pivot] of pivotByCol) {
      // 点火したマスの上に「乗っている」ものだけを持ち上げる。間が空いたらそこで切る
      for (let r = pivot; r < GRID_ROWS; r++) {
        const cell = grid.get(`${col},${r}`);
        if (!cell) break;
        taken.push(cell);
      }
    }

    // 原作の分離条件を当てる。
    // 「点火で上に動く燃えカス以外の隕石が、カタマリに残る隕石とすれ違う（こすれる）なら
    //   カタマリ全体が打ち上がる。すれ違いが無ければ、点火位置より上だけが離れる」。
    // 動く隕石より下に残る隕石は離れていくだけなので、こすれない。
    // 隣の列に同じ高さ以上で残る隕石があるかどうかで決まる
    const takenMeteors = new Set(taken.map((t) => t.meteor));
    const movers = taken.filter((t) => !runs.cells.has(`${t.col},${t.row}`));
    const rest = new Map<Lump, WorldCell[]>();
    for (const cell of grid.values()) {
      if (!cell.lump || takenMeteors.has(cell.meteor)) continue;
      const list = rest.get(cell.lump);
      if (list) list.push(cell);
      else rest.set(cell.lump, [cell]);
    }
    for (const cell of [...taken]) {
      const staying = cell.lump ? rest.get(cell.lump) : undefined;
      if (!staying) continue;
      const rubs = staying.some((s) =>
        movers.some((m) => Math.abs(s.col - m.col) === 1 && s.row >= m.row),
      );
      // すれ違うなら、残りも連れていく（カタマリ全体が上がる）
      if (rubs) taken.push(...staying);
      rest.delete(cell.lump!);
    }

    // 持ち上げる隕石を掴んでいた指は離す。
    // 巻き込んだカタマリの残りを掴んでいた指は、最後に今いる場所へ付け直す。
    // 片方の手で点火しても、関係のない列を運んでいるもう片方の手は離さない
    const held = this.heldMeteors();
    const dropped = new Set<number>();
    for (const cell of taken) {
      const finger = held.get(cell.meteor);
      if (finger !== undefined) dropped.add(finger);
    }

    // 元の場所から取り除く
    const involved = new Set<Lump>();
    for (const cell of taken) {
      if (cell.lump) {
        involved.add(cell.lump);
        cell.lump.cells = cell.lump.cells.filter((c) => c.meteor !== cell.meteor);
      } else {
        this.ground[cell.col] = this.ground[cell.col].filter((m) => m !== cell.meteor);
      }
      this.breakTimers[cell.col] = null;
    }

    for (const { col, row } of ignited) {
      const cell = taken.find((t) => t.col === col && t.row === row);
      if (cell) this.toDust(cell.meteor);
    }

    // 連続点火の回数。燃えカスが残っているあいだは数え続ける
    this.chainCombo = Math.min(99, this.chainCombo + 1);
    this.maxCombo = Math.max(this.maxCombo, this.chainCombo);

    const lump: Lump = {
      id: this.nextLumpId++,
      cells: taken.map((t) => ({ col: t.col, rel: t.row - baseRow, meteor: t.meteor })),
      y: baseRow,
      vy: Math.max(0, ...[...involved].map((l) => l.vy)),
      thrustFrames: 0,
      thrustAccel: 0,
      combo: this.chainCombo,
    };
    // 巻き上げた元のカタマリは、残ったセルで基準の高さを取り直す。空になったものは消す
    for (const l of involved) {
      if (l.cells.length > 0) this.normalize(l);
    }
    this.lumps = this.lumps.filter((l) => l.cells.length > 0);
    this.normalize(lump);

    // 最下段での点火かどうか（地面の一番下、または巻き込んだカタマリの底）
    const bottom = baseRow === 0 || [...involved].some((l) => Math.abs(l.y - baseRow) < 1);
    this.applyThrust(lump, ignited.length, runs.vertical, bottom);
    this.lumps.push(lump);
    this.scoreIgnition(ignited, lump.combo, runs.vertical);
    this.dropDrags((_, finger) => dropped.has(finger));
    this.rebindDrags(held);
  }

  /**
   * 同種が縦か横に 3〜5 個並んでいるマスを全て集める。
   * 同じフレームに見つかったものは 1 回の点火として数える（コンボは 1 しか増えない）。
   */
  private findRuns(
    at: (col: number, row: number) => Meteor | null,
    cols: number,
    rows: number,
  ): { cells: Set<string>; vertical: boolean } {
    const cells = new Set<string>();
    let vertical = false;

    const scan = (get: (i: number) => { m: Meteor | null; key: string }, len: number, isVertical: boolean) => {
      let runStart = 0;
      let runKind: Kind | null = null;
      const flush = (end: number) => {
        if (runKind === null) return;
        const n = end - runStart;
        if (n >= MIN_IGNITION_RUN) {
          const take = Math.min(n, MAX_IGNITION_RUN);
          for (let i = runStart; i < runStart + take; i++) cells.add(get(i).key);
          if (isVertical) vertical = true;
        }
      };
      for (let i = 0; i < len; i++) {
        const { m } = get(i);
        const kind = m && m.kind !== Kind.Dust ? m.kind : null;
        if (kind === null || kind !== runKind) {
          flush(i);
          runStart = i;
          runKind = kind;
        }
      }
      flush(len);
    };

    for (let c = 0; c < cols; c++) {
      scan((r) => ({ m: at(c, r), key: `${c},${r}` }), rows, true);
    }
    for (let r = 0; r < rows; r++) {
      scan((c) => ({ m: at(c, r), key: `${c},${r}` }), cols, false);
    }
    return { cells, vertical };
  }

  private parseKeys(keys: Set<string>): { col: number; row: number }[] {
    return [...keys].map((k) => {
      const [c, r] = k.split(',');
      return { col: Number(c), row: Number(r) };
    });
  }

  private toDust(m: Meteor): void {
    m.kind = Kind.Dust;
    m.revert = this.revertDustFrames;
    m.ignitedAt = this.frame;
  }

  /**
   * 推進力を与える。重いほど上がらない。
   * 縦点火は継続推進力に `columnThrustScale` が掛かり、最下段での点火は `bottomBonus` が掛かる。
   */
  private applyThrust(lump: Lump, igniteCount: number, vertical: boolean, bottom: boolean): void {
    const p = this.planet;
    let mass = 0;
    for (const c of lump.cells) mass += c.meteor.kind === Kind.Dust ? PHYSICS.dustMass : 1;
    mass = Math.pow(Math.max(1, mass * p.lumpMassScale), PHYSICS.massExponent);

    const bonus = (bottom ? p.bottomBonus : 1) * Math.pow(p.reigniteScale, lump.combo - 1);
    lump.vy += (p.kick * igniteCount * bonus) / mass;
    lump.thrustAccel = (p.thrust * igniteCount * bonus * (vertical ? p.columnThrustScale : 1)) / mass;
    lump.thrustFrames = p.thrustTime;
  }

  private scoreIgnition(cells: { col: number; row: number }[], combo: number, vertical: boolean): void {
    const mult = Math.min(combo, SCORE.maxComboMultiplier);
    const gained = SCORE.perIgnitedMeteor * cells.length * mult;
    this.addScore(gained);
    this.maxCombo = Math.max(this.maxCombo, combo);
    this.events.ignitions.push({ cells, combo, vertical, score: gained });
  }

  private addScore(n: number): void {
    this.score = Math.min(SCORE.max, this.score + n);
  }

  // ------------------------------------------------------------ 燃えカス

  /** 着地している燃えカスだけが還元される。空中では還元しない */
  private updateDust(): void {
    let dustLeft = false;
    for (let c = 0; c < this.cols; c++) {
      for (const m of this.ground[c]) {
        if (m.kind !== Kind.Dust) continue;
        m.revert--;
        if (m.revert <= 0) {
          m.kind = this.rollKind();
          m.fromAttack = false;
          m.ignitedAt = -1;
          this.events.reverted++;
        } else {
          dustLeft = true;
        }
      }
    }
    for (const lump of this.lumps) {
      for (const cell of lump.cells) if (cell.meteor.kind === Kind.Dust) dustLeft = true;
    }
    if (!dustLeft && this.lumps.length === 0) {
      // 打ち上げた直後は、その燃えカスが還元されるはずだった間だけつないでおく
      if (this.comboGrace > 0) this.comboGrace--;
      else this.chainCombo = 0;
    }
  }

  // -------------------------------------------------------------- 滅亡

  /**
   * 燃えカスを含まず、空中のカタマリも無い列が大気圏まで積もると警告が出て、
   * 猶予のうちに崩せないと滅亡する（原作どおり）。
   *
   * その 1 段下（`WARN_ROWS`）は予兆として先に知らせる。滅亡の決まりは変えず、
   * 気づくまでの時間だけを延ばす（docs/decisions.md「ピンチの知らせ方」）
   */
  private updateBreak(): void {
    const covered = new Set<number>();
    for (const lump of this.lumps) for (const c of lump.cells) covered.add(c.col);

    for (let c = 0; c < this.cols; c++) {
      const stack = this.ground[c];
      const hasDust = stack.some((m) => m.kind === Kind.Dust);
      // 燃えカスがある列と、空中のカタマリが覆っている列は、いま滅亡しない。予兆も出さない
      const exempt = hasDust || covered.has(c);
      const danger = stack.length >= VISIBLE_ROWS && !exempt;
      this.warnings[c] = !danger && stack.length >= WARN_ROWS && !exempt;
      this.towers[c] = exempt ? 0 : stack.length;
      if (this.warnings[c]) this.events.warn = true;
      if (!danger) {
        this.breakTimers[c] = null;
        continue;
      }
      this.events.danger = true;
      if (this.breakTimers[c] === null) {
        // 積みきった最初のフレームは警告だけ出し、次のフレームから数え始める
        this.breakTimers[c] = this.breakFrames;
        continue;
      }
      this.breakTimers[c] = (this.breakTimers[c] as number) - 1;
      if ((this.breakTimers[c] as number) <= 0) {
        this.over = true;
        return;
      }
    }
  }

  /** 予兆の列があるか。表示と音で使う */
  hasWarning(): boolean {
    return this.warnings.some((w) => w);
  }

  /** フィールドが空になると全消し。列数 × 1,000 点。空の間に何度も入らないようにする */
  private checkScreenClear(): void {
    const empty =
      this.lumps.length === 0 &&
      this.fallings.length === 0 &&
      this.ground.every((col) => col.length === 0);
    if (!empty) {
      this.screenCleared = false;
      return;
    }
    if (this.screenCleared || this.frame < 60) return;
    this.screenCleared = true;
    this.addScore(SCORE.screenClearPerCol * this.cols);
    this.events.screenClear = true;
  }

  // -------------------------------------------------------------- 参照用

  /** 描画のために、いま盤面にある隕石を世界座標で列挙する */
  *allCells(): Generator<{ col: number; row: number; meteor: Meteor; airborne: boolean; lumpId: number }> {
    for (let c = 0; c < this.cols; c++) {
      for (let r = 0; r < this.ground[c].length; r++) {
        yield { col: c, row: r, meteor: this.ground[c][r], airborne: false, lumpId: 0 };
      }
    }
    for (const lump of this.lumps) {
      for (const cell of lump.cells) {
        yield { col: cell.col, row: lump.y + cell.rel, meteor: cell.meteor, airborne: true, lumpId: lump.id };
      }
    }
    for (const f of this.fallings) {
      yield { col: f.col, row: f.y, meteor: f.meteor, airborne: true, lumpId: -1 };
    }
  }

  /** 掴んでいる隕石の世界座標。描画のずらしに使う。`finger` を省くと掴みのどれか 1 つ */
  dragPosition(finger?: number): { col: number; row: number; meteor: Meteor } | null {
    const d = finger === undefined ? this.drag : this.drags.get(finger);
    if (!d) return null;
    if (d.kind === 'ground') {
      const m = this.ground[d.col][d.index];
      return m ? { col: d.col, row: d.index + d.offset, meteor: m } : null;
    }
    const lump = this.lumps.find((l) => l.id === d.lumpId);
    if (!lump) return null;
    const cells = this.columnOfLump(lump, d.col);
    const cell = cells[d.index];
    return cell ? { col: d.col, row: lump.y + cell.rel + d.offset, meteor: cell.meteor } : null;
  }

  /** 掴んでいるすべての隕石の世界座標 */
  dragPositions(): { col: number; row: number; meteor: Meteor }[] {
    const out: { col: number; row: number; meteor: Meteor }[] = [];
    for (const finger of this.drags.keys()) {
      const p = this.dragPosition(finger);
      if (p) out.push(p);
    }
    return out;
  }

  /** 掴んでいる隕石から、掴んでいる指を引く */
  private heldMeteors(): Map<Meteor, number> {
    const out = new Map<Meteor, number>();
    for (const finger of this.drags.keys()) {
      const p = this.dragPosition(finger);
      if (p) out.set(p.meteor, finger);
    }
    return out;
  }

  /** 地面に積もったいちばん高い列の段数。空中の隕石は数えない */
  peak(): number {
    return this.ground.reduce((top, col) => Math.max(top, col.length), 0);
  }

  /** 最も危ない列の残り猶予の割合（0〜1）。警告表示に使う */
  dangerRatio(): number {
    let worst = 0;
    const frames = this.breakFrames;
    for (const t of this.breakTimers) {
      if (t === null) continue;
      worst = Math.max(worst, 1 - t / frames);
    }
    return worst;
  }
}
