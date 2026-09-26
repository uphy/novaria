/**
 * 名前と遊び手の id。ランキングそのものは Worker が要るので `pnpm e2e:api` で見る。
 * ここでは「名前を決めていなくても遊べる」「要るところで決められる」ことを確かめる
 */
import { expect, test } from '@playwright/test';
import { NAME_MAX } from '../src/scores/model';
import { annihilate, openFirstTime, openTitle } from './helpers';

/** 端末に置いてある遊び手 */
function stored(page: import('@playwright/test').Page): Promise<{ id: string; name: string }> {
  return page.evaluate(
    () => JSON.parse(localStorage.getItem('novaria.player.v1')!) as { id: string; name: string },
  );
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

test('初めて開いても名前は聞かれず、id だけが発行される', async ({ page }) => {
  await openFirstTime(page);
  await expect(page.locator('#menu h1')).toHaveText('NOVARIA');
  expect(await page.evaluate(() => window.__novaria.menu)).toBe('top');

  const saved = await stored(page);
  expect(saved.id).toMatch(UUID);
  expect(saved.name).toBe('');

  // 名前が無くてもそのまま遊び始められる
  await page.getByRole('button', { name: '一人用' }).click();
  await page.waitForFunction(() => window.__novaria.running);
});

test('開き直しても id は変わらない', async ({ page }) => {
  await openFirstTime(page);
  const first = await stored(page);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__novaria));
  expect((await stored(page)).id).toBe(first.id);
});

test('「記録」→「名前と公開」から名前を決められ、id はそのまま', async ({ page }) => {
  await openFirstTime(page);
  const before = await stored(page);

  await page.getByRole('button', { name: '記録' }).click();
  await expect(page.locator('#to-settings')).toContainText('名前はまだ無い');
  await page.getByRole('button', { name: '名前と公開' }).click();
  await page.getByRole('button', { name: '名前を決める' }).click();
  await expect(page.locator('#menu h1')).toHaveText('名前');

  // 空のままでは決まらない。その場に案内が出る
  await page.locator('#name-input').fill('  ');
  await page.getByRole('button', { name: '決める' }).click();
  await expect(page.locator('#name-error')).toBeVisible();
  await expect(page.locator('#menu h1')).toHaveText('名前');

  await page.locator('#name-input').fill('ほしのひと');
  await page.getByRole('button', { name: '決める' }).click();
  // 決めたら「名前と公開」に帰り、決めた名前が出る
  await expect(page.locator('#menu h1')).toHaveText('名前と公開');
  await expect(page.locator('#menu .setting-now').first()).toHaveText('ほしのひと');

  const after = await stored(page);
  expect(after).toEqual({ id: before.id, name: 'ほしのひと' });
});

test('名前の画面は「戻る」で閉じられる', async ({ page }) => {
  await openFirstTime(page);
  await page.getByRole('button', { name: '記録' }).click();
  await page.getByRole('button', { name: '名前と公開' }).click();
  await page.getByRole('button', { name: '名前を決める' }).click();
  await page.getByRole('button', { name: '戻る' }).click();
  await expect(page.locator('#menu h1')).toHaveText('名前と公開');
  expect((await stored(page)).name).toBe('');
});

test('長すぎる名前は入れられる分だけに切られる', async ({ page }) => {
  await openTitle(page);
  await page.getByRole('button', { name: '記録' }).click();
  await page.getByRole('button', { name: '名前と公開' }).click();
  await page.getByRole('button', { name: '名前を変える' }).click();
  await page.locator('#name-input').fill('あ'.repeat(NAME_MAX + 8));
  await page.getByRole('button', { name: '決める' }).click();
  await expect(page.locator('#menu h1')).toHaveText('名前と公開');
  expect(Array.from((await stored(page)).name)).toHaveLength(NAME_MAX);
});

test('「記録」→「名前と公開」から名前を変えられる', async ({ page }) => {
  await openTitle(page);
  await page.getByRole('button', { name: '記録' }).click();
  await expect(page.locator('#to-settings')).toContainText('てすと');
  await page.getByRole('button', { name: '名前と公開' }).click();
  await page.getByRole('button', { name: '名前を変える' }).click();
  await expect(page.locator('#menu h1')).toHaveText('名前');
  await expect(page.locator('#name-input')).toHaveValue('てすと');

  await page.locator('#name-input').fill('あたらしいな');
  await page.getByRole('button', { name: '決める' }).click();
  await expect(page.locator('#menu h1')).toHaveText('名前と公開');
  expect((await stored(page)).name).toBe('あたらしいな');
});

test('名前を決めずに遊ぶと、結果の画面から決められる', async ({ page }) => {
  await openFirstTime(page);
  await page.getByRole('button', { name: '一人用' }).click();
  await page.waitForFunction(() => window.__novaria.running);
  await annihilate(page);

  await expect(page.locator('#rank-line')).toHaveText('名前を決めるとランキングに載る');
  // 送れるようになるまで、この回のぶんは端末に取ってある
  const held = await page.evaluate(() => localStorage.getItem('novaria.score.pending.v1'));
  expect(JSON.parse(held!)).toMatchObject({ name: '', score: expect.any(Number) });

  await page.getByRole('button', { name: '名前を決める' }).click();
  await page.locator('#name-input').fill('あとからのひと');
  await page.getByRole('button', { name: '決めて送る' }).click();

  expect((await stored(page)).name).toBe('あとからのひと');
  // preview には API が無いので送れない。結果の画面は閉じず、次の機会に送り直す
  await expect(page.locator('#rank-line')).toContainText('送れなかった');
  await expect(page.getByRole('button', { name: 'もう一度' })).toBeVisible();
});

test('オンラインを選ぶと名前を聞かれ、決めるとそのまま相手を探しに行く', async ({ page }) => {
  await openFirstTime(page);
  await page.getByRole('button', { name: '対戦' }).click();
  await page.getByRole('button', { name: 'オンライン' }).click();
  await page.getByRole('button', { name: '相手を探す' }).click();
  // 相手の画面に名前が出るので、ここで初めて聞かれる
  expect(await page.evaluate(() => window.__novaria.menu)).toBe('name');

  await page.locator('#name-input').fill('たいせんのひと');
  await page.getByRole('button', { name: '決める' }).click();
  // 決めたら、押したところの続きに戻る（preview には Worker が無いのでつながらない）
  await page.waitForFunction(() => window.__novaria.menu === 'waiting');
});

test('ランキングに届かなくても、案内が出るだけで遊べる', async ({ page }) => {
  await openTitle(page);
  await page.getByRole('button', { name: '記録' }).click();
  // preview には API が無いので、ここは必ず届かない側に落ちる
  await expect(page.locator('#ranking')).toContainText('今は見られない');

  await page.getByRole('button', { name: '戻る' }).click();
  await page.getByRole('button', { name: '一人用' }).click();
  await page.waitForFunction(() => window.__novaria.running);
});
