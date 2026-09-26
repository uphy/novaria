/**
 * 惑星めぐりで渡っていく惑星と、その並び。
 *
 * 原作にも惑星ごとのパラメータはあるが、母星以外の値は手元の資料に無い。
 * ここにあるのは全部こちら側で決めたもので、決め方は docs/decisions.md「惑星めぐり」にある。
 * 数値を変えたら `pnpm sim tour` で「CPU が脱出できるか」を測り直す。
 */
import { NOVARIA, unitsToFrames, type Planet } from './constants';
import { Kind } from './types';

/**
 * 軽力の星。重力が弱く、カタマリが高く上がってゆっくり降りてくる。
 * 空中で組み替える時間が長いので、連続点火を覚える星にする。
 * そのぶん降ってくる量は母星より少し多い
 */
export const MIRKA: Planet = {
  ...NOVARIA,
  name: 'mirka',
  label: 'ミルカ',
  rates: [
    [Kind.Circle, 1000],
    [Kind.Triangle, 1000],
    [Kind.Drop, 1000],
    [Kind.Square, 1000],
    [Kind.Leaf, 700],
    [Kind.Star, 60],
  ],
  rampFrames: unitsToFrames(13000),
  spawnStart: 76,
  spawnMax: 19,
  fallStart: 0.05,
  fallMax: 0.105,
  kick: 0.1,
  thrust: 0.0007,
  gravity: 0.007,
  lumpFallGravity: 0.00022,
};

/**
 * 重力の強い星。強く蹴らないと上がらず、カタマリも速く落ちてくる。
 * 空中で粘れないので、地面で横に広く揃えて一度に運ぶ星
 */
export const DUUN: Planet = {
  ...NOVARIA,
  name: 'duun',
  label: 'ドゥーン',
  rates: [
    [Kind.Circle, 1050],
    [Kind.Triangle, 1050],
    [Kind.Square, 1050],
    [Kind.Hexagon, 1050],
    [Kind.Pentagon, 600],
    [Kind.Star, 60],
  ],
  rampFrames: unitsToFrames(12000),
  spawnStart: 74,
  spawnMax: 18,
  fallStart: 0.055,
  fallMax: 0.115,
  graceStart: unitsToFrames(300),
  graceMax: unitsToFrames(100),
  kick: 0.135,
  thrust: 0.00095,
  columnThrustScale: 3.8,
  gravity: 0.014,
  lumpFallGravity: 0.00055,
  maxLumpFallSpeed: 0.024,
};

/**
 * 降りの速い星。隕石が短い間隔で速く落ちてくる。
 * 物理は母星とほぼ同じで、さばく速さだけを問われる
 */
export const VENTO: Planet = {
  ...NOVARIA,
  name: 'vento',
  label: 'ヴェント',
  rates: [
    [Kind.Circle, 1100],
    [Kind.Drop, 1100],
    [Kind.Bolt, 1100],
    [Kind.Leaf, 1100],
    [Kind.Pentagon, 550],
    [Kind.Star, 60],
  ],
  rampFrames: unitsToFrames(11000),
  spawnStart: 62,
  spawnMax: 14,
  fallStart: 0.06,
  fallMax: 0.13,
  revertDustStart: unitsToFrames(110),
  revertDustMax: unitsToFrames(50),
};

/**
 * 柄の多い星。8 種類が降るので狙った揃いが作りにくい。
 * そのぶん降りは遅く、積もってからの猶予も長い
 */
export const PRISMA: Planet = {
  ...NOVARIA,
  name: 'prisma',
  label: 'プリズマ',
  rates: [
    [Kind.Circle, 850],
    [Kind.Triangle, 850],
    [Kind.Drop, 850],
    [Kind.Square, 850],
    [Kind.Hexagon, 700],
    [Kind.Bolt, 700],
    [Kind.Leaf, 600],
    [Kind.Star, 80],
  ],
  rampFrames: unitsToFrames(13000),
  spawnStart: 78,
  spawnMax: 22,
  graceStart: unitsToFrames(340),
  graceMax: unitsToFrames(120),
  thrust: 0.00088,
};

/**
 * 最果ての星。降りが速く、燃えカスの還元も滅亡までの猶予も短い。
 * 降るレアメタルは「輪」で、ここだけ得点の伸び方が変わる
 */
export const TERMINA: Planet = {
  ...NOVARIA,
  name: 'termina',
  label: 'テルミナ',
  rates: [
    [Kind.Circle, 950],
    [Kind.Triangle, 950],
    [Kind.Drop, 950],
    [Kind.Square, 950],
    [Kind.Crescent, 600],
    [Kind.Pentagon, 600],
    [Kind.Star, 70],
  ],
  rampFrames: unitsToFrames(9600),
  spawnStart: 58,
  spawnMax: 13,
  fallStart: 0.065,
  fallMax: 0.14,
  revertDustStart: unitsToFrames(105),
  revertDustMax: unitsToFrames(48),
  graceStart: unitsToFrames(260),
  graceMax: unitsToFrames(90),
  kick: 0.12,
  gravity: 0.012,
  lumpFallGravity: 0.0004,
  rareKind: Kind.Ring,
};

/** 惑星めぐりの 1 区間 */
export interface Stage {
  readonly planet: Planet;
  /** この惑星を抜けるのに要る打ち上げ数 */
  readonly goal: number;
  /** 画面に出す 1 行の紹介 */
  readonly note: string;
}

/**
 * 一本道の道のり。手前から順に難しくなる。
 * 脱出に要る打ち上げ数は、1 区間が 1〜2 分に収まるよう `pnpm sim tour` で決めた
 */
export const TOUR: readonly Stage[] = [
  { planet: NOVARIA, goal: 30, note: '母星。いつもの降り方' },
  { planet: MIRKA, goal: 38, note: '重力が弱い。高く上がり、ゆっくり降りてくる' },
  { planet: DUUN, goal: 48, note: '重力が強い。上がりにくく、速く落ちてくる' },
  { planet: VENTO, goal: 58, note: '降りが速い。休む間がない' },
  { planet: PRISMA, goal: 55, note: '柄が 8 種類。狙った揃いが作りにくい' },
  { planet: TERMINA, goal: 70, note: '最果て。猶予が短く、時のレアメタルが降る' },
];
