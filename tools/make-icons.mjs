// PWA のアイコンを描き出す。`node tools/make-icons.mjs` で public/icons/ に書く。
// 絵を変えたいときはここを直して流し直す（出来上がった PNG は git に入れる）。
// 描画は Chromium の canvas に任せる。画像ファイルを手で用意せずに済み、色を theme.ts と揃えられる
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

/**
 * アイコン 1 枚を描く。ブラウザの中で動くので、外の変数は参照せず中で持つ。
 * 色は src/render/theme.ts に合わせる（しずくの隕石 LOOKS[Drop] と惑星の地面 UI.ground）。
 * maskable は Android が円や角丸に切り抜くので、絵を中央 80% に収める
 */
function paint([size, maskable]) {
  const METEOR = { light: '#6fd6ff', dark: '#1f7fd6', ink: '#0b3a63' };
  const GROUND = { face: '#3a2a55', edge: '#6a4fa0' };
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  const s = size / 512;

  // 空
  const sky = ctx.createLinearGradient(0, 0, 0, size);
  sky.addColorStop(0, '#05030f');
  sky.addColorStop(0.55, '#0b0722');
  sky.addColorStop(1, '#170d2e');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, size, size);

  ctx.save();
  if (maskable) {
    ctx.translate(size / 2, size / 2);
    ctx.scale(0.8, 0.8);
    ctx.translate(-size / 2, -size / 2);
  }

  // 星
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  for (const [x, y, r] of [
    [70, 90, 3],
    [150, 52, 2],
    [420, 110, 3.5],
    [360, 60, 2],
    [96, 210, 2],
    [448, 240, 2.5],
  ]) {
    ctx.beginPath();
    ctx.arc(x * s, y * s, r * s, 0, Math.PI * 2);
    ctx.fill();
  }

  // 惑星の地面
  ctx.fillStyle = GROUND.face;
  ctx.beginPath();
  ctx.ellipse(size / 2, 560 * s, 330 * s, 150 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = GROUND.edge;
  ctx.lineWidth = 10 * s;
  ctx.stroke();

  // 噴射の火
  const fire = ctx.createLinearGradient(0, 330 * s, 0, 470 * s);
  fire.addColorStop(0, 'rgba(255,210,87,0.95)');
  fire.addColorStop(1, 'rgba(255,106,61,0)');
  ctx.fillStyle = fire;
  ctx.beginPath();
  ctx.moveTo(190 * s, 330 * s);
  ctx.quadraticCurveTo(256 * s, 500 * s, 322 * s, 330 * s);
  ctx.closePath();
  ctx.fill();

  // 打ち上がる隕石
  const x = 146 * s;
  const y = 120 * s;
  const w = 220 * s;
  const r = 52 * s;
  const grad = ctx.createLinearGradient(0, y, 0, y + w);
  grad.addColorStop(0, METEOR.light);
  grad.addColorStop(1, METEOR.dark);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(x, y, w, w, r);
  ctx.fill();
  ctx.strokeStyle = METEOR.ink;
  ctx.lineWidth = 14 * s;
  ctx.stroke();

  // つや
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.beginPath();
  ctx.roundRect(x + w * 0.14, y + w * 0.1, w * 0.72, w * 0.2, r * 0.5);
  ctx.fill();

  // 水のしずく
  const cx = x + w / 2;
  const cy = y + w / 2 + 8 * s;
  const d = 66 * s;
  ctx.fillStyle = METEOR.ink;
  ctx.beginPath();
  ctx.moveTo(cx, cy + d);
  ctx.quadraticCurveTo(cx + d, cy + d * 0.15, cx, cy - d);
  ctx.quadraticCurveTo(cx - d, cy + d * 0.15, cx, cy + d);
  ctx.fill();

  ctx.restore();
  return c.toDataURL('image/png');
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<html><body></body></html>');
await mkdir('public/icons', { recursive: true });

const targets = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, false],
];

for (const [name, size, maskable] of targets) {
  const dataUrl = await page.evaluate(paint, [size, maskable]);
  await writeFile(`public/icons/${name}`, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log(`public/icons/${name} (${size}px${maskable ? ', maskable' : ''})`);
}

await browser.close();
