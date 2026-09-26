import { Kind } from '../core/types';

/**
 * 色と柄。
 * 原作の隕石の絵柄は表現として保護されうるので真似しない。
 * 色は原作の資料に書かれた色の系統だけ合わせ、
 * 柄は幾何学図形で描き分ける（色が見分けにくい人でも形で区別できる）。
 */
export interface Look {
  readonly name: string;
  /** タイルの明るい側 */
  readonly light: string;
  /** タイルの暗い側 */
  readonly dark: string;
  /** 柄と縁の色 */
  readonly ink: string;
  readonly glyph: Glyph;
}

export type Glyph =
  | 'circle'
  | 'triangle'
  | 'drop'
  | 'square'
  | 'hexagon'
  | 'bolt'
  | 'leaf'
  | 'pentagon'
  | 'star'
  | 'crescent'
  | 'spark'
  | 'ring';

export const LOOKS: Record<Kind, Look> = {
  [Kind.Circle]: { name: '丸', light: '#ffffff', dark: '#c8d4e4', ink: '#5b6b82', glyph: 'circle' },
  [Kind.Triangle]: { name: '三角', light: '#ff7a5c', dark: '#d92b2b', ink: '#5a0f0f', glyph: 'triangle' },
  [Kind.Drop]: { name: 'しずく', light: '#6fd6ff', dark: '#1f7fd6', ink: '#0b3a63', glyph: 'drop' },
  [Kind.Square]: { name: '四角', light: '#ffb45c', dark: '#c8701a', ink: '#5a3208', glyph: 'square' },
  [Kind.Hexagon]: { name: '六角', light: '#c39bff', dark: '#7b45cc', ink: '#2e1259', glyph: 'hexagon' },
  [Kind.Bolt]: { name: '稲妻', light: '#ffe873', dark: '#e0b21b', ink: '#5c4404', glyph: 'bolt' },
  [Kind.Leaf]: { name: '葉', light: '#8ae87a', dark: '#2f9e38', ink: '#0e3d13', glyph: 'leaf' },
  [Kind.Pentagon]: { name: '五角', light: '#ffa8d4', dark: '#e2559b', ink: '#5e1039', glyph: 'pentagon' },
  [Kind.Star]: { name: '星', light: '#f2ffb0', dark: '#c3e04a', ink: '#4a5c0c', glyph: 'star' },
  [Kind.Crescent]: { name: '三日月', light: '#5f6fb5', dark: '#232a5c', ink: '#0a0d24', glyph: 'crescent' },
  [Kind.Spark]: { name: '火花', light: '#ffd2ef', dark: '#ff4fc0', ink: '#610a45', glyph: 'spark' },
  [Kind.Ring]: { name: '輪', light: '#d8ffe8', dark: '#2fd9a0', ink: '#07402c', glyph: 'ring' },
  [Kind.Dust]: { name: '燃えカス', light: '#5a5a63', dark: '#2a2a31', ink: '#15151a', glyph: 'circle' },
};

export const UI = {
  /** 盤面の背景（宇宙） */
  fieldBg: '#0a0a18',
  fieldBgDanger: '#2a0812',
  /** 大気圏（盤面の上のはみ出し領域） */
  skyTop: '#05050f',
  grid: 'rgba(255,255,255,0.06)',
  /** 惑星の地面 */
  ground: '#3a2a55',
  groundEdge: '#6a4fa0',
  text: '#ffffff',
  textDim: 'rgba(255,255,255,0.55)',
  danger: '#ff3b5c',
  /** 予兆（あと 1 段で危ない列）。赤より前の段階なので、赤と混ざらない橙にする */
  warn: '#ffbe47',
  combo: '#ffe873',
  /** 盤面の枠と得点欄の差し色。`index.html` の `--accent` と同じ値 */
  accent: '#6de3ff',
  font: "700 16px 'Hiragino Sans', 'Noto Sans JP', system-ui, sans-serif",
  mono: "700 16px 'SF Mono', ui-monospace, monospace",
} as const;

/**
 * 惑星ごとの色。空の 3 色は CSS 変数として body に渡し（全画面のグラデーションは canvas に塗らない）、
 * 盤面と地面の色は canvas に塗る。
 * 母星ノヴァリアの値は `index.html` の `:root` と同じものを書いてあるので、片方を変えたらもう片方も直す
 */
export interface PlanetLook {
  readonly skyTop: string;
  readonly skyMid: string;
  readonly skyBottom: string;
  /** 盤面の背景（宇宙） */
  readonly field: string;
  /** 惑星の地面 */
  readonly ground: string;
  readonly groundEdge: string;
}

export const PLANET_LOOKS: Record<string, PlanetLook> = {
  novaria: {
    skyTop: '#05030f',
    skyMid: '#0b0722',
    skyBottom: '#170d2e',
    field: UI.fieldBg,
    ground: UI.ground,
    groundEdge: UI.groundEdge,
  },
  mirka: {
    skyTop: '#01110f',
    skyMid: '#04211f',
    skyBottom: '#0a3330',
    field: '#061614',
    ground: '#1f4a45',
    groundEdge: '#3f8d80',
  },
  duun: {
    skyTop: '#120402',
    skyMid: '#2a0d07',
    skyBottom: '#3d1509',
    field: '#1a0a06',
    ground: '#5a2a1c',
    groundEdge: '#a3533a',
  },
  vento: {
    skyTop: '#0a1004',
    skyMid: '#1c2408',
    skyBottom: '#2b3a10',
    field: '#101608',
    ground: '#3d4a1c',
    groundEdge: '#7f9a3a',
  },
  prisma: {
    skyTop: '#0c0318',
    skyMid: '#1b0630',
    skyBottom: '#2c0a4a',
    field: '#130624',
    ground: '#3d1b5e',
    groundEdge: '#8a4fd0',
  },
  termina: {
    skyTop: '#050208',
    skyMid: '#12050c',
    skyBottom: '#1d0714',
    field: '#0b0308',
    ground: '#2a1030',
    groundEdge: '#6b2f6b',
  },
};

/** 母星ノヴァリアの色。メニューに戻ったときもこれに戻す */
export const DEFAULT_LOOK = PLANET_LOOKS.novaria;
