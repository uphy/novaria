import { Glyph, LOOKS } from './theme';
import { Kind } from '../core/types';

/** 角の丸い四角を引く */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawGlyph(ctx: CanvasRenderingContext2D, glyph: Glyph, cx: number, cy: number, s: number): void {
  const p = (n: number) => s * n;
  ctx.beginPath();
  switch (glyph) {
    case 'circle':
      ctx.arc(cx, cy, p(0.26), 0, Math.PI * 2);
      break;
    case 'triangle':
      ctx.moveTo(cx, cy - p(0.3));
      ctx.lineTo(cx + p(0.28), cy + p(0.22));
      ctx.lineTo(cx - p(0.28), cy + p(0.22));
      ctx.closePath();
      break;
    case 'drop':
      ctx.moveTo(cx, cy + p(0.3));
      ctx.quadraticCurveTo(cx + p(0.3), cy + p(0.05), cx, cy - p(0.3));
      ctx.quadraticCurveTo(cx - p(0.3), cy + p(0.05), cx, cy + p(0.3));
      break;
    case 'square':
      ctx.rect(cx - p(0.24), cy - p(0.24), p(0.48), p(0.48));
      break;
    case 'hexagon':
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 2;
        const fn = i === 0 ? 'moveTo' : 'lineTo';
        ctx[fn](cx + Math.cos(a) * p(0.29), cy + Math.sin(a) * p(0.29));
      }
      ctx.closePath();
      break;
    case 'bolt':
      ctx.moveTo(cx + p(0.1), cy - p(0.32));
      ctx.lineTo(cx - p(0.22), cy + p(0.04));
      ctx.lineTo(cx - p(0.02), cy + p(0.04));
      ctx.lineTo(cx - p(0.1), cy + p(0.32));
      ctx.lineTo(cx + p(0.22), cy - p(0.04));
      ctx.lineTo(cx + p(0.02), cy - p(0.04));
      ctx.closePath();
      break;
    case 'leaf':
      ctx.moveTo(cx - p(0.26), cy + p(0.26));
      ctx.quadraticCurveTo(cx - p(0.3), cy - p(0.3), cx + p(0.26), cy - p(0.26));
      ctx.quadraticCurveTo(cx + p(0.3), cy + p(0.3), cx - p(0.26), cy + p(0.26));
      break;
    case 'pentagon':
      for (let i = 0; i < 5; i++) {
        const a = ((Math.PI * 2) / 5) * i - Math.PI / 2;
        const fn = i === 0 ? 'moveTo' : 'lineTo';
        ctx[fn](cx + Math.cos(a) * p(0.3), cy + Math.sin(a) * p(0.3));
      }
      ctx.closePath();
      break;
    case 'star':
      for (let i = 0; i < 10; i++) {
        const a = ((Math.PI * 2) / 10) * i - Math.PI / 2;
        const r = i % 2 === 0 ? p(0.32) : p(0.14);
        const fn = i === 0 ? 'moveTo' : 'lineTo';
        ctx[fn](cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
      ctx.closePath();
      break;
    case 'crescent':
      ctx.arc(cx, cy, p(0.3), Math.PI * 0.35, Math.PI * 1.65);
      ctx.arc(cx + p(0.13), cy, p(0.26), Math.PI * 1.6, Math.PI * 0.4, true);
      ctx.closePath();
      break;
    case 'spark':
      for (let i = 0; i < 8; i++) {
        const a = ((Math.PI * 2) / 8) * i;
        const r = i % 2 === 0 ? p(0.34) : p(0.12);
        const fn = i === 0 ? 'moveTo' : 'lineTo';
        ctx[fn](cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
      ctx.closePath();
      break;
    case 'ring':
      ctx.arc(cx, cy, p(0.26), 0, Math.PI * 2);
      ctx.moveTo(cx, cy - p(0.26));
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + p(0.16), cy + p(0.08));
      break;
  }
}

/**
 * マスの内側の余白（マスの大きさに対する比）。隣のマスとのすき間はこの 2 倍になる。
 * 原作は隕石が敷き詰まって見えるので、すき間は 1〜2px に詰める。
 * 縁の線（`EDGE`）の半分より小さくすると、焼いた絵の端で線が切れる
 */
export const TILE_PAD = 0.02;
/** 角丸の半径（マスの大きさに対する比）。丸すぎると粒が並んでいるように見える */
export const TILE_RADIUS = 0.1;
/** 縁の線の太さ（マスの大きさに対する比） */
const EDGE = 0.035;

export interface TileOptions {
  /** 燃えカスの還元がどこまで進んだか（0〜1）。枠の光り方に使う */
  revertProgress?: number;
  /** 点火した直後の光り */
  flash?: number;
  /** 点火して燃えている強さ（0〜1）。マスの中だけで炎が立つ */
  burn?: number;
  /** 炎の揺らぎの駒番号。数フレームごとに進めると火が動いて見える */
  burnPhase?: number;
  /** レアメタルの明滅 */
  shimmer?: number;
  alpha?: number;
}

/**
 * 種類ごとの絵を焼いておく置き場。
 * 中身はマスの大きさが同じなら毎回同じなので、1 マスずつ塗り直さず、焼いた絵を貼る。
 * 盤面には 100 個以上のマスがあり、毎フレーム塗り直すとスマホで 1 フレーム 30ms を超えた
 */
const baked = new Map<Kind, HTMLCanvasElement>();
/** 燃えている隕石に重ねる炎。揺らぎの駒数ぶん焼いておく */
let bakedBurnFrames: HTMLCanvasElement[] = [];
/** 噴射の炎。種類に関わらず 1 枚で足りる */
let bakedFlameTile: HTMLCanvasElement | null = null;
/** 焼いた絵がどの大きさ・解像度のものか。変わったら焼き直す */
let bakedFor = '';
let devicePixels = 1;

/** 燃えている隕石の炎は、この枚数を切り替えて揺らす */
const BURN_PHASES = 6;
/** 炎の絵の幅と長さ（マスの大きさに対する比）。貼るときに伸び縮みさせる */
const FLAME_W = 1;
const FLAME_H = 2.6;

/** canvas の解像度（devicePixelRatio）を伝える。View.resize から呼ぶ */
export function setTileScale(dpr: number): void {
  devicePixels = dpr;
}

/** 大きさか解像度が変わっていたら、焼いた絵を全部捨てる */
function ensureBakeKey(size: number): void {
  const key = `${size.toFixed(2)}@${devicePixels}`;
  if (key === bakedFor) return;
  bakedFor = key;
  baked.clear();
  bakedBurnFrames = [];
  bakedFlameTile = null;
}

/** 焼き付け先の canvas。w, h は CSS 画素で、中身は解像度のぶんだけ細かく描く */
export function makeBakeCanvas(w: number, h: number): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(w * devicePixels));
  canvas.height = Math.max(1, Math.ceil(h * devicePixels));
  const ctx = canvas.getContext('2d')!;
  ctx.scale(canvas.width / w, canvas.height / h);
  return ctx;
}

function bakedTile(kind: Kind, size: number): HTMLCanvasElement {
  ensureBakeKey(size);
  const hit = baked.get(kind);
  if (hit) return hit;

  const ctx = makeBakeCanvas(size, size);
  paintTile(ctx, kind, 0, 0, size);
  baked.set(kind, ctx.canvas);
  return ctx.canvas;
}

/**
 * 点火した隕石の上で燃える炎。マスの角丸で切り抜くので、火は自分の区画から出ない。
 * 光らせて明滅させると盤面が見えなくなるので、明るさは変えず、
 * 舌の高さと位置が違う駒を焼いておいて切り替える
 */
function bakedBurn(size: number, phase: number): HTMLCanvasElement {
  ensureBakeKey(size);
  if (bakedBurnFrames.length === 0) {
    for (let i = 0; i < BURN_PHASES; i++) bakedBurnFrames.push(paintBurn(size, i));
  }
  const i = ((phase % BURN_PHASES) + BURN_PHASES) % BURN_PHASES;
  return bakedBurnFrames[i];
}

function paintBurn(size: number, phase: number): HTMLCanvasElement {
  const ctx = makeBakeCanvas(size, size);
  const pad = size * TILE_PAD;
  const w = size - pad * 2;
  const foot = pad + w;

  roundRect(ctx, pad, pad, w, w, size * TILE_RADIUS);
  ctx.clip();

  // 下ほど熱い焚き口。上は煤けて暗くなる
  const base = ctx.createLinearGradient(0, foot, 0, pad);
  base.addColorStop(0, 'rgba(255,146,40,0.92)');
  base.addColorStop(0.45, 'rgba(206,62,18,0.72)');
  base.addColorStop(1, 'rgba(74,18,8,0.5)');
  ctx.fillStyle = base;
  ctx.fillRect(pad, pad, w, w);

  // 立ち上がる炎の舌。駒ごとに高さと位置をずらす
  const t = (phase / BURN_PHASES) * Math.PI * 2;
  for (let i = 0; i < 3; i++) {
    const cx = pad + w * (0.26 + i * 0.24 + 0.06 * Math.sin(t + i * 2.1));
    const h = w * (0.48 + 0.34 * Math.abs(Math.sin(t * 1.3 + i * 1.7)));
    const half = w * 0.15;
    const g = ctx.createLinearGradient(0, foot, 0, foot - h);
    g.addColorStop(0, 'rgba(255,244,206,0.95)');
    g.addColorStop(0.45, 'rgba(255,188,72,0.8)');
    g.addColorStop(1, 'rgba(255,116,28,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(cx - half, foot);
    ctx.quadraticCurveTo(cx - half * 0.7, foot - h * 0.55, cx, foot - h);
    ctx.quadraticCurveTo(cx + half * 0.7, foot - h * 0.55, cx + half, foot);
    ctx.closePath();
    ctx.fill();
  }

  return ctx.canvas;
}

/**
 * 噴射の炎。下へ伸びる 1 本の舌を焼いておき、幅と長さを変えて貼る。
 * 列ごとにグラデーションを作り直すと、9 列いっぱいのカタマリで 1 フレーム +1.7ms かかっていた
 */
export function bakedFlame(size: number): HTMLCanvasElement {
  ensureBakeKey(size);
  if (bakedFlameTile) return bakedFlameTile;

  const w = size * FLAME_W;
  const h = size * FLAME_H;
  const ctx = makeBakeCanvas(w, h);
  const cx = w / 2;
  ctx.globalCompositeOperation = 'lighter';

  // 口（上辺）で広く、下へ尖って消える舌。太い順に 3 枚重ねて芯を白くする
  const tongue = (half: number, len: number, stops: [number, string][]) => {
    const g = ctx.createLinearGradient(0, 0, 0, len);
    for (const [at, color] of stops) g.addColorStop(at, color);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(cx - half, 0);
    ctx.quadraticCurveTo(cx - half * 0.85, len * 0.55, cx, len);
    ctx.quadraticCurveTo(cx + half * 0.85, len * 0.55, cx + half, 0);
    ctx.closePath();
    ctx.fill();
  };
  tongue(w * 0.5, h, [
    [0, 'rgba(255,184,76,0.85)'],
    [0.35, 'rgba(255,120,40,0.55)'],
    [1, 'rgba(255,60,20,0)'],
  ]);
  tongue(w * 0.33, h * 0.72, [
    [0, 'rgba(255,226,136,0.95)'],
    [0.5, 'rgba(255,150,50,0.6)'],
    [1, 'rgba(255,90,30,0)'],
  ]);
  tongue(w * 0.16, h * 0.42, [
    [0, 'rgba(255,255,240,1)'],
    [1, 'rgba(255,230,140,0)'],
  ]);

  bakedFlameTile = ctx.canvas;
  return ctx.canvas;
}

/**
 * 隕石 1 個を描く。x, y はマスの左上。
 * 種類と大きさだけで決まる部分は焼いた絵を貼り、光りものだけを上から重ねる
 */
export function drawTile(
  ctx: CanvasRenderingContext2D,
  kind: Kind,
  x: number,
  y: number,
  size: number,
  opts: TileOptions = {},
): void {
  const pad = size * TILE_PAD;
  const w = size - pad * 2;
  const r = size * TILE_RADIUS;

  ctx.save();
  if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha;
  ctx.drawImage(bakedTile(kind, size), x, y, size, size);

  // 燃えカスの還元が近づくと縁が明るくなる
  const revert = kind === Kind.Dust ? (opts.revertProgress ?? 0) : 0;
  if (revert > 0) {
    ctx.strokeStyle = `rgba(255,190,90,${0.15 + revert * 0.85})`;
    ctx.lineWidth = Math.max(1, size * 0.07 * revert);
    roundRect(ctx, x + pad, y + pad, w, w, r);
    ctx.stroke();
  }

  if (opts.shimmer) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255,255,255,${0.35 * opts.shimmer})`;
    roundRect(ctx, x + pad, y + pad, w, w, r);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  if (opts.flash) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255,255,255,${opts.flash})`;
    roundRect(ctx, x + pad, y + pad, w, w, r);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  // 点火した隕石で燃えている炎。消えるときは薄れて元の燃えカスに戻る
  if (opts.burn && opts.burn > 0) {
    ctx.globalAlpha = (opts.alpha ?? 1) * Math.min(1, opts.burn);
    ctx.drawImage(bakedBurn(size, opts.burnPhase ?? 0), x, y, size, size);
  }

  ctx.restore();
}

/**
 * 種類と大きさだけで決まる部分。焼くときに 1 度だけ通る。
 * 焼いてしまえば何を重ねても貼る手間は同じなので、ここは手間をかけて立体に見せる。
 * 面の陰影（左上から光）、内側の面取り（上の縁が明るく下の縁が暗い）、上のつや、
 * 彫り込んだ柄（下の縁にだけ光を返す）の順に重ねる
 */
function paintTile(
  ctx: CanvasRenderingContext2D,
  kind: Kind,
  x: number,
  y: number,
  size: number,
): void {
  const look = LOOKS[kind];
  const pad = size * TILE_PAD;
  const w = size - pad * 2;
  const r = size * TILE_RADIUS;
  const cx = x + size / 2;
  const cy = y + size / 2;
  const dust = kind === Kind.Dust;

  // 地の色。上が明るく下が暗い
  const grad = ctx.createLinearGradient(x, y, x, y + size);
  grad.addColorStop(0, look.light);
  grad.addColorStop(1, look.dark);
  ctx.fillStyle = grad;
  roundRect(ctx, x + pad, y + pad, w, w, r);
  ctx.fill();

  ctx.save();
  roundRect(ctx, x + pad, y + pad, w, w, r);
  ctx.clip();

  // 左上から当たる光。面が平らな板ではなく、ふくらんだ石に見える
  const shade = ctx.createRadialGradient(
    x + pad + w * 0.3,
    y + pad + w * 0.24,
    0,
    x + pad + w * 0.3,
    y + pad + w * 0.24,
    w * 0.95,
  );
  shade.addColorStop(0, `rgba(255,255,255,${dust ? 0.1 : 0.26})`);
  shade.addColorStop(0.55, 'rgba(255,255,255,0)');
  shade.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = shade;
  ctx.fillRect(x, y, size, size);

  // 面取り。同じ角丸を上下にずらしてなぞると、切り抜きの中では縁の片側だけが残る
  const bevel = Math.max(1, size * 0.05);
  ctx.lineWidth = bevel * 2;
  ctx.strokeStyle = `rgba(255,255,255,${dust ? 0.12 : 0.42})`;
  roundRect(ctx, x + pad, y + pad + bevel, w, w, r);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.26)';
  roundRect(ctx, x + pad, y + pad - bevel, w, w, r);
  ctx.stroke();
  ctx.restore();

  // 縁
  ctx.strokeStyle = look.ink;
  ctx.lineWidth = Math.max(1, size * EDGE);
  roundRect(ctx, x + pad, y + pad, w, w, r);
  ctx.stroke();

  // 上の面のつや。下へ溶かして、板に紙を貼ったように見せない
  const gloss = ctx.createLinearGradient(0, y + pad + w * 0.08, 0, y + pad + w * 0.34);
  gloss.addColorStop(0, `rgba(255,255,255,${dust ? 0.12 : 0.4})`);
  gloss.addColorStop(1, 'rgba(255,255,255,0.02)');
  ctx.fillStyle = gloss;
  roundRect(ctx, x + pad + w * 0.14, y + pad + w * 0.08, w * 0.72, w * 0.24, r * 0.55);
  ctx.fill();

  if (dust) {
    // 燃えカスは焦げた石。細かい穴を散らし、ひび割れで見せる
    // （還元が近づいたときの縁の光りは drawTile が上から重ねる）
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    for (const [dx, dy, dr] of [
      [0.22, 0.28, 0.06],
      [-0.26, 0.2, 0.045],
      [0.08, -0.22, 0.04],
      [-0.12, 0.34, 0.035],
    ]) {
      ctx.beginPath();
      ctx.arc(cx + w * dx, cy + w * dy, w * dr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, size * 0.05);
    const crack = (): void => {
      ctx.beginPath();
      ctx.moveTo(cx - w * 0.28, cy - w * 0.18);
      ctx.lineTo(cx - w * 0.02, cy + w * 0.04);
      ctx.lineTo(cx - w * 0.14, cy + w * 0.3);
      ctx.moveTo(cx + w * 0.3, cy - w * 0.02);
      ctx.lineTo(cx + w * 0.06, cy + w * 0.16);
      ctx.stroke();
    };
    // 割れ目の下の縁にだけ光を返して、彫り込んだ溝に見せる
    ctx.save();
    ctx.translate(0, Math.max(0.75, size * 0.02));
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    crack();
    ctx.restore();
    ctx.strokeStyle = 'rgba(0,0,0,0.62)';
    crack();
  } else {
    // 柄は彫り込み。1 段下に明るい縁を置いてから、濃い色で上から描く
    const stroked = look.glyph === 'ring' || look.glyph === 'leaf' || look.glyph === 'crescent';
    const gy = cy + size * 0.03;
    ctx.lineWidth = Math.max(1, size * 0.06);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    drawGlyph(ctx, look.glyph, cx, gy + Math.max(1, size * 0.03), size);
    if (stroked) ctx.stroke();
    else ctx.fill();
    ctx.fillStyle = look.ink;
    ctx.strokeStyle = look.ink;
    drawGlyph(ctx, look.glyph, cx, gy, size);
    if (stroked) ctx.stroke();
    else ctx.fill();
  }
}

export { roundRect };
