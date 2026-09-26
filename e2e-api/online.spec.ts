/**
 * オンライン対戦。2 つの端末（別々のブラウザコンテキスト）をつないで、
 * 攻撃が相手に届くところと、勝ち負けが両方で食い違わないところを見る。
 * `pnpm e2e:api` で wrangler dev を立てて回す（`pnpm e2e` の preview には Worker が無い）。
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { Kind } from '../src/core/types';

/** 最上段だけ横に揃えた 3 列。点火すると燃えカスが宇宙へ抜けて、相手に降る */
const LINED_UP: Kind[][] = [0, 1, 2].map((col) => [
  ...Array.from({ length: 10 }, (_, i) => ((i + col) % 2 === 0 ? Kind.Circle : Kind.Drop)),
  Kind.Triangle,
]);

let nextCode = 0;
/** 回ごとに別の合言葉にする。前のテストの相手とつながらないように（長さは 16 文字まで） */
function code(): string {
  nextCode += 1;
  return `t${Date.now() % 100000000}-${nextCode}`;
}

/** 名前を決めた端末を 1 つ開く。端末ごとに別のコンテキストにする */
async function openPlayer(browser: Browser, name: string): Promise<Page> {
  // 端末ごとに context を作るので、設定の baseURL は自動では効かない
  const base = test.info().project.use.baseURL ?? 'http://127.0.0.1:8788';
  const context = await browser.newContext({ viewport: { width: 420, height: 820 } });
  const page = await context.newPage();
  await page.addInitScript(
    (player) => localStorage.setItem('novaria.player.v1', JSON.stringify(player)),
    { id: crypto.randomUUID(), name },
  );
  await page.goto(`${base}/?seed=7`);
  await page.waitForFunction(() => Boolean(window.__novaria));
  return page;
}

/** 2 つの端末を同じ合言葉でつなぎ、対戦が始まるまで待つ */
async function pair(browser: Browser): Promise<[Page, Page]> {
  const word = code();
  const one = await openPlayer(browser, 'ひとりめ');
  const two = await openPlayer(browser, 'ふたりめ');
  await one.evaluate((c) => window.__novaria.startOnline(c), word);
  // 1 人目が待ちに入ってから 2 人目を入れる。つながる順番を決めておく
  await one.waitForFunction(() => window.__novaria.online?.phase === 'waiting');
  await two.evaluate((c) => window.__novaria.startOnline(c), word);
  await Promise.all([
    one.waitForFunction(() => window.__novaria.running, null, { timeout: 20_000 }),
    two.waitForFunction(() => window.__novaria.running, null, { timeout: 20_000 }),
  ]);
  return [one, two];
}

test('合言葉でつなぐと対戦が始まり、相手の名前が出る', async ({ browser }) => {
  const word = code();
  const one = await openPlayer(browser, 'ひとりめ');
  const two = await openPlayer(browser, 'ふたりめ');

  // 1 人目はメニューからたどって、相手を待つ
  await one.getByRole('button', { name: '対戦' }).click();
  await one.getByRole('button', { name: 'オンライン' }).click();
  await one.locator('#code-input').fill(word);
  await one.getByRole('button', { name: '合言葉でつなぐ' }).click();
  await expect(one.locator('#menu h1')).toHaveText('相手待ち');
  await expect(one.locator('#menu .panel')).toContainText(`合言葉「${word}」`);
  await expect(one.locator('#wait-note')).toContainText('待っている');

  await two.evaluate((c) => window.__novaria.startOnline(c), word);
  await Promise.all([
    one.waitForFunction(() => window.__novaria.running, null, { timeout: 20_000 }),
    two.waitForFunction(() => window.__novaria.running, null, { timeout: 20_000 }),
  ]);

  expect(await one.evaluate(() => window.__novaria.online!.rivalName)).toBe('ふたりめ');
  expect(await two.evaluate(() => window.__novaria.online!.rivalName)).toBe('ひとりめ');
  // 降ってくる隕石の順番は両者で同じにしてある
  const board = (page: Page) =>
    page.evaluate(() => window.__novaria.game.ground.map((col) => col.map((m) => m.kind)));
  expect(await board(one)).toEqual(await board(two));
});

test('打ち上げた隕石が相手の惑星に降り、相手の盤面も届く', async ({ browser }) => {
  const [one, two] = await pair(browser);
  await two.evaluate(() => window.__novaria.setColumns([]));
  await one.evaluate((c) => window.__novaria.setColumns(c), LINED_UP);

  await one.waitForFunction(() => window.__novaria.game.launched.dust > 0);
  await two.waitForFunction(
    () => window.__novaria.game.fallings.some((f) => f.meteor.fromAttack),
    null,
    { timeout: 20_000 },
  );
  // 相手の盤面は絵として届く（こちらでは相手の盤面を動かさない）
  expect(await one.evaluate(() => window.__novaria.online!.rival !== null)).toBe(true);
});

test('先に滅亡したほうに「負け」、相手に「勝ち」が出る', async ({ browser }) => {
  const [one, two] = await pair(browser);
  await one.evaluate(() => {
    window.__novaria.game.over = true;
  });
  await expect(one.locator('#overlay h1')).toHaveText('負け', { timeout: 20_000 });
  await expect(two.locator('#overlay h1')).toHaveText('勝ち', { timeout: 20_000 });
  // 得点は「記録」に残さないが、勝ち負けは相手の名前ごとに数える
  await expect(two.locator('#overlay .best')).toHaveText('ひとりめとは通算 1 勝 0 敗');
  await two.getByRole('button', { name: 'メニューへ' }).click();
  await two.getByRole('button', { name: '記録' }).click();
  await expect(two.locator('#menu .panel-body .sub').first()).toContainText('まだ記録がない');
  await expect(
    two.locator('#menu table.result tr').filter({ hasText: 'ひとりめ' }),
  ).toContainText('1 勝 0 敗');
});

test('相手の端末が閉じると中断になる。勝ちにも負けにも数えない', async ({ browser }) => {
  const [one, two] = await pair(browser);
  await two.close();
  await expect(one.locator('#overlay h1')).toHaveText('中断', { timeout: 20_000 });
  await expect(one.locator('#overlay .best')).toHaveCount(0);
  await one.getByRole('button', { name: 'メニューへ' }).click();
  await one.getByRole('button', { name: '記録' }).click();
  await expect(one.locator('#menu .panel-body')).toContainText('まだオンラインで対戦していない');
});

test('対戦の途中でやめると負けになる', async ({ browser }) => {
  const [one, two] = await pair(browser);
  // 得点の並びを触ると「やめる？」が出る。盤面は裏で動いたまま
  const hud = await one.evaluate(() => {
    const { layout } = window.__novaria.view;
    return { x: layout.width / 2, y: layout.hudY + 8 };
  });
  await one.mouse.click(hud.x, hud.y);
  await expect(one.locator('#overlay h1')).toHaveText('やめる？');
  await one.getByRole('button', { name: 'やめる' }).click();
  await expect(one.locator('#overlay h1')).toHaveText('負け', { timeout: 20_000 });
  await expect(two.locator('#overlay h1')).toHaveText('勝ち', { timeout: 20_000 });
});

test('合言葉なしでも、待っている人どうしがつながる', async ({ browser }) => {
  const one = await openPlayer(browser, 'ひとりめ');
  const two = await openPlayer(browser, 'ふたりめ');
  await one.evaluate(() => window.__novaria.startOnline(null));
  await one.waitForFunction(() => window.__novaria.online?.phase === 'waiting');
  await two.evaluate(() => window.__novaria.startOnline(null));
  await Promise.all([
    one.waitForFunction(() => window.__novaria.running, null, { timeout: 20_000 }),
    two.waitForFunction(() => window.__novaria.running, null, { timeout: 20_000 }),
  ]);
  expect(await one.evaluate(() => window.__novaria.online!.rivalName)).toBe('ふたりめ');
});
