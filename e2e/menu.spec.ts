import { type Page, expect, test } from '@playwright/test';
import { BRIGHT_STARS, STAR_LAYERS } from '../src/render/sky';
import { TEST_PLAYER, advance, frame, openFirstTime, openTitle, startGame } from './helpers';

const REPO = 'https://github.com/uphy/novaria';

test('トップメニューに 5 つの項目が並び、先頭が選ばれている', async ({ page }) => {
  await openTitle(page);
  await expect(page.locator('#menu h1')).toHaveText('NOVARIA');
  await expect(page.locator('ul.menu button')).toHaveText([
    '一人用',
    '惑星めぐり',
    '対戦',
    '遊び方',
    '記録',
  ]);
  await expect(page.locator('#menu-start')).toHaveClass(/\bon\b/);
  await expect(page.locator('#menu-how')).not.toHaveClass(/\bon\b/);
  // 選ぶまでゲームは動かない
  expect(await frame(page)).toBe(0);
});

test('上下キーで項目を選び、Enter で決まる', async ({ page }) => {
  await openTitle(page);

  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#menu-tour')).toHaveClass(/\bon\b/);

  // 一番上でさらに上を押すと、一番下へ回り込む
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#menu-records')).toHaveClass(/\bon\b/);

  await page.keyboard.press('Enter');
  await expect(page.locator('#menu h1')).toHaveText('記録');
  expect(await page.evaluate(() => window.__novaria.menu)).toBe('records');
});

test('「遊び方」を開いて「戻る」でトップへ帰る', async ({ page }) => {
  await openTitle(page);
  await page.getByRole('button', { name: '遊び方' }).click();
  await expect(page.locator('#menu h1')).toHaveText('遊び方');
  await expect(page.locator('#menu ul.how li')).toHaveCount(8);

  await page.getByRole('button', { name: '戻る' }).click();
  await expect(page.locator('#menu h1')).toHaveText('NOVARIA');
  expect(await page.evaluate(() => window.__novaria.menu)).toBe('top');
});

test('Escape でも下位の画面からトップへ帰る', async ({ page }) => {
  await openTitle(page);
  await page.getByRole('button', { name: '記録' }).click();
  await expect(page.locator('#menu h1')).toHaveText('記録');
  await page.keyboard.press('Escape');
  await expect(page.locator('#menu h1')).toHaveText('NOVARIA');
});

test('記録が無いうちは案内だけが出る', async ({ page }) => {
  await openTitle(page);
  await page.getByRole('button', { name: '記録' }).click();
  await expect(page.locator('#menu .panel-body .sub').first()).toContainText('まだ記録がない');
  // 表が出るのは対戦の戦績だけ。CPU の 3 段階が、どれも戦っていない印で並ぶ
  await expect(page.locator('#menu table.result')).toHaveCount(1);
  await expect(page.locator('#menu table.result tr')).toHaveCount(3);
  await expect(page.locator('#menu .panel-body')).toContainText('まだオンラインで対戦していない');
});

test('端末に残った記録が「記録」の画面に並ぶ', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'novaria.records.v1',
      JSON.stringify({ score: 12345, launched: 67, maxCombo: 4, seconds: 125 }),
    );
  });
  await openTitle(page);
  await page.getByRole('button', { name: '記録' }).click();

  const rows = page.locator('#menu table.result').first().locator('tr');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('12,345');
  await expect(rows.nth(1)).toContainText('67');
  await expect(rows.nth(2)).toContainText('x4');
  await expect(rows.nth(3)).toContainText('2:05');
});

test('隅にビルド識別子と GitHub リンクが出る', async ({ page }) => {
  await openTitle(page);
  const footer = page.locator('#build');
  await expect(footer).toBeVisible();

  // 「日付 commit の短縮ハッシュ」の形。どの版を触っているかがこれで分かる
  await expect(page.locator('#build-id')).toHaveText(/^\d{4}-\d{2}-\d{2} [0-9a-f]{7,10}$/);

  // 短縮ハッシュはその commit のページへ、GitHub はリポジトリへ飛ぶ
  const rev = (await page.locator('#build-id').innerText()).split(' ')[1];
  await expect(page.locator('#commit-link')).toHaveAttribute('href', `${REPO}/commit/${rev}`);
  await expect(page.locator('#repo-link')).toHaveAttribute('href', REPO);
  await expect(page.locator('#repo-link')).toHaveAttribute('target', '_blank');
  await expect(page.locator('#repo-link')).toHaveAttribute('rel', 'noopener');
});

test('メニューのあいだは盤面を出さず、「一人用」で入れ替わる', async ({ page }) => {
  await openTitle(page);
  // メニューはゲームに重ねるのではなく、canvas と入れ替わる別の画面
  await expect(page.locator('#menu')).toBeVisible();
  await expect(page.locator('canvas#game')).toBeHidden();
  // ゲーム画面の星空と地平線も、canvas と一緒に隠れる
  await expect(page.locator('#backdrop')).toBeHidden();

  await page.getByRole('button', { name: '一人用' }).click();
  await page.waitForFunction(() => window.__novaria.running);
  await expect(page.locator('#menu')).toBeHidden();
  await expect(page.locator('canvas#game')).toBeVisible();
  await expect(page.locator('#backdrop .horizon')).toBeVisible();
  await expect(page.locator('#overlay')).not.toHaveClass(/shown/);
  await expect(page.locator('#build')).toBeHidden();
  expect(await page.evaluate(() => window.__novaria.menu)).toBeNull();

  await advance(page, 60);
  expect(await page.evaluate(() => window.__novaria.game.over)).toBe(false);
});

test('一時停止から「メニューへ」でトップに戻り、隅の表示も戻る', async ({ page }) => {
  await startGame(page);
  await advance(page, 30);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'メニューへ' }).click();

  await expect(page.locator('#menu h1')).toHaveText('NOVARIA');
  await expect(page.locator('canvas#game')).toBeHidden();
  await expect(page.locator('#build')).toBeVisible();
  expect(await page.evaluate(() => window.__novaria.running)).toBe(false);
});

test('一時停止と結果のあいだは盤面が止まる', async ({ page }) => {
  await startGame(page);
  await advance(page, 30);
  await page.keyboard.press('Escape');

  // 止めているあいだはフレームも描画も進めない。全画面を塗り直し続けないため
  const stopped = await frame(page);
  await page.waitForTimeout(400);
  expect(await frame(page)).toBe(stopped);
});

/** 名前を決めた端末で、演出を切らずに開く（openTitle は演出を切ってしまう） */
async function openNamed(page: Page): Promise<void> {
  await page.addInitScript((player) => {
    localStorage.setItem('novaria.player.v1', JSON.stringify(player));
  }, TEST_PLAYER);
  await page.goto('/?seed=7');
  await page.waitForFunction(() => Boolean(window.__novaria));
}

test('トップに星空と惑星の地平線、打ち上がったカタマリが出る', async ({ page }) => {
  await openTitle(page);
  // メニューの絵は canvas ではなく DOM。canvas は隠れたまま
  await expect(page.locator('canvas#game')).toBeHidden();
  await expect(page.locator('#menu .stars')).toHaveCount(STAR_LAYERS);
  // 流れる星空の継ぎ目を隠す写し（.echo）は数えない
  await expect(page.locator('#menu .bright:not(.echo) .star')).toHaveCount(BRIGHT_STARS);
  await expect(page.locator('#menu .planet')).toHaveCount(1);
  // 地平線は正円の上のところ。楕円にすると天辺だけ平らになって、球に見えない
  const planet = await page.evaluate(() => {
    const el = document.querySelector('#menu .planet') as HTMLElement;
    return { w: el.offsetWidth, h: el.offsetHeight };
  });
  expect(planet.w).toBe(planet.h);
  await expect(page.locator('#menu .launch .tile')).toHaveCount(3);
  await expect(page.locator('#menu .panel')).toHaveClass(/\btop\b/);
  // 題字は 1 文字ずつ分けてあるが、読める文字列は変わらない
  await expect(page.locator('#menu h1 i')).toHaveCount(7);
  await expect(page.locator('#menu h1')).toHaveText('NOVARIA');
});

/** いま星空がどれだけ縦にずれているか。演出の最中は上へずれ、終わると 0 に戻る */
async function skyShift(page: Page): Promise<number> {
  return page.evaluate(() => {
    const sky = document.querySelector('#menu .sky')!;
    return new DOMMatrixReadOnly(getComputedStyle(sky).transform).f;
  });
}

test('オープニングでは星空が下へ流れ、触ると最後まで飛ぶ', async ({ page }) => {
  await openFirstTime(page);
  await expect(page.locator('#menu')).toHaveClass(/\bintro\b/);
  // カタマリを追うカメラの見立て。星空は上へずらしてから、下へ流れて元の位置に戻る。
  // 流れ終わる時刻に左右されないよう、流れ始めたところで止めて測る
  const start = await page.evaluate(() => {
    const sky = document.querySelector('#menu .sky')! as HTMLElement;
    const fall = sky.getAnimations().find((a) => (a as CSSAnimation).animationName === 'sky-fall');
    if (!fall) return null;
    fall.pause();
    fall.currentTime = 300;
    return new DOMMatrixReadOnly(getComputedStyle(sky).transform).f;
  });
  expect(start).toBeLessThan(0);

  // 待たされないこと。画面のどこかに触れればその場で完成形になる
  await page.mouse.click(10, 10);
  await expect(page.locator('#menu')).not.toHaveClass(/\bintro\b/);
  expect(await page.evaluate(() => window.__novaria.intro)).toBe(false);
  expect(await skyShift(page)).toBe(0);
});

test('オープニングが終わっても、画面は入り直さない', async ({ page }) => {
  await openNamed(page);
  await expect(page.locator('#menu')).toHaveClass(/\bintro\b/);
  // 開いたときの page-in（0.22 秒）が終わるまで待つ。ここから先は画面が動かないはず
  await page.waitForFunction(() =>
    document
      .querySelector('#menu .panel')!
      .getAnimations()
      .every((a) => a.playState === 'finished'),
  );
  // 演出を終わらせた直後を、間を置かずに測る。ここで page-in が頭から走ると
  // 画面全体が一度消えてから入り直す（＝終わりぎわのちらつき）
  const settled = await page.evaluate(() => {
    const menu = document.querySelector('#menu')!;
    menu.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    const panel = menu.querySelector('.panel')!;
    return { intro: menu.classList.contains('intro'), opacity: getComputedStyle(panel).opacity };
  });
  expect(settled.intro).toBe(false);
  expect(settled.opacity).toBe('1');
});

test('オープニングの最中に押した項目もそのまま効く', async ({ page }) => {
  // 速い端末だと演出が終わってから押してしまうので、CPU を遅くして途中で押す。
  // 押しているあいだに画面が動くと、押し始めた要素と離したときの要素が食い違って
  // click が起きない。手元では出ず、CI の遅い端末でだけ出ていた
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setCPUThrottlingRate', { rate: 8 });
  await openFirstTime(page);
  // 演出が流れている最中に「一人用」を押す。ここで画面が動くと押し損ねる
  await expect(page.locator('#menu')).toHaveClass(/\bintro\b/);
  await page.getByRole('button', { name: '一人用' }).click();
  await page.waitForFunction(() => window.__novaria.running, null, { timeout: 5000 });
});

test('2 回目以降の起動でもオープニングは流れ、放っておいても 3 秒で終わる', async ({ page }) => {
  await openNamed(page);
  await expect(page.locator('#menu')).toHaveClass(/\bintro\b/);
  await page.waitForFunction(() => !window.__novaria.intro, undefined, { timeout: 3000 });
});

test('ゲームから戻ったときはオープニングを流さない', async ({ page }) => {
  await openNamed(page);
  await page.waitForFunction(() => !window.__novaria.intro);

  await page.getByRole('button', { name: '一人用' }).click();
  await page.waitForFunction(() => window.__novaria.running);
  await advance(page, 30);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'メニューへ' }).click();

  await expect(page.locator('#menu h1')).toHaveText('NOVARIA');
  expect(await page.evaluate(() => window.__novaria.intro)).toBe(false);
});

test('動きを減らす設定では演出を流さない', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openNamed(page);
  await expect(page.locator('#menu h1')).toHaveText('NOVARIA');
  expect(await page.evaluate(() => window.__novaria.intro)).toBe(false);
});

test('同じ seed なら同じ盤面から始まる', async ({ page }) => {
  await startGame(page, 12345);
  const first = await page.evaluate(() => window.__novaria.game.ground.map((c) => c.map((m) => m.kind)));
  await startGame(page, 12345);
  const second = await page.evaluate(() => window.__novaria.game.ground.map((c) => c.map((m) => m.kind)));
  expect(second).toEqual(first);
});

test('「記録」はタブで自己ベスト・対戦・ランキングを切り替え、開き直すと最後のタブから出る', async ({ page }) => {
  await openTitle(page);
  await page.getByRole('button', { name: '記録' }).click();
  const tab = (name: string) => page.getByRole('tab', { name });
  await expect(tab('自己ベスト')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#pane-best')).toBeVisible();
  await expect(page.locator('#pane-duels')).toBeHidden();

  await tab('対戦').click();
  await expect(page.locator('#pane-duels')).toBeVisible();
  await expect(page.locator('#pane-best')).toBeHidden();
  await expect(page.locator('#pane-duels')).toContainText('まだオンラインで対戦していない');

  // 左右のキーでも切り替わる
  await page.keyboard.press('ArrowRight');
  await expect(tab('ランキング')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#pane-ranking')).toBeVisible();

  await page.getByRole('button', { name: '戻る' }).click();
  await page.getByRole('button', { name: '記録' }).click();
  await expect(tab('ランキング')).toHaveAttribute('aria-selected', 'true');
});

test('「記録」には設定のボタンを置かず、「名前と公開」に名前・扱う情報・ランキングからの削除をまとめる', async ({ page }) => {
  await openTitle(page);
  await page.getByRole('button', { name: '記録' }).click();
  // 見る画面のボタンは、名前の札と戻るとタブだけ
  await expect(page.getByRole('button', { name: 'ランキングから消す' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '扱う情報' })).toHaveCount(0);
  await expect(page.locator('#menu .panel > button')).toHaveCount(2);

  await page.getByRole('button', { name: '名前と公開' }).click();
  await expect(page.locator('#menu h1')).toHaveText('名前と公開');
  await expect(page.getByRole('button', { name: '名前を変える' })).toBeVisible();
  await expect(page.getByRole('button', { name: '扱う情報' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ランキングから消す' })).toBeVisible();

  // 戻ると「記録」、もう 1 度でトップ
  await page.getByRole('button', { name: '戻る' }).click();
  await expect(page.locator('#menu h1')).toHaveText('記録');
  await page.keyboard.press('Escape');
  await expect(page.locator('#menu h1')).toHaveText('NOVARIA');
});
