import { expect, test } from '@playwright/test';
import { Kind } from '../src/core/types';
import { advance, openTitle } from './helpers';

/** 最上段だけ横に揃えた 3 列。点火すると燃えカスが宇宙へ抜ける */
const LINED_UP: Kind[][] = [0, 1, 2].map((col) => [
  ...Array.from({ length: 10 }, (_, i) => ((i + col) % 2 === 0 ? Kind.Circle : Kind.Drop)),
  Kind.Triangle,
]);

/** トップメニューから「対戦」→ 強さを選んで始める */
async function startVersus(page: import('@playwright/test').Page, level = '弱い'): Promise<void> {
  await openTitle(page);
  await page.getByRole('button', { name: '対戦' }).click();
  await expect(page.locator('#menu h1')).toHaveText('対戦');
  await page.getByRole('button', { name: level }).click();
  await page.waitForFunction(() => window.__novaria.running);
}

test('「対戦」から始めると、相手の盤面も一緒に動く', async ({ page }) => {
  await startVersus(page);
  expect(await page.evaluate(() => window.__novaria.versus !== null)).toBe(true);

  await advance(page, 120);
  const [mine, theirs] = await page.evaluate(() => {
    const v = window.__novaria.versus!;
    return [v.player.frame, v.rival.frame];
  });
  expect(mine).toBeGreaterThan(60);
  expect(theirs).toBe(mine);
});

test('打ち上げると、相手の盤面に燃えカスが降る', async ({ page }) => {
  await startVersus(page);
  // 相手は何もしない盤面にしておき、降ってきたぶんだけを見る
  await page.evaluate(() => {
    window.__novaria.versus!.rival.ground = window.__novaria.versus!.rival.ground.map(() => []);
  });
  await page.evaluate((c) => window.__novaria.setColumns(c), LINED_UP);

  await page.waitForFunction(() => window.__novaria.game.launched.dust > 0);
  await page.waitForFunction(() =>
    window.__novaria.versus!.rival.fallings.some((f) => f.meteor.fromAttack),
  );
});

test('打ち上げると弾が溜まり、送ったぶんが相手の盤面に着弾する', async ({ page }) => {
  await startVersus(page);
  await page.evaluate(() => {
    window.__novaria.versus!.rival.ground = window.__novaria.versus!.rival.ground.map(() => []);
  });
  await page.evaluate((c) => window.__novaria.setColumns(c), LINED_UP);

  // 宇宙へ抜けた隕石が、右上の装填へ吸い寄せられる
  await page.waitForFunction(() => window.__novaria.fx.tracerCount > 0);
  // 1 秒静かになると相手へ飛び、着弾でミニ盤面が膨らむ
  await page.waitForFunction(() => window.__novaria.fx.rivalHit > 0);
  expect(await page.evaluate(() => window.__novaria.fx.rivalHitCount)).toBeGreaterThan(0);
  // 刺さった列も分かる（CPU 戦は相手の盤面がこちらにあるので取れる）
  expect(await page.evaluate(() => window.__novaria.fx.rivalHitCols.length)).toBeGreaterThan(0);
});

test('相手が滅亡すると「勝ち」が出る', async ({ page }) => {
  await startVersus(page);
  await page.evaluate(() => {
    window.__novaria.versus!.rival.over = true;
  });
  await expect(page.locator('#overlay h1')).toHaveText('勝ち');
  expect(await page.evaluate(() => window.__novaria.running)).toBe(false);
});

test('自分が滅亡すると「負け」が出る', async ({ page }) => {
  await startVersus(page);
  await page.evaluate(() => {
    window.__novaria.game.over = true;
  });
  await expect(page.locator('#overlay h1')).toHaveText('負け');
});

test('対戦の得点は「記録」に残らないが、勝ち負けは相手ごとに残る', async ({ page }) => {
  await startVersus(page);
  await page.evaluate(() => {
    window.__novaria.game.score = 999999;
    window.__novaria.game.over = true;
  });
  await expect(page.locator('#overlay h1')).toHaveText('負け');
  await page.getByRole('button', { name: 'メニューへ' }).click();
  await page.getByRole('button', { name: '記録' }).click();
  await expect(page.locator('#menu .panel-body .sub').first()).toContainText('まだ記録がない');
  const row = (name: string) => page.locator('#menu table.result tr').filter({ hasText: name });
  await expect(row('弱い')).toContainText('0 勝 1 敗');
  // 戦っていない相手の欄は空のまま
  await expect(row('強い')).toContainText('―');
});

test('同じ相手と続けて戦うと、勝ち負けが足されて結果画面と強さ選びに出る', async ({ page }) => {
  await startVersus(page);
  await page.evaluate(() => {
    window.__novaria.versus!.rival.over = true;
  });
  await expect(page.locator('#overlay h1')).toHaveText('勝ち');
  await expect(page.locator('#overlay .best')).toHaveText('CPU（弱い）とは通算 1 勝 0 敗');

  await page.getByRole('button', { name: 'もう一度' }).click();
  await page.waitForFunction(() => window.__novaria.running);
  await page.evaluate(() => {
    window.__novaria.game.over = true;
  });
  await expect(page.locator('#overlay h1')).toHaveText('負け');
  await expect(page.locator('#overlay .best')).toHaveText('CPU（弱い）とは通算 1 勝 1 敗');

  await page.getByRole('button', { name: 'メニューへ' }).click();
  await page.getByRole('button', { name: '対戦' }).click();
  await expect(page.locator('#cpu-easy .tally')).toHaveText('1 勝 1 敗');
  // まだ戦っていない強さには出ない
  await expect(page.locator('#cpu-hard .tally')).toHaveCount(0);
});

test('決着してもすぐには結果を出さず、盤面を止めて帯と音で勝ちを知らせる', async ({ page }) => {
  await startVersus(page);
  await page.evaluate(() => {
    window.__novaria.versus!.rival.over = true;
  });
  await page.waitForFunction(() => window.__novaria.finale !== null);
  expect(await page.evaluate(() => window.__novaria.fx.bannerTitle)).toBe('VICTORY');
  expect(await page.evaluate(() => window.__novaria.audio.played.includes('victory'))).toBe(true);
  // 止めているあいだは盤面が進まない
  const frame = await page.evaluate(() => window.__novaria.game.frame);
  await page.waitForFunction(() => (window.__novaria.finale ?? 0) >= 12);
  expect(await page.evaluate(() => window.__novaria.game.frame)).toBe(frame);
  // 帯を読むあいだ（1 秒を過ぎても）結果の画面は出ない
  await page.waitForFunction(() => (window.__novaria.finale ?? 0) >= 60);
  await expect(page.locator('#overlay')).not.toHaveClass(/shown/);
  await expect(page.locator('#overlay h1')).toHaveText('勝ち');
});

test('決着の演出は、少し見せたあとなら触って飛ばせる', async ({ page }) => {
  await startVersus(page);
  await page.evaluate(() => {
    window.__novaria.game.over = true;
  });
  await page.waitForFunction(() => window.__novaria.finale !== null);
  // 決着の直後に触っても飛ばない（最後まで必死に触っていた指で飛ばさないように）
  await page.locator('#game').click();
  expect(await page.evaluate(() => window.__novaria.running)).toBe(true);
  await page.waitForFunction(() => (window.__novaria.finale ?? 0) >= 50);
  await page.locator('#game').click();
  await expect(page.locator('#overlay h1')).toHaveText('負け');
  expect(await page.evaluate(() => window.__novaria.audio.played.includes('defeat'))).toBe(true);
});

test('負けると、相手の盤面がどれだけ危なかったかと連敗が出て、「リベンジ」で同じ相手と戦える', async ({ page }) => {
  await startVersus(page);
  const loseOnce = async (): Promise<void> => {
    await page.evaluate(() => {
      const v = window.__novaria.versus!;
      // 相手の盤面を大気圏の 1 段下まで積む。縦横に 3 つ並ばないよう互い違いにする
      let id = 2_000_000;
      v.rival.ground = v.rival.ground.map((_, col) =>
        Array.from({ length: 11 }, (_, row) => ({
          id: id++,
          kind: (row + col) % 2 === 0 ? 0 : 1,
          revert: 0,
          fromAttack: false,
          ignitedAt: -1,
        })),
      );
      window.__novaria.game.over = true;
    });
    await expect(page.locator('#overlay h1')).toHaveText('負け');
  };
  await loseOnce();
  await expect(page.locator('#overlay .verdict')).toHaveText('相手もあと 1 段で大気圏だった');
  // 1 敗目は連敗と言わない
  await expect(page.locator('#overlay .streak')).toHaveCount(0);

  await page.getByRole('button', { name: 'リベンジ' }).click();
  await page.waitForFunction(() => window.__novaria.running);
  await loseOnce();
  await expect(page.locator('#overlay .streak')).toHaveText('CPU（弱い）に 2 連敗');

  // 勝てば連敗が途切れたことを書き、ボタンは「もう一度」に戻る
  await page.getByRole('button', { name: 'リベンジ' }).click();
  await page.waitForFunction(() => window.__novaria.running);
  await page.evaluate(() => {
    window.__novaria.versus!.rival.over = true;
  });
  await expect(page.locator('#overlay h1')).toHaveText('勝ち');
  await expect(page.locator('#overlay .streak')).toHaveText('連敗を 2 で止めた');
  await expect(page.locator('#overlay .verdict')).toContainText('段');
  await expect(page.getByRole('button', { name: 'もう一度' })).toBeVisible();
});

test('勝つと発射台から花火が上がり、最後の大玉まで見せてから結果を出す', async ({ page }) => {
  await startVersus(page);
  await page.evaluate(() => {
    window.__novaria.versus!.rival.over = true;
  });
  // 小玉 7 発と大玉 1 発
  await page.waitForFunction(() => window.__novaria.fx.shellsFired === 8);
  await page.waitForFunction(() => window.__novaria.fx.sparkCount > 0);
  // 大玉が開いた（2 秒）あとも、枝垂れるあいだは結果の画面を出さない
  await page.waitForFunction(() => (window.__novaria.finale ?? 0) >= 150);
  await expect(page.locator('#overlay')).not.toHaveClass(/shown/);
  expect(await page.evaluate(() => window.__novaria.fx.sparkCount)).toBeLessThanOrEqual(320);
  await expect(page.locator('#overlay h1')).toHaveText('勝ち');
});

test('負けると盤面が暗く沈み、警報と地平線の明かりが落ち、相手の盤面が勝ちを名乗る', async ({ page }) => {
  await startVersus(page);
  await page.evaluate(() => {
    window.__novaria.game.over = true;
  });
  await page.waitForFunction(() => (window.__novaria.finale ?? 0) >= 130);
  expect(await page.evaluate(() => window.__novaria.fx.dusk)).toBeGreaterThan(0.8);
  expect(await page.evaluate(() => window.__novaria.fx.rivalWins)).toBeGreaterThan(0.5);
  await expect(page.locator('#backdrop')).toHaveClass(/dusk/);
  await expect(page.locator('#alarm')).toHaveClass(/last/);
  await expect(page.locator('#overlay h1')).toHaveText('負け');

  // 次の盤面では明かりが戻る
  await page.getByRole('button', { name: 'リベンジ' }).click();
  await page.waitForFunction(() => window.__novaria.running);
  await expect(page.locator('#backdrop')).not.toHaveClass(/dusk/);
  await expect(page.locator('#alarm')).not.toHaveClass(/last/);
  expect(await page.evaluate(() => window.__novaria.fx.dusk)).toBe(0);
});
