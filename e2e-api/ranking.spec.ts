/**
 * ランキングの API と、それを出す画面。
 * `pnpm e2e:api` で wrangler dev を立てて回す（`pnpm e2e` の preview では API が無い）。
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SCORE_RULES } from '../src/scores/model';
import type { Ranking, Submission } from '../src/scores/model';

let nextId = 0;
/** 回ごとに別の遊び手にする。前のテストの行と混ざらない */
function userId(): string {
  nextId += 1;
  return `2222${String(nextId).padStart(4, '0')}-1111-4111-8111-111111111111`;
}

function run(over: Partial<Submission> = {}): Submission {
  return {
    userId: userId(),
    name: 'てすと',
    rules: SCORE_RULES,
    score: 1000,
    launched: 10,
    maxCombo: 2,
    seconds: 60,
    ...over,
  };
}

/**
 * 「一人用」を始めて、1 回点火して得点を作ってから積みきって滅亡させる。
 * 降ってきたぶんで別の列が揃わないよう、滅亡するまで同じ盤面を置き直す
 */
async function playAndDie(page: Page): Promise<void> {
  await page.getByRole('button', { name: '一人用' }).click();
  await page.waitForFunction(() => window.__novaria.running);
  await page.evaluate(() => window.__novaria.setColumns([[1], [1], [1]]));
  await page.waitForFunction(() => window.__novaria.game.score > 0);
  const doomed = Array.from({ length: 13 }, (_, i) => (i % 2 === 0 ? 0 : 1));
  await page.evaluate((columns) => {
    const n = window.__novaria;
    const timer = window.setInterval(() => {
      if (n.game.over) {
        window.clearInterval(timer);
        return;
      }
      n.setColumns(columns);
    }, 150);
  }, [doomed, [], [], [], [], [], [], [], []]);
  await page.waitForFunction(() => window.__novaria.game.over, null, { timeout: 30_000 });
}

test('送った得点がランキングに並び、高い順に順位が付く', async ({ request }) => {
  const low = run({ score: 1000, name: 'ひくい' });
  const high = run({ score: 500000, name: 'たかい' });
  expect((await request.post('/api/scores', { data: low })).ok()).toBe(true);
  expect((await request.post('/api/scores', { data: high })).ok()).toBe(true);

  const ranking = (await (await request.get('/api/scores')).json()) as Ranking;
  const names = ranking.scores.map((s) => s.name);
  expect(names.indexOf('たかい')).toBeLessThan(names.indexOf('ひくい'));
  expect(ranking.scores[0].rank).toBe(1);
  expect(ranking.total).toBeGreaterThanOrEqual(2);
});

test('同じ人が何度も送っても 1 行で、自己最高だけが残る', async ({ request }) => {
  const id = userId();
  await request.post('/api/scores', { data: run({ userId: id, score: 30000, maxCombo: 5 }) });
  const best = (await (
    await request.post('/api/scores', { data: run({ userId: id, score: 90000, maxCombo: 9 }) })
  ).json()) as Ranking;
  expect(best.self).toMatchObject({ score: 90000, maxCombo: 9 });

  // 低い得点を送っても、残るのは高いほう
  const after = (await (
    await request.post('/api/scores', { data: run({ userId: id, score: 10, maxCombo: 1 }) })
  ).json()) as Ranking;
  expect(after.self).toMatchObject({ score: 90000, maxCombo: 9 });

  const ranking = (await (await request.get(`/api/scores?self=${id}`)).json()) as Ranking;
  expect(ranking.scores.filter((s) => s.rank === ranking.self?.rank)).toHaveLength(1);
  expect(ranking.self?.score).toBe(90000);
});

test('名前を変えると、ランキングの行の名前も変わる', async ({ request }) => {
  const id = userId();
  await request.post('/api/scores', { data: run({ userId: id, score: 4000, name: 'まえ' }) });
  const renamed = (await (
    await request.post('/api/scores', { data: run({ userId: id, score: 10, name: 'あと' }) })
  ).json()) as Ranking;
  expect(renamed.self).toMatchObject({ name: 'あと', score: 4000 });
});

test('ランキングの表には遊び手の id が出ない', async ({ request }) => {
  // id は本人が名前を変えたり行を消したりする合い鍵。表に出ると他人の行を書き換えられる
  const mine = run({ score: 800000, name: 'かぎ' });
  await request.post('/api/scores', { data: mine });
  const text = await (await request.get('/api/scores')).text();
  const ranking = JSON.parse(text) as Ranking;
  expect(ranking.scores.some((s) => s.name === 'かぎ')).toBe(true);
  expect(text).not.toContain(mine.userId);
  expect(ranking.scores.every((s) => !('userId' in s))).toBe(true);
});

test('自分の行を消すと、版をまたいで消える。おかしな id は断る', async ({ request }) => {
  const id = userId();
  await request.post('/api/scores', { data: run({ userId: id, score: 5000 }) });
  const removed = await request.post('/api/scores/delete', { data: { userId: id } });
  expect(await removed.json()).toEqual({ removed: 1 });
  const ranking = (await (await request.get(`/api/scores?self=${id}`)).json()) as Ranking;
  expect(ranking.self).toBeNull();
  expect((await request.post('/api/scores/delete', { data: { userId: 'x' } })).status()).toBe(400);
  expect((await request.get('/api/scores/delete')).status()).toBe(405);
});

test('おかしな中身は断る', async ({ request }) => {
  expect((await request.post('/api/scores', { data: run({ userId: 'x' }) })).status()).toBe(400);
  expect((await request.post('/api/scores', { data: run({ name: '' }) })).status()).toBe(400);
  expect((await request.post('/api/scores', { data: run({ score: -1 }) })).status()).toBe(400);
  // 得点の付け方を変えたときのために、版が違う得点も断る
  expect((await request.post('/api/scores', { data: run({ rules: 'v0' }) })).status()).toBe(400);
  expect((await request.get('/api/scores?self=x')).status()).toBe(400);
  expect((await request.fetch('/api/scores', { method: 'DELETE' })).status()).toBe(405);
});

test('初めて開くと名前は聞かれず、「記録」から決められる', async ({ page }) => {
  await page.goto('/?seed=7');
  await page.waitForFunction(() => Boolean(window.__novaria));
  await expect(page.locator('#menu h1')).toHaveText('NOVARIA');

  await page.getByRole('button', { name: '記録' }).click();
  await page.getByRole('button', { name: '名前と公開' }).click();
  await page.getByRole('button', { name: '名前を決める' }).click();
  await page.locator('#name-input').fill('なまえのひと');
  await page.getByRole('button', { name: '決める' }).click();
  await expect(page.locator('#menu h1')).toHaveText('名前と公開');

  // id は初めて開いたときに 1 度だけ発行され、名前を決めても開き直しても変わらない
  const saved = await page.evaluate(() => localStorage.getItem('novaria.player.v1'));
  expect(JSON.parse(saved!)).toMatchObject({
    name: 'なまえのひと',
    id: expect.stringMatching(/^[a-f0-9-]{36}$/),
  });
  await page.reload();
  await expect(page.locator('#menu h1')).toHaveText('NOVARIA');
  expect(await page.evaluate(() => localStorage.getItem('novaria.player.v1'))).toBe(saved);
});

test('遊んだ得点がランキングに載り、「記録」から見える', async ({ page, request }) => {
  // 先に別の人の高い得点を入れておく。自分は 2 位以下になる
  await request.post('/api/scores', { data: run({ score: 9000000, name: 'つよいひと' }) });

  await page.goto('/?seed=7');
  await page.waitForFunction(() => Boolean(window.__novaria));
  // 名前は決めずに遊び始める。聞かれるのは結果の画面
  await playAndDie(page);


  // 名前を決めるとその場で送られ、結果に順位が出る
  await expect(page.locator('#rank-line')).toHaveText('名前を決めるとランキングに載る');
  await page.getByRole('button', { name: '名前を決める' }).click();
  await page.locator('#name-input').fill('あそぶひと');
  await page.getByRole('button', { name: '決めて送る' }).click();
  await expect(page.locator('#rank-line')).toContainText(/ランキング \d+ 位 \/ 全 \d+ 人/);

  await page.getByRole('button', { name: 'メニューへ' }).click();
  await page.getByRole('button', { name: '記録' }).click();
  const rows = page.locator('#ranking table.ranking tr');
  await expect(rows.first()).toContainText('つよいひと');
  await expect(page.locator('#ranking tr.me')).toContainText('あそぶひと');
});

test('Safari 16 より前の端末でも、名前を決めて得点を送れる', async ({ page }) => {
  // iOS 16 より前に無い 2 つを落として、同じ流れが通るか見る。
  // どちらも呼んだ時点で例外になるので、名前が決められない／送るたびに失敗する形で出る
  await page.addInitScript(() => {
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true });
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
  });
  await page.goto('/?seed=7');
  await page.waitForFunction(() => Boolean(window.__novaria));

  await page.getByRole('button', { name: '記録' }).click();
  await page.getByRole('button', { name: '名前と公開' }).click();
  await page.getByRole('button', { name: '名前を決める' }).click();
  await page.locator('#name-input').fill('ふるいはし');
  await page.getByRole('button', { name: '決める' }).click();
  await expect(page.locator('#menu h1')).toHaveText('名前と公開');
  // id は端末で作る。randomUUID が無くても UUID の形になる
  const saved = await page.evaluate(() => localStorage.getItem('novaria.player.v1'));
  expect(JSON.parse(saved!).id).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );

  // 「名前と公開」→「記録」→トップへ戻ってから遊ぶ
  await page.getByRole('button', { name: '戻る' }).click();
  await page.getByRole('button', { name: '戻る' }).click();
  await playAndDie(page);

  await expect(page.locator('#rank-line')).toContainText(/ランキング \d+ 位 \/ 全 \d+ 人/);
  // 送れていれば、端末に残しておく必要は無くなる
  expect(await page.evaluate(() => localStorage.getItem('novaria.score.pending.v1'))).toBe('null');
});

test('名前を決めずに遊んだぶんは、あとで「記録」から名前を決めたときに送られる', async ({ page }) => {
  await page.goto('/?seed=7');
  await page.waitForFunction(() => Boolean(window.__novaria));
  await playAndDie(page);

  // 結果の画面では決めずに、メニューへ戻る
  await expect(page.locator('#rank-line')).toHaveText('名前を決めるとランキングに載る');
  await page.getByRole('button', { name: 'メニューへ' }).click();

  await page.getByRole('button', { name: '記録' }).click();
  await expect(page.locator('#ranking')).toContainText('まだ自分の記録は送っていない');
  await page.getByRole('button', { name: '名前と公開' }).click();
  await page.getByRole('button', { name: '名前を決める' }).click();
  await page.locator('#name-input').fill('あとで決めた');
  await page.getByRole('button', { name: '決める' }).click();

  // 取っておいたぶんがここで送られ、ランキングに自分の行が出る
  await page.getByRole('button', { name: '戻る' }).click();
  await expect(page.locator('#ranking tr.me')).toContainText('あとで決めた');
  expect(await page.evaluate(() => localStorage.getItem('novaria.score.pending.v1'))).toBe('null');
});

test('名前を変えると、ランキングに出ている自分の名前が変わる', async ({ page, request }) => {
  const id = '33333333-1111-4111-8111-111111111111';
  await request.post('/api/scores', { data: run({ userId: id, score: 777, name: 'まえのな' }) });
  await page.addInitScript((player) => {
    localStorage.setItem('novaria.player.v1', JSON.stringify(player));
  }, { id, name: 'まえのな' });
  await page.goto('/?seed=7');
  await page.waitForFunction(() => Boolean(window.__novaria));

  await page.getByRole('button', { name: '記録' }).click();
  await expect(page.locator('#ranking tr.me')).toContainText('まえのな');
  await page.getByRole('button', { name: '名前と公開' }).click();
  await page.getByRole('button', { name: '名前を変える' }).click();
  await page.locator('#name-input').fill('あとのな');
  await page.getByRole('button', { name: '決める' }).click();

  await page.getByRole('button', { name: '戻る' }).click();
  await expect(page.locator('#ranking tr.me')).toContainText('あとのな');
});

test('「ランキングから消す」で自分の行が消え、以後は結果を送らない。「ランキングに載せる」で戻せる', async ({
  page,
  request,
}) => {
  const id = '44444444-1111-4111-8111-111111111111';
  await request.post('/api/scores', { data: run({ userId: id, score: 999, name: 'けすひと' }) });
  await page.addInitScript((player) => {
    localStorage.setItem('novaria.player.v1', JSON.stringify(player));
  }, { id, name: 'けすひと' });
  await page.goto('/?seed=7');
  await page.waitForFunction(() => Boolean(window.__novaria));

  await page.getByRole('button', { name: '記録' }).click();
  await expect(page.locator('#ranking tr.me')).toContainText('けすひと');
  // 「記録」には消すボタンを置かない。「名前と公開」のいちばん下にある
  await expect(page.getByRole('button', { name: 'ランキングから消す' })).toHaveCount(0);
  await page.getByRole('button', { name: '名前と公開' }).click();
  // 1 度目は確かめるだけで、まだ消さない
  await page.getByRole('button', { name: 'ランキングから消す' }).click();
  await expect(page.getByRole('button', { name: 'もう一度押すと消える' })).toBeVisible();
  expect(((await (await request.get(`/api/scores?self=${id}`)).json()) as Ranking).self).not.toBeNull();
  await page.getByRole('button', { name: 'もう一度押すと消える' }).click();
  await expect(page.getByText('ランキングに載せない設定になっている')).toBeVisible();
  expect(((await (await request.get(`/api/scores?self=${id}`)).json()) as Ranking).self).toBeNull();

  // 遊んでも送らない（「名前と公開」→「記録」→トップへ戻ってから遊ぶ）
  await page.getByRole('button', { name: '戻る' }).click();
  await page.getByRole('button', { name: '戻る' }).click();
  await playAndDie(page);
  await expect(page.getByText('ランキングには載せない設定')).toBeVisible();
  expect(((await (await request.get(`/api/scores?self=${id}`)).json()) as Ranking).self).toBeNull();

  // 戻すと、次に遊んだぶんから載る
  await page.getByRole('button', { name: 'メニューへ' }).click();
  await page.getByRole('button', { name: '記録' }).click();
  await page.getByRole('button', { name: '名前と公開' }).click();
  await page.getByRole('button', { name: 'ランキングに載せる' }).click();
  await expect(page.getByRole('button', { name: 'ランキングから消す' })).toBeVisible();
  await page.getByRole('button', { name: '戻る' }).click();
  await page.getByRole('button', { name: '戻る' }).click();
  await playAndDie(page);
  await expect(page.locator('#rank-line')).toContainText('位');
  expect(((await (await request.get(`/api/scores?self=${id}`)).json()) as Ranking).self).not.toBeNull();
});

test('「扱う情報」は「記録」→「名前と公開」から開けて、戻ると「名前と公開」に戻る', async ({ page }) => {
  await page.goto('/?seed=7');
  await page.waitForFunction(() => Boolean(window.__novaria));
  await page.getByRole('button', { name: '記録' }).click();
  await page.getByRole('button', { name: '名前と公開' }).click();
  await page.getByRole('button', { name: '扱う情報' }).click();
  await expect(page.locator('h1')).toHaveText('扱う情報');
  await expect(page.getByText('IP アドレスそのものは残さない')).toBeVisible();
  await page.getByRole('button', { name: '戻る' }).click();
  await expect(page.locator('h1')).toHaveText('名前と公開');
});
