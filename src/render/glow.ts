/**
 * 光の玉と光の柱。焼いておいて、色ごとに使い回す。
 *
 * 光って見せたいものは多い（火の粉・爆発の閃き・攻撃の弾・装填の弾）が、`shadowBlur` は
 * 描くたびにぼかしを作り直すので使えない。放射グラデーションを 1 度だけ焼き、
 * 大きさを変えて `lighter` で貼る。貼るのは四角 1 枚ぶんなので、円を塗るのと手間は変わらない。
 * 中身はぼけているので、解像度を上げて焼く必要もない
 */
const SPRITE = 64;
const glows = new Map<string, HTMLCanvasElement>();
const beams = new Map<string, HTMLCanvasElement>();

/** `#rrggbb` を rgba に直す */
export function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/**
 * 真ん中が白く、外へ color で広がって消える光の玉。
 * 半径 r で貼るなら `drawImage(glowSprite(c), x - r, y - r, r * 2, r * 2)`。
 * 芯（白く見えるところ）は半径の 2 割ほど
 */
export function glowSprite(color: string): HTMLCanvasElement {
  const hit = glows.get(color);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = SPRITE;
  canvas.height = SPRITE;
  const ctx = canvas.getContext('2d')!;
  const c = SPRITE / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.16, rgba(color, 0.95));
  g.addColorStop(0.42, rgba(color, 0.32));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SPRITE, SPRITE);
  glows.set(color, canvas);
  return canvas;
}

/**
 * 下から上へ伸びて消える光の柱。大気圏を抜けたカタマリの軌跡に使う。
 * 横は真ん中が明るく、縦は下（根元）が明るくて上へ消える
 */
export function beamSprite(color: string): HTMLCanvasElement {
  const hit = beams.get(color);
  if (hit) return hit;
  const w = 32;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const across = ctx.createLinearGradient(0, 0, w, 0);
  across.addColorStop(0, rgba(color, 0));
  across.addColorStop(0.3, rgba(color, 0.35));
  across.addColorStop(0.5, 'rgba(255,255,255,0.95)');
  across.addColorStop(0.7, rgba(color, 0.35));
  across.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = across;
  ctx.fillRect(0, 0, w, h);
  // 縦の抜けは、描いた絵を縦のグラデーションで切り抜いて出す
  ctx.globalCompositeOperation = 'destination-in';
  const along = ctx.createLinearGradient(0, h, 0, 0);
  along.addColorStop(0, 'rgba(0,0,0,1)');
  along.addColorStop(0.35, 'rgba(0,0,0,0.6)');
  along.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = along;
  ctx.fillRect(0, 0, w, h);
  beams.set(color, canvas);
  return canvas;
}
