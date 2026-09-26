import { expect, test } from '@playwright/test';
import { advance, openFirstTime, openTitle, startGame } from './helpers';

/** いま画面に出ているメニューの名前。遊んでいる最中は null */
function menu(page: import('@playwright/test').Page): Promise<string | null> {
  return page.evaluate(() => window.__novaria.menu);
}

test('遊んでいる途中に戻っても、ゲームは終わらず一時停止する', async ({ page }) => {
  await startGame(page);
  await advance(page, 30);

  await page.goBack();

  await expect(page.locator('#overlay h1')).toHaveText('一時停止');
  expect(await page.evaluate(() => window.__novaria.running)).toBe(false);
  // 盤面はそのまま。ページから離れていない
  await expect(page.locator('#game')).toBeVisible();
});

test('一時停止で戻るとメニューへ行き、トップからの戻るでページを出る', async ({ page }) => {
  await startGame(page);
  await page.goBack();
  await expect(page.locator('#overlay h1')).toHaveText('一時停止');

  await page.goBack();
  expect(await menu(page)).toBe('top');
  // 積んだ履歴はトップで下ろす。次の戻るでアプリを閉じられる
  await page.waitForFunction(() => history.state === null);
});

test('「メニューへ」で戻ったあとも、履歴は積んだままにならない', async ({ page }) => {
  await startGame(page);
  expect(await page.evaluate(() => history.state)).toEqual({ novaria: 'guard' });

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'メニューへ' }).click();
  await page.waitForFunction(() => history.state === null);
});

test('メニューの下位画面で戻ると、1 つ前の画面に戻る', async ({ page }) => {
  await openTitle(page);
  await page.getByRole('button', { name: '記録' }).click();
  expect(await menu(page)).toBe('records');

  await page.goBack();
  expect(await menu(page)).toBe('top');

  // 「オンライン」は「対戦」の下なので、戻る先もそちら
  await page.getByRole('button', { name: '対戦' }).click();
  await page.getByRole('button', { name: 'オンライン' }).click();
  expect(await menu(page)).toBe('online');

  await page.goBack();
  expect(await menu(page)).toBe('versus');
});

test('名前の画面から戻ると、開いたところ（名前と公開）に戻り、さらに戻ると記録', async ({ page }) => {
  await openFirstTime(page);
  await page.getByRole('button', { name: '記録' }).click();
  await page.getByRole('button', { name: '名前と公開' }).click();
  await page.getByRole('button', { name: '名前を決める' }).click();
  expect(await menu(page)).toBe('name');

  await page.goBack();
  expect(await menu(page)).toBe('settings');
  await page.goBack();
  expect(await menu(page)).toBe('records');
  await page.goBack();
  expect(await menu(page)).toBe('top');
});
