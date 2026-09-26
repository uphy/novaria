import { type Page, expect, test } from '@playwright/test';
import { TOUR } from '../src/core/planets';
import { advance, annihilate, openTitle } from './helpers';

/** 「惑星めぐり」を開いて出発し、母星の盤面が動き出すまで待つ */
async function startTour(page: Page): Promise<void> {
  await openTitle(page);
  await page.getByRole('button', { name: '惑星めぐり' }).click();
  await page.getByRole('button', { name: '出発' }).click();
  await page.waitForFunction(() => window.__novaria.running);
}

/**
 * いまの惑星の脱出ゲージを満たす。
 * 目標は 30 個以上なので、指で打ち上げて満たすと e2e が何分もかかる。
 * 打ち上げ数だけを入れて、その先（脱出の画面と惑星の乗り継ぎ）を見る
 */
async function fillGauge(page: Page): Promise<void> {
  await page.evaluate(() => {
    const t = window.__novaria.tour!;
    t.game.launched.normal = t.stage.goal;
  });
}

/** いま body に渡っている空の中ほどの色 */
function skyMid(page: Page): Promise<string> {
  return page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--sky-mid').trim(),
  );
}

test('「惑星めぐり」に道のりが並び、出発すると母星から始まる', async ({ page }) => {
  await openTitle(page);
  await page.getByRole('button', { name: '惑星めぐり' }).click();
  await expect(page.locator('#menu h1')).toHaveText('惑星めぐり');
  await expect(page.locator('#menu ul.stops li')).toHaveCount(TOUR.length);
  await expect(page.locator('#menu ul.stops li').first()).toContainText(TOUR[0].planet.label);
  expect(await page.evaluate(() => window.__novaria.menu)).toBe('tour');

  await page.getByRole('button', { name: '出発' }).click();
  await page.waitForFunction(() => window.__novaria.running);
  expect(await page.evaluate(() => window.__novaria.tour?.index)).toBe(0);
  expect(await page.evaluate(() => window.__novaria.game.planet.name)).toBe(TOUR[0].planet.name);
});

test('ゲージが満ちると脱出の画面が出て、次の惑星では盤面も空の色も変わる', async ({ page }) => {
  await startTour(page);
  const home = await skyMid(page);
  await advance(page, 30);

  await fillGauge(page);
  await expect(page.locator('#overlay h1')).toHaveText('脱出');
  // 次の行き先が案内に出る
  await expect(page.locator('#overlay')).toContainText(TOUR[1].planet.label);
  // 脱出の画面を出しているあいだは盤面を進めない
  expect(await page.evaluate(() => window.__novaria.running)).toBe(false);

  await page.getByRole('button', { name: `${TOUR[1].planet.label} へ` }).click();
  await page.waitForFunction(() => window.__novaria.tour?.index === 1);
  expect(await page.evaluate(() => window.__novaria.game.planet.name)).toBe(TOUR[1].planet.name);
  // 惑星ごとに盤面は組み直す
  expect(await page.evaluate(() => window.__novaria.game.launched.normal)).toBe(0);
  expect(await skyMid(page)).not.toBe(home);
});

test('最後の惑星まで抜けると完走になり、記録に残る', async ({ page }) => {
  await startTour(page);
  for (let i = 0; i + 1 < TOUR.length; i++) {
    await fillGauge(page);
    await expect(page.locator('#overlay h1')).toHaveText('脱出');
    await page.getByRole('button', { name: `${TOUR[i + 1].planet.label} へ` }).click();
    await page.waitForFunction((n) => window.__novaria.tour?.index === n, i + 1);
  }

  await fillGauge(page);
  await expect(page.locator('#overlay h1')).toHaveText('完走');
  await expect(page.locator('#overlay')).toContainText(`${TOUR.length} / ${TOUR.length}`);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('novaria.tour.v1') ?? '{}')),
  ).toMatchObject({ reached: TOUR.length, completed: true });
});

test('途中で積みきると、到達した惑星が結果に出る', async ({ page }) => {
  await startTour(page);
  await annihilate(page);
  await expect(page.locator('#overlay h1')).toHaveText('滅亡');
  await expect(page.locator('#overlay')).toContainText(TOUR[0].planet.label);
  await expect(page.locator('#overlay')).toContainText(`1 / ${TOUR.length}`);
  // 惑星めぐりはランキングに送らない（1 人用と同じ物差しにならない）
  await expect(page.locator('#rank-line')).toHaveCount(0);
});

test('一時停止に、いまいる惑星と脱出までの残りが出る', async ({ page }) => {
  await startTour(page);
  await advance(page, 30);
  await page.keyboard.press('Escape');
  await expect(page.locator('#overlay h1')).toHaveText('一時停止');
  await expect(page.locator('#overlay')).toContainText(TOUR[0].planet.label);
  await expect(page.locator('#overlay')).toContainText('脱出まで');
});

test('メニューへ戻ると空の色が母星に戻る', async ({ page }) => {
  await startTour(page);
  const home = await skyMid(page);
  await fillGauge(page);
  await expect(page.locator('#overlay h1')).toHaveText('脱出');
  await page.getByRole('button', { name: `${TOUR[1].planet.label} へ` }).click();
  await page.waitForFunction(() => window.__novaria.tour?.index === 1);
  expect(await skyMid(page)).not.toBe(home);

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'メニューへ' }).click();
  await expect(page.locator('#menu h1')).toHaveText('NOVARIA');
  expect(await skyMid(page)).toBe(home);
});
