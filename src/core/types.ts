/** 隕石の種類。原作にならって 12 種 */
export enum Kind {
  Circle = 0,
  Triangle = 1,
  Drop = 2,
  Square = 3,
  Hexagon = 4,
  Bolt = 5,
  Leaf = 6,
  Pentagon = 7,
  Star = 8,
  Crescent = 9,
  Spark = 10,
  Ring = 11,
  /** 燃えカス。種類を持たず点火判定に入らない */
  Dust = 12,
}

export const KIND_COUNT = 13;

/** レアメタル（火花・輪）かどうか */
export function isRareMetal(kind: Kind): boolean {
  return kind === Kind.Spark || kind === Kind.Ring;
}

export interface Meteor {
  readonly id: number;
  kind: Kind;
  /** 燃えカスの還元までの残りフレーム。Dust 以外では 0 */
  revert: number;
  /** 相手から送られてきた攻撃の隕石か（還元先が送り手の分布になる） */
  fromAttack: boolean;
  /**
   * 点火して燃えカスになったフレーム。まだ点火していなければ -1。
   * 点火直後の燃える見た目（`burnHeat`）を、ここからの経過で出す
   */
  ignitedAt: number;
}

/** フィールド上の位置。row は下が 0 で、小数は 1 マスの途中を表す */
export interface Cell {
  col: number;
  row: number;
}

/** 空から降ってくる 1 個の隕石と、シュートで上へ弾いた隕石 */
export interface Falling {
  meteor: Meteor;
  col: number;
  /** 世界座標の row（float） */
  y: number;
  /** 上が正。空から降る隕石は毎フレーム落下速度で上書きされる */
  vy: number;
  /** 指で上へ払って飛ばした隕石（シュート）か */
  shot: boolean;
}

/** カタマリの中の 1 マス。rel はカタマリ内の相対 row（0 が最下段） */
export interface LumpCell {
  col: number;
  rel: number;
  meteor: Meteor;
}

/** 点火で打ち上がっている、または落下している隕石の集合 */
export interface Lump {
  readonly id: number;
  cells: LumpCell[];
  /** rel = 0 の世界座標 row（float） */
  y: number;
  vy: number;
  /** 推進力を供給している残りフレーム */
  thrustFrames: number;
  /** 1 フレームあたりの加速度（上方向が負） */
  thrustAccel: number;
  /** 連続点火回数。表示の x02 以降に対応 */
  combo: number;
}

/**
 * 得点欄の右に出す相手のミニ盤面。CPU 戦では相手の `Game` がそのまま入り、
 * オンライン対戦では通信で受け取った盤面（`src/online/protocol.ts`）が入る。
 * 描くのに要る分だけを並べてあるので、通信では隕石の id も速度も送らずに済む
 */
export interface RivalView {
  readonly cols: number;
  readonly frame: number;
  /** 最も危ない列の残り猶予の割合（0〜1）。枠の赤い点滅に使う */
  dangerRatio(): number;
  /** 地面に積もったいちばん高い列の段数。結果の画面で「あと何段だった」を出すのに使う */
  peak(): number;
  allCells(): Iterable<{ col: number; row: number; meteor: { kind: Kind } }>;
}

export type GameOverReason = 'annihilation';

export interface LaunchStat {
  /** 画面外に出た通常の隕石 */
  normal: number;
  /** 画面外に出た燃えカス */
  dust: number;
  /** 画面外に出たレアメタル */
  rare: number;
}
