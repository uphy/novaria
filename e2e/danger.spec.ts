/**
 * ピンチの知らせ方。滅亡の 1 段手前で予兆を出し、判定に届いたら赤い警告に変える。
 * 決まり（何段で滅亡するか・猶予の長さ）は変えていないので、ここで見るのは知らせ方だけ。
 */
import { expect, test } from '@playwright/test';
import { VISIBLE_ROWS, WARN_ROWS } from '../src/core/constants';
import { Kind } from '../src/core/types';
import { startGame } from './helpers';

/** 列 0 だけを n 段積んだ盤面。縦にも横にも 3 つ続かないので点火しない */
function tallColumn(n: number): Kind[][] {
  const tall = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? Kind.Triangle : Kind.Circle));
  return [tall, [Kind.Drop], [Kind.Square], [Kind.Drop], [Kind.Square], [Kind.Drop], [Kind.Square]];
}

test('あと 1 段で滅亡する列には、赤くなる前に予兆が出る', async ({ page }) => {
  await startGame(page);
  await page.evaluate((c) => window.__novaria.setColumns(c), tallColumn(WARN_ROWS));

  await page.waitForFunction(() => window.__novaria.game.warnings[0]);
  await page.waitForFunction(() => window.__novaria.audio.played.includes('warn'));
  // 予兆のあいだは、まだ滅亡までの数え上げが始まっていない
  expect(
    await page.evaluate(() => window.__novaria.game.breakTimers.every((t) => t === null)),
  ).toBe(true);
});

test('崩せば予兆は消える', async ({ page }) => {
  await startGame(page);
  await page.evaluate((c) => window.__novaria.setColumns(c), tallColumn(WARN_ROWS));
  await page.waitForFunction(() => window.__novaria.game.warnings[0]);

  await page.evaluate((c) => window.__novaria.setColumns(c), tallColumn(WARN_ROWS - 3));
  await page.waitForFunction(() => !window.__novaria.game.warnings[0]);
});

test('判定の高さに届くと赤い警告になり、揺れと音で知らせて猶予が減っていく', async ({ page }) => {
  await startGame(page);
  await page.evaluate((c) => window.__novaria.setColumns(c), tallColumn(VISIBLE_ROWS));

  await page.waitForFunction(() => window.__novaria.game.breakTimers[0] !== null);
  // 盤面を見ていなくても分かるよう、出た瞬間に画面が揺れる
  await page.waitForFunction(() => window.__novaria.fx.shakeAmount > 0);
  await page.waitForFunction(() => window.__novaria.audio.played.includes('dangerStart'));
  // 猶予のあいだ、呼吸の音が何度も鳴る（間隔は残りが減るほど詰まる）
  await page.waitForFunction(
    () => window.__novaria.audio.played.filter((s) => s === 'danger').length >= 4,
  );

  const left = await page.evaluate(() => window.__novaria.game.breakTimers[0]!);
  expect(left).toBeLessThan(await page.evaluate(() => window.__novaria.game.breakFrames));
});

test('赤い警告のあいだは画面の縁が赤く脈打ち、崩すと消える', async ({ page }) => {
  await startGame(page);
  const alarm = page.locator('#alarm');
  await expect(alarm).not.toHaveClass(/\bon\b/);

  await page.evaluate((c) => window.__novaria.setColumns(c), tallColumn(VISIBLE_ROWS));
  await expect(alarm).toHaveClass(/\bon\b/);
  await expect(alarm).toBeVisible();

  await page.evaluate((c) => window.__novaria.setColumns(c), tallColumn(WARN_ROWS - 3));
  await expect(alarm).not.toHaveClass(/\bon\b/);
});
