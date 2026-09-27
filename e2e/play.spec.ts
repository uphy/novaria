import { expect, test } from '@playwright/test';
import { Kind } from '../src/core/types';
import { advance, cellCenter, columnKinds, startGame } from './helpers';

/** 揃いが起きない静かな盤面。どの列も縦に 2 個までしか同じ柄が続かない */
const QUIET: Kind[][] = [
  [Kind.Circle, Kind.Triangle],
  [Kind.Drop, Kind.Square],
  [Kind.Triangle, Kind.Circle],
  [Kind.Square, Kind.Drop],
  [Kind.Circle, Kind.Square],
  [Kind.Triangle, Kind.Drop],
  [Kind.Drop, Kind.Circle],
  [Kind.Square, Kind.Triangle],
  [Kind.Circle, Kind.Drop],
];

/**
 * 左の 3 列を 11 段まで積み、その一番上（row 10）だけ揃えた盤面。
 * 下の 10 段は縦にも横にも 3 つ続かない。
 * 低い位置から点火しても推進力が尽きて大気圏を抜けないので、高く積んでから点火させる
 */
const LINED_UP: Kind[][] = [0, 1, 2].map((col) => [
  ...Array.from({ length: 10 }, (_, i) => ((i + col) % 2 === 0 ? Kind.Circle : Kind.Drop)),
  Kind.Triangle,
]);

/**
 * 列 0 の Triangle（下から 4 番目）を 2 マス下へ運ぶと、下から 2 段目が Triangle 3 つで揃う盤面。
 * 揃う位置は運ぶ途中にあるので、指を速く動かすと素通りしやすい
 */
const MATCH_ON_THE_WAY: Kind[][] = [
  [Kind.Circle, Kind.Square, Kind.Pentagon, Kind.Triangle],
  [Kind.Circle, Kind.Triangle, Kind.Square, Kind.Pentagon],
  [Kind.Square, Kind.Triangle, Kind.Pentagon, Kind.Circle],
];

test('指を速く動かして揃う位置を通り過ぎても点火する', async ({ page }) => {
  await startGame(page);
  await page.evaluate((c) => window.__novaria.setColumns(c), MATCH_ON_THE_WAY);
  expect(await page.evaluate(() => window.__novaria.game.score)).toBe(0);

  // 1 回の pointermove で 3 マスぶん動かす。指を払ったときと同じ速さ
  const from = await cellCenter(page, 0, 3);
  const to = await cellCenter(page, 0, 0);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y);

  // 指を離す前に、揃った位置で止まって点火する
  await page.waitForFunction(() => window.__novaria.game.score > 0);
  await page.waitForFunction(() => window.__novaria.game.lumps.length > 0);
  await page.mouse.up();
});

test('指でなぞると隕石が列の中で入れ替わる', async ({ page }) => {
  await startGame(page);
  await page.evaluate((q) => window.__novaria.setColumns(q), QUIET);

  const from = await cellCenter(page, 0, 0);
  const to = await cellCenter(page, 0, 1);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();

  // 下段の Circle が 1 段上がり、上に乗っていた Triangle が下りてくる
  expect((await columnKinds(page))[0]).toEqual([Kind.Triangle, Kind.Circle]);
  // 掴んだ列以外は動かない
  expect((await columnKinds(page))[1]).toEqual([Kind.Drop, Kind.Square]);
});

test('横に 3 つ揃うと点火して打ち上がり、宇宙へ消える', async ({ page }) => {
  await startGame(page);
  expect(await page.evaluate(() => window.__novaria.game.score)).toBe(0);

  await page.evaluate((c) => window.__novaria.setColumns(c), LINED_UP);

  await page.waitForFunction(() => window.__novaria.game.score > 0);
  await page.waitForFunction(() => window.__novaria.game.lumps.length > 0);
  // 点火した隕石は燃えカスになって上がるので、打ち上げ数は dust に入る
  await page.waitForFunction(() => window.__novaria.game.launched.dust >= 3);
});

test('派手に点火しても、出ている粒は上限で止まる', async ({ page }) => {
  await startGame(page);
  // 粒は 1 個ずつ別の描画になるので、数がそのままフレーム時間になる。
  // 上限が外れると、連鎖のたびに数千個まで増えて描画が 1 フレーム 70ms を超える
  await page.evaluate((c) => window.__novaria.setColumns(c), LINED_UP);
  await page.waitForFunction(() => window.__novaria.fx.particleCount > 0);

  for (let i = 0; i < 6; i += 1) {
    await page.evaluate((c) => window.__novaria.setColumns(c), LINED_UP);
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.__novaria.fx.particleCount)).toBeLessThanOrEqual(420);
  }
});

test('加速の帯を押すと落下が速くなる', async ({ page }) => {
  await startGame(page);
  const band = await page.evaluate(() => {
    const { layout } = window.__novaria.view;
    return { x: layout.fieldX + layout.fieldW / 2, y: layout.boostY + layout.boostH / 2 };
  });

  await page.mouse.move(band.x, band.y);
  await page.mouse.down();
  await advance(page, 10);
  expect(await page.evaluate(() => window.__novaria.game.boost)).toBe(true);

  await page.mouse.up();
  await advance(page, 10);
  expect(await page.evaluate(() => window.__novaria.game.boost)).toBe(false);
});

test.describe('両手で運ぶ', () => {
  test.use({ hasTouch: true });

  test('2 本の指で別々の列をなぞると、両方の列が入れ替わる', async ({ page }) => {
    await startGame(page);
    await page.evaluate((q) => window.__novaria.setColumns(q), QUIET);

    const a0 = await cellCenter(page, 0, 0);
    const a1 = await cellCenter(page, 0, 1);
    const b0 = await cellCenter(page, 3, 0);
    const b1 = await cellCenter(page, 3, 1);
    // 本物の指 2 本ぶんのタッチを送る。合成した PointerEvent では setPointerCapture が通らない
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number }[]) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id })),
      });
    await touch('touchStart', [a0, b0]);
    for (let i = 1; i <= 8; i++) {
      const t = i / 8;
      await touch('touchMove', [
        { x: a0.x, y: a0.y + (a1.y - a0.y) * t },
        { x: b0.x, y: b0.y + (b1.y - b0.y) * t },
      ]);
    }
    await touch('touchEnd', []);

    const cols = await columnKinds(page);
    expect(cols[0]).toEqual([Kind.Triangle, Kind.Circle]);
    expect(cols[3]).toEqual([Kind.Drop, Kind.Square]);
    // 触っていない列は動かない
    expect(cols[1]).toEqual([Kind.Drop, Kind.Square]);
    expect(await page.evaluate(() => window.__novaria.game.drags.size)).toBe(0);
  });
});
