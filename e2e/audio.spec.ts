import { expect, test } from '@playwright/test';
import { Kind } from '../src/core/types';
import { advance, cellCenter, startGame } from './helpers';

/** 揃いが起きない静かな盤面。指で動かす音だけを見るために使う */
const QUIET: Kind[][] = [
  [Kind.Circle, Kind.Triangle, Kind.Circle, Kind.Drop],
  [Kind.Drop, Kind.Square, Kind.Drop, Kind.Square],
  [Kind.Triangle, Kind.Circle, Kind.Triangle, Kind.Circle],
  [Kind.Square, Kind.Drop, Kind.Square, Kind.Drop],
  [Kind.Circle, Kind.Square, Kind.Circle, Kind.Triangle],
  [Kind.Triangle, Kind.Drop, Kind.Triangle, Kind.Square],
  [Kind.Drop, Kind.Circle, Kind.Drop, Kind.Circle],
  [Kind.Square, Kind.Triangle, Kind.Square, Kind.Triangle],
  [Kind.Circle, Kind.Drop, Kind.Circle, Kind.Square],
];

/** 左の 3 列を高く積み、一番上だけ揃えた盤面。点火が連続して起きる */
const LINED_UP: Kind[][] = [0, 1, 2].map((col) => [
  ...Array.from({ length: 10 }, (_, i) => ((i + col) % 2 === 0 ? Kind.Circle : Kind.Drop)),
  Kind.Triangle,
]);

/** 山の高いところにレアメタルを乗せた列。点火するとレアメタルごと宇宙へ出る */
const RARE_LAUNCH: Kind[][] = [
  [
    ...Array.from({ length: 7 }, (_, i) => (i % 2 === 0 ? Kind.Circle : Kind.Pentagon)),
    Kind.Triangle,
    Kind.Triangle,
    Kind.Triangle,
    Kind.Spark,
  ],
];

function played(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => [...window.__novaria.audio.played]);
}

test('隕石を掴んで動かすと、掴む音と動かす音が鳴る', async ({ page }) => {
  await startGame(page);
  await page.evaluate((q) => window.__novaria.setColumns(q), QUIET);

  const from = await cellCenter(page, 0, 0);
  const to = await cellCenter(page, 0, 2);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await advance(page, 4);
  await page.mouse.up();
  await advance(page, 4);

  const sounds = await played(page);
  expect(sounds).toContain('grab');
  expect(sounds).toContain('step');
  expect(sounds).toContain('release');
});

test('点火すると爆発と噴射が鳴る', async ({ page }) => {
  await startGame(page);
  await page.evaluate((c) => window.__novaria.setColumns(c), LINED_UP);

  await page.waitForFunction(() => window.__novaria.audio.played.includes('explode'));
  await page.waitForFunction(() => window.__novaria.audio.played.includes('rise'));
});

test('レアメタルを宇宙へ出すと、ふつうの打ち上げとは別の音が鳴る', async ({ page }) => {
  await startGame(page);
  await page.evaluate((c) => window.__novaria.setColumns(c), RARE_LAUNCH);

  await page.waitForFunction(() => window.__novaria.game.launched.rare > 0);
  await page.waitForFunction(() => window.__novaria.audio.played.includes('rareLaunch'));
  expect(await page.evaluate(() => window.__novaria.game.score)).toBeGreaterThanOrEqual(10000);
});

/**
 * 音源の数はそのまま音声スレッドの負荷になる。
 * 上限が外れると、連鎖のたびに数十本まで増えて音が割れる
 */
test('派手に点火しても、鳴っている音源は上限で止まる', async ({ page }) => {
  await startGame(page);
  for (let i = 0; i < 6; i += 1) {
    await page.evaluate((c) => window.__novaria.setColumns(c), LINED_UP);
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.__novaria.audio.sources)).toBeLessThanOrEqual(24);
  }
});
