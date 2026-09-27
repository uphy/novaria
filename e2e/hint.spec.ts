import { expect, test } from '@playwright/test';
import { Kind } from '../src/core/types';
import { annihilate, openTitle, startGame } from './helpers';

/** 一時停止を開いて「ヒント なし」を押し、続ける */
async function turnHintOn(page: import('@playwright/test').Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'ヒント なし' }).click();
  await expect(page.getByRole('button', { name: 'ヒント あり' })).toBeVisible();
  await expect(page.locator('#hint-note')).toBeVisible();
  await page.getByRole('button', { name: '続ける' }).click();
  await page.waitForFunction(() => window.__novaria.running);
}

test('一時停止でヒントをつけると、揃う 1 手が矢印で出る', async ({ page }) => {
  await startGame(page);
  expect(await page.evaluate(() => window.__novaria.hint)).toBeNull();
  await turnHintOn(page);
  // 3 列目の丸を 1 つ下ろせば、いちばん下で丸が横に 3 つ揃う
  await page.evaluate(
    (c) => window.__novaria.setColumns(c),
    [[Kind.Circle], [Kind.Circle], [Kind.Drop, Kind.Circle]] as Kind[][],
  );
  await page.waitForFunction(() => {
    const h = window.__novaria.hint;
    return h !== null && h.col === 2 && h.from === 1 && h.to === 0;
  });
  expect(await page.evaluate(() => window.__novaria.hint?.aim.kind)).toBe('ignite');
});

test('ヒントをつけたゲームは、消しても記録に残さない', async ({ page }) => {
  await startGame(page);
  await turnHintOn(page);
  // 途中で消しても、つけたことは取り消せない
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'ヒント あり' }).click();
  await expect(page.locator('#hint-note')).toBeVisible();
  await page.getByRole('button', { name: '続ける' }).click();
  await page.waitForFunction(() => window.__novaria.running);

  await annihilate(page);
  await expect(page.locator('#overlay h1')).toHaveText('滅亡');
  await expect(page.locator('#overlay')).toContainText('このゲームは記録にもランキングにも残さない');
  expect(await page.evaluate(() => localStorage.getItem('novaria.records.v1'))).toBeNull();
});

test('ヒントは次のゲームに持ち越さない。つけ直さなければ記録に残る', async ({ page }) => {
  await startGame(page);
  await turnHintOn(page);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '最初から' }).click();
  await page.waitForFunction(() => window.__novaria.running);
  expect(await page.evaluate(() => window.__novaria.hint)).toBeNull();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'ヒント なし' })).toBeVisible();
  await expect(page.locator('#hint-note')).toBeHidden();
  await page.getByRole('button', { name: '続ける' }).click();
  await page.waitForFunction(() => window.__novaria.running);

  await annihilate(page);
  await expect(page.locator('#overlay h1')).toHaveText('滅亡');
  await expect(page.locator('#overlay')).not.toContainText('このゲームは記録にもランキングにも残さない');
  expect(await page.evaluate(() => localStorage.getItem('novaria.records.v1'))).not.toBeNull();
});

test('ヒントをつけると速さのスライダーが出て、左へ寄せるとゲームがゆっくり進む', async ({ page }) => {
  await startGame(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#hint-speed-box')).toBeHidden();
  await page.getByRole('button', { name: 'ヒント なし' }).click();
  await expect(page.locator('#hint-speed-box')).toBeVisible();
  await page.locator('#hint-speed').fill('0');
  await expect(page.locator('#hint-speed-value')).toHaveText('×0.25');
  await page.getByRole('button', { name: '続ける' }).click();
  await page.waitForFunction(() => window.__novaria.running);
  expect(await page.evaluate(() => window.__novaria.speed)).toBe(0.25);

  // ヒントを消すと通常の速さに戻る
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'ヒント あり' }).click();
  await expect(page.locator('#hint-speed-box')).toBeHidden();
  await page.getByRole('button', { name: '続ける' }).click();
  await page.waitForFunction(() => window.__novaria.running);
  expect(await page.evaluate(() => window.__novaria.speed)).toBe(1);

  // 次のゲームでヒントをつけ直すと、前に選んだ速さで始まる
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '最初から' }).click();
  await page.waitForFunction(() => window.__novaria.running);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'ヒント なし' }).click();
  await expect(page.locator('#hint-speed-value')).toHaveText('×0.25');
});

test('CPU 戦の一時停止にはヒントの切り替えが無い', async ({ page }) => {
  await openTitle(page);
  await page.evaluate(() => window.__novaria.startVersus('easy'));
  await page.waitForFunction(() => window.__novaria.running);
  await page.keyboard.press('Escape');
  await expect(page.locator('#overlay h1')).toHaveText('一時停止');
  await expect(page.locator('#pause-hint')).toHaveCount(0);
});
