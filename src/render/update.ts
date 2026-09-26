import { registerSW } from 'virtual:pwa-register';

/** Service Worker の登録。新版を見に行くのに使う */
let registration: ServiceWorkerRegistration | null = null;

/**
 * 新版を見に行った回数。
 * 起動したときと画面に戻ってきたときに増える。e2e がここを数える
 */
let checks = 0;

export function updateCheckCount(): number {
  return checks;
}

/** 新版に入れ替えて読み込み直したことを、読み込み直したあとのページに伝える印 */
const UPDATED_KEY = 'novaria.updated';

/**
 * 新版の知らせ。どこで待たせ、いつ入れ替えるかは呼ぶ側（`main.ts`）が決める。
 * - downloading: 新版があると分かり、取り始めた。取り終えるまで数秒かかる（曲も含めて 2MB ほど）
 * - ready: 取り終えた。`apply` を呼ぶとページが読み込み直されて新版になる
 * - failed: 取りきれなかった（電波が切れたなど）。次に起動したときにまた見に行く
 */
export interface UpdateHooks {
  downloading(): void;
  ready(apply: () => void): void;
  failed(): void;
}

/**
 * Service Worker を登録し、起動のたびに新版を見に行く。起動のときに 1 度だけ呼ぶ。
 *
 * ホーム画面に置いた PWA は、閉じずに裏へ回っているだけのことが多い。
 * 登録のときの確認だけだと、何日も前の版のまま遊び続けることになるので、
 * 画面に戻ってきたときにも見に行く。
 *
 * 新版があるかどうかは 1 往復（0.3 秒ほど）で分かるが、取り終えるまでには数秒かかる。
 * 以前は取り終えた瞬間にトップメニューにいれば読み込み直していて、起動して 3〜5 秒後、
 * ちょうどモードを選ぶあたりで画面が読み込み直されていた。
 * いまは「取り始めた」ことを先に知らせ、呼ぶ側が待たせるか後回しにするかを決める
 */
export function setUpUpdates(hooks: UpdateHooks): void {
  const updateSW = registerSW({
    // ページの読み込みが終わるのを待たずに登録する。新版があるかを少しでも早く知るため
    immediate: true,
    onNeedRefresh() {
      hooks.ready(() => {
        // 新版が画面を握ったら読み込み直す。workbox-window にも読み込み直しの合図（onNeedReload）が
        // あるが、初めて開いたページ（登録のときにまだ Service Worker が握っていなかった）では
        // 合図が来ず、新版に替わったのに古い画面のまま残っていた。握り替わりを自分で見る
        navigator.serviceWorker.addEventListener('controllerchange', reloadAsUpdated);
        void updateSW(true);
      });
    },
    onNeedReload: reloadAsUpdated,
    onRegisteredSW(_url, reg) {
      registration = reg ?? null;
      if (reg) watchInstalls(reg, hooks);
      checkForUpdate();
    },
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });
}

let reloading = false;

/** 新版に入れ替えて読み込み直す。読み込み直したあとのページに印を残す（オープニングを飛ばすため） */
function reloadAsUpdated(): void {
  if (reloading) return;
  reloading = true;
  try {
    sessionStorage.setItem(UPDATED_KEY, '1');
  } catch {
    // 残せなくても読み込み直しはする。オープニングがもう 1 度流れるだけ
  }
  window.location.reload();
}

/**
 * 新版を取り始めたことを知らせる。初めて開いたとき（まだ Service Worker が画面を握っていない）の
 * インストールは新版ではないので数えない
 */
function watchInstalls(reg: ServiceWorkerRegistration, hooks: UpdateHooks): void {
  const watch = (sw: ServiceWorker | null): void => {
    if (!sw || !navigator.serviceWorker.controller) return;
    hooks.downloading();
    sw.addEventListener('statechange', () => {
      if (sw.state === 'redundant') hooks.failed();
    });
  };
  // 登録より先に取り始めていることがある（ブラウザは登録のときにも見に行く）
  watch(reg.installing);
  reg.addEventListener('updatefound', () => watch(reg.installing));
}

/**
 * 新版が出ていないかを見に行く。
 * 置き場は `Cache-Control: max-age=0, must-revalidate` を返すので、
 * 変わっていなければ 304 が返るだけで、通信はほとんど起きない
 */
function checkForUpdate(): void {
  if (!registration) return;
  checks++;
  void registration.update().catch(() => {
    // 電波が届かないときは何もしない。次に起動したときにまた見に行く
  });
}

/**
 * 新版に入れ替えて読み込み直した直後か。1 度読んだら印を消す。
 * 読み込み直したあとはオープニングを流さず、新版にしたことだけを小さく知らせる
 */
export function takeUpdatedMark(): boolean {
  try {
    const marked = sessionStorage.getItem(UPDATED_KEY) === '1';
    sessionStorage.removeItem(UPDATED_KEY);
    return marked;
  } catch {
    return false;
  }
}
