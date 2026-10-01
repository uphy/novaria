/**
 * 盤面に重ねる字（吹き出しと帯の見出し）。
 * 端の列で点火すると、真ん中に置いた吹き出しが画面の外へ切れていた。
 */
import { expect, test } from '@playwright/test';
import { startGame } from './helpers';

test('端の列の連鎖の吹き出しも、盤面の内側に収まる', async ({ page }) => {
  await startGame(page);
  await page.evaluate(() => {
    const { fx, view } = window.__novaria;
    const L = view.layout;
    const y = view.rowTop(4);
    // いちばん大きい連鎖の字を、左端と右端の列に出す
    fx.chain(view.colLeft(0) + L.cell / 2, y, 10, '#ff9ad8', 50);
    fx.chain(view.colLeft(8) + L.cell / 2, y, 10, '#ff9ad8', 50);
  });
  await page.waitForFunction(() => window.__novaria.fx.popupSpans.length === 2);

  const { spans, left, right } = await page.evaluate(() => {
    const L = window.__novaria.view.layout;
    return {
      spans: window.__novaria.fx.popupSpans,
      left: L.fieldX,
      right: L.fieldX + L.fieldW,
    };
  });
  for (const s of spans) {
    expect(s.half).toBeGreaterThan(0);
    expect(s.x - s.half).toBeGreaterThanOrEqual(left);
    expect(s.x + s.half).toBeLessThanOrEqual(right);
  }
});

test('始めると、何を遊ぶかが帯の見出しで出る', async ({ page }) => {
  await startGame(page);
  await page.waitForFunction(() => window.__novaria.fx.bannerTitle === 'MISSION START');
});

test('CPU 戦では相手が帯の見出しで出る', async ({ page }) => {
  await startGame(page);
  await page.evaluate(() => window.__novaria.startVersus('normal'));
  await page.waitForFunction(() => window.__novaria.fx.bannerTitle === 'VS CPU');
});

// 惑星めぐりで次の惑星へ渡ると、前の惑星で出した「10 CHAIN」や「+3」が新しい盤面の出だしに残っていた
test('新しい盤面を始めると、前の盤面の吹き出しと帯は残らない', async ({ page }) => {
  await startGame(page);
  await page.evaluate(() => {
    const { fx, view } = window.__novaria;
    fx.chain(view.colLeft(4), view.rowTop(12), 10, '#ff9ad8', 50);
    fx.popup(view.colLeft(4), view.rowTop(13), '+3', '#bfe9ff', 26);
    fx.banner('ESCAPE', '脱出', '#ffffff', 120);
    window.__novaria.start();
  });
  const left = await page.evaluate(() => ({
    popups: window.__novaria.fx.popupCount,
    banner: window.__novaria.fx.bannerTitle,
  }));
  expect(left.popups).toBe(0);
  expect(left.banner).toBe('MISSION START');
});
