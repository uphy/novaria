import { Kind } from './types';

/**
 * 時間の単位。原作の値は「1 秒 = 96」単位で書かれている。
 * このクローンは 60fps の固定 tick で動かすので、内部値をフレーム数に直して使う。
 */
export const UNITS_PER_SECOND = 96;
export const FPS = 60;

/** 原作の内部単位をフレーム数に直す */
export function unitsToFrames(units: number): number {
  return Math.round((units / UNITS_PER_SECOND) * FPS);
}

/**
 * 盤面の寸法。
 * 段数は原作の資料に無く未確定。
 * プレリリース資料の「9x12+2」と、原作のある惑星の固定上昇「9 マス = 画面の 3/4」から
 * 可視 12 段 + 大気圏 2 段と読んで実装する。
 */
export const VISIBLE_ROWS = 12;
export const ATMOSPHERE_ROWS = 2;
/**
 * 予兆を出す高さ。滅亡の判定（可視 12 段）の 1 段下。
 * 判定の高さで初めて知らせると、レベルが最大の終盤では猶予 1.15 秒しか残らない。
 * 実測では、滅亡した列が 11 段に居る時間は中央値 3 秒あるので、そこから知らせる
 *（docs/decisions.md「ピンチの知らせ方」）
 */
export const WARN_ROWS = VISIBLE_ROWS - 1;
/**
 * 発射台の灯で塔を知らせ始める高さ。予兆の 2 段下。
 * 目線は盤面の下にあり、上端の予兆には気づきにくいので、盤面の下の発射台で先に知らせる。
 * 実測では、滅亡した列はこの高さに 9.8 秒前から居る（docs/decisions.md「塔を発射台で知らせる」）
 */
export const WATCH_ROWS = WARN_ROWS - 2;
/** この row を完全に越えた隕石はスクリーンアウトする */
export const SCREEN_OUT_ROW = VISIBLE_ROWS + ATMOSPHERE_ROWS;
/**
 * 点火判定で見る格子の高さ。
 * 地面は滅亡の猶予のあいだ大気圏より上まで積めるので、スクリーンアウトの高さより少し広く取る。
 * ここを越えた隕石は点火判定に現れなくなる。
 */
export const GRID_ROWS = SCREEN_OUT_ROW + 4;

/** 点火に使える 1 列（縦横）あたりの最大個数。6 個並んでも 5 個までが 1 回の点火 */
export const MAX_IGNITION_RUN = 5;
export const MIN_IGNITION_RUN = 3;

/**
 * 列の一番上をこれだけ上へ押し込むとシュートになる（マス）。
 * 原作にあたる値は不明。普通に運ぶ操作と取り違えない大きさにした。
 */
export const SHOOT_CHARGE_ROWS = 0.7;

/**
 * 揃いから点火開始までの猶予。原作にあることは分かっているがフレーム数は不明。
 * 触って組み替え直せる手応えを残すため 6 フレーム（0.1 秒）にした。
 */
export const IGNITION_GRACE_FRAMES = 6;

/**
 * 打ち上げたあと、連鎖をつないでおく長さ（1.5 秒）。
 *
 * 原作のルールは「燃えカスが残っているあいだ数え続け、全て還元されるとリセット」で、
 * 宇宙へ出した燃えカスの扱いは手元の資料に無い。つまりここは原作値に縛られないので、
 * **人の手に合わせて決める**。「盤面を見て次の揃いを見つける → 指で運ぶ →
 * 点火の猶予（`IGNITION_GRACE_FRAMES`）」が踏める長さ。
 * 還元時間に合わせると終盤は 0.63 秒になり、人には届かない
 *（docs/decisions.md「打ち上げても連鎖は切らない」）。
 * レベルでは縮めない。終盤ほど盤面が混んで次の揃いを探しにくい
 */
export const LAUNCH_COMBO_GRACE_FRAMES = 90;

/**
 * 点火した隕石が燃えて見えるフレーム数（0.9 秒）。
 * 原作は点火の瞬間だけマスが白熱する。ここはそれより長く、炎で出している
 *（docs/decisions.md「点火した隕石は 0.9 秒だけ燃やす」）。
 * 見た目だけのもので、燃えているあいだも掴んで動かせる
 */
export const BURN_FRAMES = 54;

/** 落下と打ち上げの共通の物理定数。原作の値は不明なので手触りから決めた */
export const PHYSICS = {
  /** 重力加速度（row / frame^2）。下向きが正。上昇中のカタマリと、シュートした隕石に効く */
  gravity: 0.01,
  /**
   * 下降に入ったカタマリの重力。
   * 原作は「上昇が終わった後に徐々に下降する」。
   * 上昇と同じ重力で落とすと 3 マスのカタマリで滞空 1.4 秒しかなく、
   * 空中で揃え直す（第二次点火）にも、下から当てて合体させる（空中ドッキング）にも間に合わない。
   * 上昇の強さはそのままに、下降だけをごく緩めて空中で手を出せる時間を作る。
   * 上で止めて待たせるのではなく、落ちながら手を出せる時間を稼ぐ
   */
  lumpFallGravity: 0.00032,
  /** カタマリの落下速度の上限。降ってくる隕石の 20 分の 1 ほどで、ゆっくり降りてくる */
  maxLumpFallSpeed: 0.018,
  /** シュートした隕石が上へ飛ぶのをやめたと見なす速さ */
  maxFallSpeed: 0.34,
  /** カタマリの上昇速度の上限 */
  maxRiseSpeed: 0.55,
  /** 燃えカスの重さ。原作のある惑星の説明文にある「通常の 1/3」を全惑星に適用する（未確定） */
  dustMass: 1 / 3,
  /** 空から降る隕石がカタマリを押し下げる量 */
  pushDownMeteor: 0.07,
  /**
   * 重さが打ち上げに効く強さ。原作の質量の扱いは不明なので、
   * 推進力を 重さ^massExponent で割る形にした。1 にすると重いカタマリが全く上がらず、
   * 0 にすると重さを無視する。0.25 は「積んでいても数段は上がる」手触りになる値。
   */
  massExponent: 0.18,
  /** 加速中にカタマリの落下が速くなる倍率 */
  boostFallScale: 2.2,
  /** シュートの初速（row / frame）。原作にあたる値は不明 */
  shootSpeed: 0.3,
  /** シュートが上昇中のカタマリに当たったとき、押し上げる量 */
  shootPush: 0.12,
} as const;

/** ゲームレベル 0〜1 の間で start から max へ動く値を引く */
export function lerpLevel(start: number, max: number, level: number): number {
  return start + (max - start) * level;
}

/**
 * 経過時間からゲームレベル（0〜1）を出す。
 * 原作は「約 3 分で急変する」と言われる一方、内部の値ではレベルが 150 秒で最大になる。
 * 一次関数だと序盤から量が増えて覚える前に滅亡するので、立ち上がりを緩めた曲線にした。
 * 終盤の速さは変えていない。
 */
export function levelCurve(progress: number): number {
  const t = Math.min(1, Math.max(0, progress));
  return Math.pow(t, 1.6);
}

/** 惑星のパラメータ。値は 1 秒 = 96 単位の原作の資料から引いたものと、こちらで決めたものがある */
export interface Planet {
  /** 内部の id。色の対応（`src/render/theme.ts` の `PLANET_LOOKS`）を引くのに使う */
  readonly name: string;
  /** 画面に出す名前 */
  readonly label: string;
  readonly cols: number;
  /** 出現する隕石の種類と重み */
  readonly rates: ReadonlyArray<readonly [Kind, number]>;
  /** ゲームレベルが最大になるまでのフレーム数 */
  readonly rampFrames: number;
  /** 隕石が降る間隔（フレーム）。レベル 0 / 最大 */
  readonly spawnStart: number;
  readonly spawnMax: number;
  /** 降る隕石の落下速度（row / frame）。レベル 0 / 最大 */
  readonly fallStart: number;
  readonly fallMax: number;
  /** 自分の燃えカスの還元時間（フレーム） */
  readonly revertDustStart: number;
  readonly revertDustMax: number;
  /** 攻撃の隕石の還元時間（フレーム） */
  readonly revertAtkStart: number;
  readonly revertAtkMax: number;
  /** 積もってから滅亡までの猶予（フレーム） */
  readonly graceStart: number;
  readonly graceMax: number;
  /** 点火 1 個あたりの初速。上向きが正 */
  readonly kick: number;
  /** 点火 1 個あたりの継続推進力 */
  readonly thrust: number;
  /** 推進力の供給フレーム数 */
  readonly thrustTime: number;
  /** 縦点火の継続推進力の倍率 */
  readonly columnThrustScale: number;
  /** カタマリ最下段での点火の倍率 */
  readonly bottomBonus: number;
  /** 第 n 次点火ごとの倍率 */
  readonly reigniteScale: number;
  /** カタマリの重さ係数 */
  readonly lumpMassScale: number;
  /** 加速中の速度倍率 */
  readonly boostRate: number;
  /**
   * 惑星ごとに変える物理。省いたら `PHYSICS` の値をそのまま使う。
   * 原作も惑星ごとに上がり方と落ち方が違うので、ここで差を付ける
   */
  readonly gravity?: number;
  readonly lumpFallGravity?: number;
  readonly maxLumpFallSpeed?: number;
  /** この惑星に降るレアメタル。省いたら「火花」 */
  readonly rareKind?: Kind;
}

/**
 * 母星ノヴァリア。9 列。このゲームの標準の惑星で、原作の標準惑星にあたる。
 * 実測・解析で分かっている値（列数、還元時間、猶予、縦点火ボーナス、最下方ボーナス）は原作どおり。
 * 初速・継続推進力・第 n 次点火の倍率は原作の値が不明なので、
 * 「1 回の点火では画面外まで届かない」「縦のほうが高く上がる」を満たすよう手触りで決めた。
 */
export const NOVARIA: Planet = {
  name: 'novaria',
  label: 'ノヴァリア',
  cols: 9,
  rates: [
    [Kind.Circle, 1100],
    [Kind.Triangle, 1100],
    [Kind.Drop, 1100],
    [Kind.Square, 1100],
    [Kind.Pentagon, 600],
    [Kind.Star, 60],
  ],
  rampFrames: unitsToFrames(14400),
  spawnStart: 80,
  spawnMax: 20,
  fallStart: 0.05,
  fallMax: 0.1,
  revertDustStart: unitsToFrames(130),
  revertDustMax: unitsToFrames(60),
  revertAtkStart: unitsToFrames(130),
  revertAtkMax: unitsToFrames(60),
  graceStart: unitsToFrames(320),
  graceMax: unitsToFrames(110),
  kick: 0.115,
  thrust: 0.0008,
  thrustTime: 20,
  columnThrustScale: 3.5,
  bottomBonus: 1.1,
  reigniteScale: 1.15,
  lumpMassScale: 1,
  boostRate: 6,
};

/** 得点表。原作の値 */
export const SCORE = {
  /** 同時点火 1 個あたり。連続点火回数を掛ける */
  perIgnitedMeteor: 100,
  /** 連続点火回数の上限（これ以上は倍率が伸びない） */
  maxComboMultiplier: 10,
  /** 画面外に出た通常の隕石 1 個 */
  launchNormal: 20,
  /** 画面外に出た燃えカス 1 個 */
  launchDust: 10,
  /** 画面外に出たレアメタル 1 個 */
  launchRare: 10000,
  /** 空中ドッキング */
  airDock: 400,
  /** シュートが同じ柄の降ってくる隕石と相殺したとき。300（400 とする資料もあり未確定） */
  shootCancel: 300,
  /** 全消し。列数に掛ける */
  screenClearPerCol: 1000,
  /** 表示と内部の上限 */
  max: 9999995,
} as const;

/**
 * 対戦の攻撃。打ち上げた個数が相手に何個降るかの式は原作の資料に無い。
 * 「燃えカスの攻撃力は通常の 1/3」だけが分かっているので、
 * 通常 1 個を 3 単位、燃えカス 1 個を 1 単位として数え、3 単位で 1 個降らせる。
 */
export const ATTACK = {
  unitNormal: 3,
  unitDust: 1,
  /** 何単位で 1 個降るか */
  unitsPerMeteor: 3,
  /** 最後の打ち上げからこれだけ空くと相手へ送る（原作は 1 秒） */
  sendDelayFrames: 60,
  /** 溜まった個数がここに達したら、打ち上げが続いていても送る（原作のゲージ上限は 360） */
  maxPending: 360,
} as const;

/** レアメタルの抽選間隔（40 秒に 1 回） */
export const RARE_METAL_INTERVAL_FRAMES = 40 * FPS;
