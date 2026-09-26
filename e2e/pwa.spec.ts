import { expect, test } from '@playwright/test';
import { openTitle } from './helpers';

test('manifest がホーム画面に置ける形になっている', async ({ page }) => {
  await openTitle(page);
  const href = await page.locator('link[rel=manifest]').getAttribute('href');
  expect(href).toBeTruthy();

  const res = await page.request.get(new URL(href!, page.url()).toString());
  expect(res.ok()).toBe(true);
  const manifest = await res.json();
  expect(manifest).toMatchObject({
    name: 'NOVARIA',
    display: 'standalone',
    background_color: '#05030f',
  });

  // 192・512・maskable の 3 枚。Android はこの 3 枚でホーム画面の絵を決める
  const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
  expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
  expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);

  for (const icon of manifest.icons) {
    const img = await page.request.get(new URL(icon.src, res.url()).toString());
    expect(img.ok(), `${icon.src} が取れない`).toBe(true);
  }
});

test('iOS 用のホーム画面の絵と題字がある', async ({ page }) => {
  await openTitle(page);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    'href',
    '/icons/apple-touch-icon.png',
  );
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute(
    'content',
    'NOVARIA',
  );
  const icon = await page.request.get('/icons/apple-touch-icon.png');
  expect(icon.ok()).toBe(true);
});

test('起動したときと、画面に戻ってきたときに新しい版を見に行く', async ({ page }) => {
  await openTitle(page);
  // Service Worker の登録が済んだところで 1 度目
  await page.waitForFunction(() => window.__novaria.updateChecks >= 1, null, { timeout: 20_000 });
  const first = await page.evaluate(() => window.__novaria.updateChecks);

  // ホーム画面から戻ってきたとき（裏に回っていた PWA が表に出たとき）にも見に行く
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect
    .poll(() => page.evaluate(() => window.__novaria.updateChecks))
    .toBeGreaterThan(first);
});

test('Service Worker が動いて、一度開けばオフラインでも遊べる', async ({ page, context }) => {
  await openTitle(page);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 20_000,
  });
  expect(context.serviceWorkers().length).toBeGreaterThan(0);

  // 回線を切っても、precache から同じ画面が出る
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#menu h1')).toHaveText('NOVARIA');
  await context.setOffline(false);
});

test('起動してメニューにいるときに新版が見つかったら、取り終えるまで待たせてすぐ入れ替える', async ({ page }) => {
  await openTitle(page);
  await page.evaluate(() => window.__novaria.fakeUpdate('downloading'));
  await expect(page.locator('#updating')).toBeVisible();
  // 待っているあいだはメニューを触れない（モードを選んだ瞬間に読み込み直されないように）
  await page.getByRole('button', { name: '一人用' }).click({ force: true, timeout: 2000 }).catch(() => {});
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.__novaria.running)).toBe(false);
  expect(await page.evaluate(() => window.__novaria.menu)).toBe('top');

  await page.evaluate(() => window.__novaria.fakeUpdate('ready'));
  expect(await page.evaluate(() => window.__novaria.updatesApplied)).toBe(1);
});

test('取りきれなかったら待つのをやめて、そのまま遊べる', async ({ page }) => {
  await openTitle(page);
  await page.evaluate(() => window.__novaria.fakeUpdate('downloading'));
  await expect(page.locator('#updating')).toBeVisible();
  await page.evaluate(() => window.__novaria.fakeUpdate('failed'));
  await expect(page.locator('#updating')).toBeHidden();
  await page.getByRole('button', { name: '一人用' }).click();
  await page.waitForFunction(() => window.__novaria.running);
});

test('遊んでいるあいだに見つかった新版は、トップメニューに戻るまで入れ替えない', async ({ page }) => {
  await openTitle(page);
  await page.getByRole('button', { name: '一人用' }).click();
  await page.waitForFunction(() => window.__novaria.running);
  await page.evaluate(() => {
    window.__novaria.fakeUpdate('downloading');
    window.__novaria.fakeUpdate('ready');
  });
  await expect(page.locator('#updating')).toBeHidden();
  expect(await page.evaluate(() => window.__novaria.updatesApplied)).toBe(0);

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'メニューへ' }).click();
  await expect.poll(() => page.evaluate(() => window.__novaria.updatesApplied)).toBe(1);
});

test('後回しにした新版は、メニューにいるときにアプリが裏へ回ったら入れ替える', async ({ page }) => {
  await openTitle(page);
  await page.getByRole('button', { name: '記録' }).click();
  // 待たせる時間を越えたなどで、取り終えたときには待たせていなかった
  await page.evaluate(() => window.__novaria.fakeUpdate('ready'));
  expect(await page.evaluate(() => window.__novaria.updatesApplied)).toBe(0);

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await page.evaluate(() => window.__novaria.updatesApplied)).toBe(1);
});

test('新版に入れ替えて読み込み直したあとは、オープニングを流さず新版にしたことを知らせる', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('novaria.player.v1', JSON.stringify({ id: '11111111-1111-4111-8111-111111111111', name: 'てすと' }));
    sessionStorage.setItem('novaria.updated', '1');
  });
  await page.goto('/?seed=7');
  await page.waitForFunction(() => Boolean(window.__novaria));
  expect(await page.evaluate(() => window.__novaria.intro)).toBe(false);
  // お知らせがあれば、新版にしたことはその帯で伝える
  await expect(page.locator('#news-toast')).toBeVisible();
  // 印は 1 度読んだら消える
  expect(await page.evaluate(() => sessionStorage.getItem('novaria.updated'))).toBeNull();
});
