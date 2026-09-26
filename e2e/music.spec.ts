import { expect, test } from '@playwright/test';
import { openTitle, startGame } from './helpers';

/** 盤面の曲は音声ファイルなので、読み込めて回り始めるところまでを見る */
test('遊び始めると曲が鳴り、一時停止で止まり、続けると鳴り直し、メニューで消える', async ({ page }) => {
  await startGame(page);
  await page.waitForFunction(() => window.__novaria.audio.musicSounding);

  await page.keyboard.press('Escape');
  await expect(page.locator('#overlay h1')).toHaveText('一時停止');
  expect(await page.evaluate(() => window.__novaria.audio.musicState)).toBe('paused');
  expect(await page.evaluate(() => window.__novaria.audio.musicSounding)).toBe(false);

  await page.getByRole('button', { name: '続ける' }).click();
  await page.waitForFunction(() => window.__novaria.audio.musicSounding);

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'メニューへ' }).click();
  await page.waitForFunction(() => window.__novaria.menu);
  expect(await page.evaluate(() => window.__novaria.audio.musicState)).toBe('stopped');
  expect(await page.evaluate(() => window.__novaria.audio.musicSounding)).toBe(false);
});

/**
 * 初めて開いた端末では、曲のダウンロードと展開に数秒かかる。
 * 最初のタップから取りに行くと、遊び始めてしばらく無音になる。メニューを見ているあいだに済ませておく
 */
test('メニューを開いただけで、どこも触らないうちに曲の準備が終わる', async ({ page }) => {
  await openTitle(page);
  await page.waitForFunction(() => window.__novaria.audio.musicReady, undefined, { timeout: 5000 });
});
