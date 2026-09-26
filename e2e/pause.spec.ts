import { expect, test } from '@playwright/test';
import { advance, frame, startGame } from './helpers';

/** 盤面の上（得点の並び）の中心。ここを押すと一時停止する */
async function hudCenter(page: import('@playwright/test').Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const { layout } = window.__novaria.view;
    return { x: layout.width / 2, y: layout.hudY + 8 };
  });
}

test('得点欄を押すと止まり、「続ける」で同じ局面から再開する', async ({ page }) => {
  await startGame(page);
  await advance(page, 30);

  const hud = await hudCenter(page);
  await page.mouse.click(hud.x, hud.y);
  await expect(page.locator('#overlay h1')).toHaveText('一時停止');

  const stopped = await frame(page);
  await page.waitForTimeout(400);
  expect(await frame(page)).toBe(stopped);

  await page.getByRole('button', { name: '続ける' }).click();
  await expect(page.locator('#overlay')).not.toHaveClass(/shown/);
  await advance(page, 30);
  expect(await frame(page)).toBeGreaterThan(stopped);
});

test('「最初から」でフレームと得点が 0 に戻る', async ({ page }) => {
  await startGame(page);
  await advance(page, 60);

  const hud = await hudCenter(page);
  await page.mouse.click(hud.x, hud.y);
  await page.getByRole('button', { name: '最初から' }).click();
  await page.waitForFunction(() => window.__novaria.running);

  expect(await frame(page)).toBeLessThan(30);
  expect(await page.evaluate(() => window.__novaria.game.score)).toBe(0);
});

test('得点欄の左の一時停止ボタンを押すと止まる', async ({ page }) => {
  await startGame(page);
  await advance(page, 30);

  const box = await page.evaluate(() => {
    const { pause } = window.__novaria.view.layout;
    return { x: pause.x + pause.size / 2, y: pause.y + pause.size / 2 };
  });
  await page.mouse.click(box.x, box.y);
  await expect(page.locator('#overlay h1')).toHaveText('一時停止');
});

test('Escape でも止まる', async ({ page }) => {
  await startGame(page);
  await advance(page, 30);
  await page.keyboard.press('Escape');
  await expect(page.locator('#overlay h1')).toHaveText('一時停止');
});
