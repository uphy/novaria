import { expect, test } from '@playwright/test';
import { openFirstTime, openTitle } from './helpers';

test('トップにお知らせの帯が出て、触るとお知らせが開き、読んだら帯も隅の点も消える', async ({ page }) => {
  await openTitle(page);
  const toast = page.locator('#news-toast');
  await expect(toast).toBeVisible();
  await expect(page.locator('#news-open')).toHaveClass(/unread/);

  await toast.click();
  await expect(page.getByRole('heading', { name: 'お知らせ' })).toBeVisible();
  // 開く前に未読だったものには印が付く
  await expect(page.locator('.news-item .new').first()).toBeVisible();
  await expect(toast).toBeHidden();
  await expect(page.locator('#news-open')).not.toHaveClass(/unread/);

  await page.getByRole('button', { name: '戻る' }).click();
  await expect(page.getByRole('button', { name: '一人用' })).toBeVisible();
  await expect(toast).toBeHidden();
});

test('隅の「お知らせ」からも開ける', async ({ page }) => {
  await openTitle(page);
  await page.locator('#news-open').click();
  await expect(page.getByRole('heading', { name: 'お知らせ' })).toBeVisible();
});

test('遊び始めたら帯は下げる', async ({ page }) => {
  await openTitle(page);
  await expect(page.locator('#news-toast')).toBeVisible();
  await page.getByRole('button', { name: '一人用' }).click();
  await page.waitForFunction(() => window.__novaria.running);
  await expect(page.locator('#news-toast')).toBeHidden();
});

test('一度読んだら、開き直しても帯も点も出ない', async ({ page }) => {
  await openTitle(page);
  await page.locator('#news-toast').click();
  await expect(page.getByRole('heading', { name: 'お知らせ' })).toBeVisible();

  await page.reload();
  await page.waitForFunction(() => Boolean(window.__novaria));
  await expect(page.getByRole('button', { name: '一人用' })).toBeVisible();
  // 帯は少し遅れて出るので、出るはずの時機を過ぎるまで待ってから見る
  await page.waitForTimeout(1000);
  await expect(page.locator('#news-toast')).toBeHidden();
  await expect(page.locator('#news-open')).not.toHaveClass(/unread/);
});

test('初めて開いた人には、前からの変更を新しいとは知らせない', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openFirstTime(page);
  await expect(page.getByRole('button', { name: '一人用' })).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(page.locator('#news-toast')).toBeHidden();
  await expect(page.locator('#news-open')).not.toHaveClass(/unread/);
});
