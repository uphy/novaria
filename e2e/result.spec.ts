import { expect, test } from '@playwright/test';
import { Kind } from '../src/core/types';
import { annihilate, startGame } from './helpers';

/** 滅亡させたあとは、演出を見せてから結果に移る。記録が残るのはこのとき */
async function playToResult(page: import('@playwright/test').Page): Promise<void> {
  await annihilate(page);
  await expect(page.locator('#overlay h1')).toHaveText('滅亡');
}

test('積みきると滅亡して、結果と記録が出る', async ({ page }) => {
  await startGame(page);
  await playToResult(page);

  await expect(page.locator('#overlay h1')).toHaveText('滅亡');
  await expect(page.locator('#overlay h1')).toHaveClass(/over/);
  await expect(page.locator('#overlay table.result tr')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'もう一度' })).toBeVisible();

  // 記録は端末に残る
  const saved = await page.evaluate(() => localStorage.getItem('novaria.records.v1'));
  expect(saved).not.toBeNull();
  expect(JSON.parse(saved!)).toMatchObject({ seconds: expect.any(Number) });
});

test('滅亡したあと「もう一度」で遊び直せる', async ({ page }) => {
  await startGame(page);
  await playToResult(page);

  await page.getByRole('button', { name: 'もう一度' }).click();
  await page.waitForFunction(() => window.__novaria.running);
  expect(await page.evaluate(() => window.__novaria.game.over)).toBe(false);
});

test('遊んだあとの得点が、開き直しても「記録」に残る', async ({ page }) => {
  await startGame(page);
  // 得点が 0 のままだと記録に残らないので、先に 1 回点火させる
  await page.evaluate(
    (c) => window.__novaria.setColumns(c),
    [[Kind.Triangle], [Kind.Triangle], [Kind.Triangle]] as Kind[][],
  );
  await page.waitForFunction(() => window.__novaria.game.score > 0);
  const score = await page.evaluate(() => window.__novaria.game.score);
  await playToResult(page);

  await page.reload();
  await page.waitForFunction(() => Boolean(window.__novaria));
  await page.getByRole('button', { name: '記録' }).click();
  await expect(page.locator('#menu table.result tr').first()).toContainText(score.toLocaleString());
});
