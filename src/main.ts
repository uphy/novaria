import { Game, type Events } from './core/game';
import { NOVARIA, SCORE, SCREEN_OUT_ROW, VISIBLE_ROWS } from './core/constants';
import { CpuLevel } from './core/cpu';
import { Hinter } from './core/hint';
import { TOUR } from './core/planets';
import { Tour } from './core/tour';
import { Versus } from './core/versus';
import { Kind, type Meteor } from './core/types';
import { GameAudio } from './render/audio';
import { DUSK_STEPS, Effects, GRAND_BOOM } from './render/effects';
import { UI } from './render/theme';
import {
  cpuDuelKey,
  findDuel,
  loadDuels,
  loadRecords,
  loadTourRecords,
  onlineDuelKey,
  recordDuel,
  saveRecords,
  saveTourRecords,
  type Duel,
  type Opponent,
} from './render/records';
import {
  ensureUserId,
  fetchRanking,
  hasUserId,
  flushPending,
  holdScore,
  joinRanking,
  leaveRanking,
  loadPlayer,
  rankingEnabled,
  renamePlayer,
  savePlayer,
  submitScore,
  type Player,
} from './scores/client';
import { NAME_MAX, type RankedScore, type Ranking } from './scores/model';
import { OnlineMatch, type OnlineOutcome } from './online/match';
import { CODE_MAX, normalizeCode } from './online/protocol';
import { openMatchSocket } from './online/socket';
import { backdropHtml, skyHtml } from './render/sky';
import { NEWS, isUnread, markNewsRead, unreadNews } from './render/news';
import { setUpUpdates, takeUpdatedMark, updateCheckCount } from './render/update';
import { knowsRareMetal, learnRareMetal } from './render/tips';
import { View } from './render/view';

const canvas = document.getElementById('game') as HTMLCanvasElement;
/** トップメニューの画面。ゲームの canvas とは入れ替わりで出る */
const menuEl = document.getElementById('menu') as HTMLDivElement;
/** 一時停止と結果。こちらは止まった盤面の上に重ねる */
const overlay = document.getElementById('overlay') as HTMLDivElement;
// ゲーム画面の星空と地平線。1 度だけ組んで、あとは触らない（canvas が隠れると一緒に消える）
document.getElementById('backdrop')!.innerHTML = backdropHtml();
const buildFooter = document.getElementById('build') as HTMLElement;

/** overlay にいま出しているもの。戻る操作の行き先を決めるのに見る */
type OverlayKind = 'pause' | 'quit' | 'result' | 'escape';
let overlayKind: OverlayKind | null = null;

/** overlay を片付ける */
function closeOverlay(): void {
  overlayKind = null;
  overlay.classList.remove('shown');
  overlay.innerHTML = '';
}

const view = new View(canvas);
const fx = new Effects();
const audio = new GameAudio();

/**
 * 毎回ちがう盤面で始める。`?seed=7` を付けたときだけその seed に固定する。
 * 同じ seed と同じ操作なら同じ結果になるので、e2e と不具合の再現に使う。
 */
function nextSeed(): number {
  const q = Number(new URLSearchParams(location.search).get('seed'));
  if (Number.isInteger(q) && q > 0) return q & 0x7fffffff;
  return (Date.now() & 0x7fffffff) || 1;
}

let game = new Game({ seed: nextSeed() });
/** CPU と対戦しているときだけ入る。`game` はこの中の自分の盤面を指す */
let versus: Versus | null = null;
/** 惑星めぐりのときだけ入る。`game` はこの中のいまの惑星の盤面を指す */
let tour: Tour | null = null;
/** オンライン対戦。相手を探しているあいだも入っている（盤面が出るのは相手が見つかってから） */
let online: OnlineMatch | null = null;
let running = false;
let paused = false;
/** 決着して結果を出す待ちか */
let ending = false;
/**
 * 対戦の決着の演出。決着の瞬間に盤面を止め（ヒットストップ）、スローで流し、
 * 帯を読み終えてから結果の画面を出す。演出のあいだは null 以外
 */
let finale: { t: number; outcome: 'win' | 'lose' | 'draw'; len: number } | null = null;
/** 決着の瞬間の、双方の盤面の余裕。結果の画面で「あと何段だった」を出すのに使う */
let margin: { mine: number; mineDanger: boolean; rival: number; rivalDanger: boolean } | null = null;
/** 前のフレームに危ない列があったか。警告が出た瞬間だけ揺らすのに使う */
let wasDanger = false;
/** 前のフレームに予兆の列があったか。予兆が出た瞬間だけ振動させるのに使う */
let wasWarn = false;
let boostHeld = false;
/**
 * 練習のヒントを出すか。一時停止の画面で切り替える。
 * 次のゲームには持ち越さず、始めるたびに消す（つけたまま忘れて、記録に残らないゲームを続けないように）。
 * 惑星めぐりは惑星を渡っても同じゲームなので、渡るときには消さない
 */
let hintOn = false;
/** いまのゲームで 1 度でもヒントをつけたか。つけたゲームは途中で消しても記録にもランキングにも残さない */
let hintUsed = false;
const hinter = new Hinter();

/** いまヒントを出すか。対戦（CPU 戦もオンラインも）では出さない */
function hinting(): boolean {
  return hintOn && versus === null && online === null;
}

/** ヒントを使うときに選べるゲームの速さ。右（最後）が通常。25 % より遅いと落ちる様子がほぼ止まって見える */
const HINT_SPEEDS = [0.25, 0.4, 0.6, 0.8, 1] as const;
/**
 * ヒントを使うときのゲームの速さ（`HINT_SPEEDS` の添字）。ゆっくり考えながら練習するため。
 * 端末には残さないが、開いているあいだは覚えておき、次にヒントをつけたときもこの速さで始める。
 * ヒントを消しているあいだは通常の速さで動く（記録に残るゲームを遅くしない）
 */
let hintSpeedIndex = HINT_SPEEDS.length - 1;

/** いまのゲームの速さ。1 が通常 */
function timeScale(): number {
  return hinting() ? HINT_SPEEDS[hintSpeedIndex] : 1;
}

function speedLabel(): string {
  return `×${HINT_SPEEDS[hintSpeedIndex]}`;
}

/** 最後に帯で知らせたレベルの節目（20 ごと）。盤面が替わると 0 に戻す */
let levelMark = 0;
/** レベルの節目。ここを越えたら帯の見出しを出す */
const LEVEL_STEP = 20;

view.resize(game.cols);

/**
 * 画面の大きさが変わったら配置を作り直す。
 * 止めているあいだ（一時停止・結果）は描画のループが回っていないので、ここで 1 枚だけ描き直す
 */
/** 盤面を 1 枚描く。対戦なら相手のミニ盤面、惑星めぐりなら脱出ゲージも一緒に出す */
function drawFrame(): void {
  view.draw(
    game,
    fx,
    boostHeld,
    versus?.rival ?? online?.rival,
    online?.rivalName,
    tour ? { label: tour.stage.planet.label, launched: tour.launched, goal: tour.stage.goal } : null,
    hinting() ? { arrow: hinter.arrow(game), speed: timeScale() } : null,
  );
}

function onResize(): void {
  view.resize(game.cols);
  if (!canvas.hidden && (!running || paused)) drawFrame();
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', () => setTimeout(onResize, 200));

// ------------------------------------------------------------------ 入力

/**
 * 指で隕石を掴み、列の中で上下に運ぶ。指ごとに別の列を掴めるので、両手で 2 列を同時に運べる。
 * 原作はタッチペンで同じ列の中だけを動かす操作なので、左右の移動は無視する。
 */
interface Touch {
  id: number;
  lastY: number;
  /** 加速の帯を押している指か */
  boost: boolean;
  /** 掴んでから 1 マスでも動かしたか。離したときの音に使う */
  moved: boolean;
}
const touches = new Map<number, Touch>();

function pointerPos(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  audio.unlock();
  if (!running) return;
  // 決着の演出のあいだは盤面を触らせない。触れば結果の画面へ飛ばす
  if (finale) {
    skipFinale();
    return;
  }
  canvas.setPointerCapture(e.pointerId);
  const { x, y } = pointerPos(e);

  if (view.inBoost(x, y)) {
    touches.set(e.pointerId, { id: e.pointerId, lastY: y, boost: true, moved: false });
    boostHeld = true;
    return;
  }
  if (view.inHud(x, y)) {
    showPause();
    return;
  }
  const { col, row } = view.toBoard(x, y);
  if (game.grab(col, row, e.pointerId)) audio.grab(game.drags.get(e.pointerId)!.kind);
  touches.set(e.pointerId, { id: e.pointerId, lastY: y, boost: false, moved: false });
});

canvas.addEventListener('pointermove', (e) => {
  const t = touches.get(e.pointerId);
  if (!t || t.boost) return;
  e.preventDefault();
  const { y } = pointerPos(e);
  const dy = t.lastY - y; // 画面の上へ動かすと row が増える
  t.lastY = y;
  // 入れ替わった相手の滑りは、次の tick を待たずにここで始める（`Game.dragBy` の説明を見る）
  for (const m of game.dragBy(dy / view.layout.cell, e.pointerId)) fx.slide(m.swapped, m.up);
});

function endTouch(e: PointerEvent): void {
  const t = touches.get(e.pointerId);
  if (!t) return;
  touches.delete(e.pointerId);
  if (t.boost) {
    boostHeld = [...touches.values()].some((o) => o.boost);
  } else {
    const drag = game.drags.get(t.id);
    if (drag) audio.release(drag.kind, t.moved);
    game.release(t.id);
  }
}
canvas.addEventListener('pointerup', endTouch);
canvas.addEventListener('pointercancel', endTouch);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// キーボードでも遊べるようにしておく（PC での確認用）
window.addEventListener('keydown', (e) => {
  // 新版を取り終えるのを待たせているあいだは、メニューを動かさない
  if (!updatingEl.hidden) return;
  if (menuPage !== null) {
    onMenuKey(e);
    return;
  }
  if (finale) {
    skipFinale();
    return;
  }
  if (e.key === 'Shift') boostHeld = true;
  if (e.key === 'p' || e.key === 'Escape') showPause();
});

/** メニューを出しているあいだの上下と決定。指で触るのと同じところへ行ける */
function onMenuKey(e: KeyboardEvent): void {
  // 何かキーが来た時点でオープニングは飛ばす。押した操作自体はこのあとそのまま通す
  settleIntro();
  // 名前を打っている最中の Backspace や Escape は、文字を消すためのもの
  if (e.target instanceof HTMLInputElement) return;
  if (menuPage !== 'top') {
    if (e.key === 'Escape' || e.key === 'Backspace') {
      e.preventDefault();
      showMenu(parentPage(menuPage ?? 'top'));
    }
    // 「記録」のタブは左右で切り替える
    if (menuPage === 'records' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      const i = RECORDS_TABS.findIndex((t) => t.id === recordsTab);
      const next = RECORDS_TABS[(i + (e.key === 'ArrowRight' ? 1 : RECORDS_TABS.length - 1)) % RECORDS_TABS.length];
      audio.ui('select');
      showRecordsTab(next.id);
    }
    return;
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    moveCursor(menuIndex + (e.key === 'ArrowDown' ? 1 : -1));
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    audio.unlock();
    audio.ui('confirm');
    MENU_ITEMS[menuIndex].run();
  }
}
window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') boostHeld = false;
});

// ------------------------------------------------------------------ 戻る操作

/**
 * Android の戻る（画面の端からのスワイプ・戻るボタン）で、遊んでいる途中に
 * 画面ごと閉じてしまわないようにする。
 * ホーム画面から開いた PWA は履歴が空なので、何もしないと 1 回の戻るでゲームが終わる。
 * トップメニューより先へ進むあいだは履歴を 1 つ積んでおき、戻ってきたぶんを
 * 一時停止や 1 つ前の画面に使う
 */
let historyGuard = false;

/** トップメニューより先（遊んでいる最中・下位の画面）へ進むときに 1 つ積む */
function pushHistoryGuard(): void {
  if (historyGuard) return;
  history.pushState({ novaria: 'guard' }, '');
  historyGuard = true;
}

/**
 * 自分でトップメニューへ戻るときは、積んだぶんも戻しておく。
 * 残したままだと、トップで戻ってもアプリを閉じられない
 */
function dropHistoryGuard(): void {
  if (!historyGuard) return;
  // 先に下ろしてから戻す。この back で来る popstate は自分のぶんなので、
  // onBack が「遊び手が戻った」と取り違えないようにする
  historyGuard = false;
  history.back();
}

/**
 * 戻るが来たときの行き先。
 * 遊んでいる最中 → 一時停止、一時停止と結果 → メニュー、メニューの下位画面 → 1 つ前、
 * トップ → 積んだぶんがもう無いので、そのままアプリが閉じる
 */
function onBack(): void {
  if (!historyGuard) return;
  historyGuard = false;
  if (menuPage === null) {
    if (overlayKind === null) {
      // 盤面から出ないので、次の戻るのぶんを積み直してから止める
      pushHistoryGuard();
      showPause();
      return;
    }
    if (overlayKind === 'quit') {
      // オンラインの「やめる？」では、戻るを「続ける」と同じ扱いにする。
      // 勢いで戻って負けになると取り返しがつかない
      pushHistoryGuard();
      closeOverlay();
      return;
    }
    showMenu('top');
    return;
  }
  // メニューの下位画面は「戻る」と同じ行き先へ
  showMenu(parentPage(menuPage));
}
window.addEventListener('popstate', onBack);

// ------------------------------------------------------------------ 画面の隅

const REPO_URL = 'https://github.com/uphy/novaria';

/**
 * いま動いている版を画面の隅に出す。
 * プレビューをスマホで開いたとき、どの commit の版を触っているかをここで確かめる。
 * `__BUILD_ID__` は「日付 commit」の形（git が使えないビルドでは commit の代わりに dev）
 */
function setUpBuildFooter(): void {
  const rev = __BUILD_ID__.split(' ')[1] ?? '';
  const label = document.getElementById('build-id')!;
  if (/^[0-9a-f]{7,40}$/.test(rev)) {
    // その commit の GitHub のページへ飛べるようにする
    label.innerHTML = `<a id="commit-link" href="${REPO_URL}/commit/${rev}" target="_blank" rel="noopener"></a>`;
    label.querySelector('a')!.textContent = __BUILD_ID__;
  } else {
    label.textContent = __BUILD_ID__;
  }
}

/**
 * 音の入り切り。隅に置いて、メニューのあいだだけ触れるようにする。
 * iOS はマナーモードでも Web の音が止まるので、こちらで切れるのは「うるさい」ときのため
 */
function setUpMuteButton(): void {
  const button = document.getElementById('mute')!;
  const label = (): void => {
    button.textContent = audio.muted ? '音 なし' : '音 あり';
  };
  button.addEventListener('click', () => {
    audio.unlock();
    audio.muted = !audio.muted;
    label();
    if (!audio.muted) audio.ui('confirm');
  });
  label();
}

/** メニューを出しているあいだだけ、隅のビルド識別子と GitHub リンクを見せる */
function showBuildFooter(shown: boolean): void {
  buildFooter.hidden = !shown;
}

// ------------------------------------------------------------------ メニュー

/** トップメニューと、そこから開く下位の画面 */
type MenuPage =
  | 'top'
  | 'name'
  | 'tour'
  | 'versus'
  | 'online'
  | 'waiting'
  | 'how'
  | 'records'
  | 'settings'
  | 'privacy'
  | 'news';

/** メニューを出していないとき（遊んでいる最中・一時停止・結果）は null */
let menuPage: MenuPage | null = null;
/** トップメニューでいま選んでいる項目 */
let menuIndex = 0;

/** en は項目の右に小さく添える英字。CSS の生成文字で出すので、ボタンの文字列には入らない */
const MENU_ITEMS: { id: string; label: string; en: string; run: () => void }[] = [
  { id: 'menu-start', label: '一人用', en: 'SOLO', run: () => startGame(null) },
  { id: 'menu-tour', label: '惑星めぐり', en: 'TOUR', run: () => showMenu('tour') },
  { id: 'menu-versus', label: '対戦', en: 'BATTLE', run: () => showMenu('versus') },
  { id: 'menu-how', label: '遊び方', en: 'GUIDE', run: () => showMenu('how') },
  { id: 'menu-records', label: '記録', en: 'RECORDS', run: () => showMenu('records') },
];

/** 対戦で選べる CPU の強さ */
const CPU_CHOICES: { id: string; label: string; en: string; note: string; level: CpuLevel }[] = [
  { id: 'cpu-easy', label: '弱い', en: 'EASY', note: '手が遅く、空中では組み替えない', level: 'easy' },
  { id: 'cpu-normal', label: '普通', en: 'NORMAL', note: '休まず積み替えてくる', level: 'normal' },
  { id: 'cpu-hard', label: '強い', en: 'HARD', note: '空中でも組み替えて連続点火を狙う', level: 'hard' },
];

/**
 * いま戦っている相手。戦績（`recordDuel`）を相手ごとに数えるのに使う。
 * CPU は強さごとに別の相手として数え、オンラインは名前で見分ける
 */
function opponent(): Opponent | null {
  if (online) {
    return { kind: 'online', key: onlineDuelKey(online.rivalName), label: online.rivalName };
  }
  if (versus) return cpuOpponent(versus.level);
  return null;
}

function cpuOpponent(level: CpuLevel): Opponent {
  const choice = CPU_CHOICES.find((c) => c.level === level);
  return { kind: 'cpu', key: cpuDuelKey(level), label: `CPU（${choice?.label ?? level}）` };
}

/** 戦績の言い方。引き分けはあったときだけ添える */
function formatTally(duel: Duel): string {
  return `${duel.wins} 勝 ${duel.losses} 敗${duel.draws > 0 ? ` ${duel.draws} 分` : ''}`;
}

function topMenuHtml(): string {
  const items = MENU_ITEMS.map(
    (item, i) =>
      `<li style="--i:${i}"><button id="${item.id}" class="menu-item${i === menuIndex ? ' on' : ''}" data-index="${i}" data-no="0${i + 1}" data-en="${item.en}">${item.label}<span class="mark"></span></button></li>`,
  ).join('');
  // 題字は 1 文字ずつ包む（色を 1 文字ずつに塗る。h1 の文字列は NOVARIA のまま）
  const title = [...'NOVARIA'].map((c) => `<i>${c}</i>`).join('');
  // 背景で地平線から打ち上がり続けるカタマリ。どれも同じ形で、位置と周期だけを変える
  const volleys = VOLLEYS.map(
    (v) =>
      `<div class="volley" style="left:${v.x}%;--d:${v.delay}s;--t:${v.period}s;--s:${v.scale}">${v.kinds
        .map((k) => `<b class="${k}"></b>`)
        .join('')}</div>`,
  ).join('');
  return `
    <div class="volleys">${volleys}</div>
    <div class="dawn"></div>
    <div class="flash"></div>
    <div class="panel top">
      <div class="hero">
        <div class="launch">
          <div class="tile h2o"></div>
          <div class="tile fire"></div>
          <div class="tile soil"></div>
          <div class="flame"><i></i><i></i></div>
          <div class="trail"></div>
          <div class="ring"></div>
        </div>
        <p class="kicker">惑星防衛アクションパズル</p>
        <div class="logo" data-text="NOVARIA">
          <div class="burst"></div>
          <div class="flare"></div>
          <h1>${title}</h1>
        </div>
        <div class="glow"></div>
      </div>
      <ul class="menu">${items}</ul>
    </div>`;
}

/**
 * トップメニューの背景で打ち上がり続けるカタマリ。演出が終わったあとも画面が止まって見えないよう、
 * 数秒おきに地平線から宇宙へ抜けていく。周期をずらして、同時に飛ばないようにする
 */
const VOLLEYS: { x: number; delay: number; period: number; scale: number; kinds: string[] }[] = [
  { x: 14, delay: 3.2, period: 7.3, scale: 0.9, kinds: ['h2o', 'h2o'] },
  { x: 82, delay: 5.1, period: 8.9, scale: 1, kinds: ['fire', 'soil', 'fire'] },
  { x: 33, delay: 7.4, period: 9.7, scale: 0.7, kinds: ['soil'] },
  { x: 66, delay: 9.6, period: 11.3, scale: 0.8, kinds: ['h2o', 'fire'] },
];

function versusHtml(): string {
  // 強さの下に、その強さとの通算を出す。どれを選ぶかの手がかりになる
  const items = CPU_CHOICES.map((c) => {
    const duel = findDuel(cpuDuelKey(c.level));
    const tally = duel ? `<span class="tally">${formatTally(duel)}</span>` : '';
    return `<li><button id="${c.id}" class="menu-item" data-en="${c.en}">${c.label}<span class="note">${c.note}</span>${tally}</button></li>`;
  }).join('');
  return `
    <div class="panel">
      <p class="eyebrow">BATTLE</p>
      <h1>対戦</h1>
      <p class="sub">打ち上げた隕石は、相手の惑星に燃えカスになって降る。<br>
      先に積みきったほうが滅亡する。</p>
      <ul class="menu">
        <li><button id="to-online" class="menu-item" data-en="ONLINE">オンライン<span class="note">通信で、今遊んでいる人と 1 対 1</span></button></li>
        ${items}
      </ul>
      <button id="menu-back" class="sub-button">戻る</button>
    </div>`;
}

function onlineHtml(): string {
  return `
    <div class="panel">
      <p class="eyebrow">ONLINE BATTLE</p>
      <h1>オンライン</h1>
      <div class="panel-body">
        <p class="sub">相手と同じ順番で隕石が降る。<br>
        打ち上げた分が相手の惑星に降り、先に積みきったほうが滅亡する。</p>
        <ul class="menu">
          <li><button id="online-random" class="menu-item" data-en="MATCH">相手を探す<span class="note">今待っている人とつなぐ</span></button></li>
        </ul>
        <h2 class="section">合言葉</h2>
        <p class="sub">同じ言葉を入れた人同士でつながる。知り合いと遊ぶときに使う。</p>
        <input id="code-input" class="name-input" type="text" inputmode="text"
          maxlength="${CODE_MAX}" placeholder="合言葉" autocomplete="off">
        <button id="online-code">合言葉でつなぐ</button>
      </div>
      <button id="menu-back" class="sub-button">戻る</button>
    </div>`;
}

/** 相手が見つかるまでの画面。合言葉で待っているあいだはその言葉も出す */
function waitingHtml(): string {
  // Worker が返す言葉はつながってからしか届かない。画面を出す時点では自分が入れた言葉を使う
  const code = online?.code ?? lastOnlineCode;
  return `
    <div class="panel">
      <p class="eyebrow">MATCHING</p>
      <h1>相手待ち</h1>
      <div class="radar"><i></i><b></b></div>
      <p id="wait-note" class="sub">接続中…</p>
      ${code ? `<p class="best">合言葉「${escapeHtml(code)}」で待っている。同じ言葉を相手にも入れてもらう</p>` : ''}
      <button id="menu-back">やめる</button>
    </div>`;
}

/**
 * 惑星めぐりの道のり。抜けたことのある惑星には印を付ける。
 * 先の惑星も隠さずに見せる（どこまで続くか分からないと、進んでいる実感が出ない）
 */
function tourHtml(): string {
  const best = loadTourRecords();
  const stops = TOUR.map((stage, i) => {
    const reached = i < best.reached;
    return `<li class="${reached ? 'reached' : ''}">
      <span class="goal">${stage.goal} 個</span>
      <b>${i + 1}. ${stage.planet.label}</b>
      <span class="note">${stage.note}</span>
    </li>`;
  }).join('');
  return `
    <div class="panel">
      <p class="eyebrow">PLANET TOUR</p>
      <h1>惑星めぐり</h1>
      <div class="panel-body">
        <p class="sub">惑星を 1 つずつ渡る。決まった数だけ打ち上げるとその惑星を脱出し、<br>
        次の惑星へ進む。積みきったらそこで終わり。得点は道のり全体で足す。</p>
        <ul class="how stops">${stops}</ul>
      </div>
      <button id="tour-start">出発</button>
      <button id="menu-back" class="sub-button">戻る</button>
    </div>`;
}

function howHtml(): string {
  return `
    <div class="panel">
      <p class="eyebrow">HOW TO PLAY</p>
      <h1>遊び方</h1>
      <div class="panel-body">
      <p class="sub">降ってくる隕石を同じ列の中で上下に動かす。<br>
      同じ柄が縦か横に 3 つ並ぶと点火して、上に乗った隕石ごと宇宙へ打ち上がる。</p>
      <ul class="how">
        <li><b>指でなぞる</b> … 隕石を掴んで、その列の中で上下に運ぶ</li>
        <li><b>空中でも動かせる</b> … 打ち上がった塊は数秒ほど空中に留まる。その間に塊の中で揃え直すと連続点火</li>
        <li><b>下から当てる</b> … 浮いている塊に別の塊をぶつけると、合体して一緒に浮く</li>
        <li><b>一番上をさらに上へ払う</b> … シュート。飛んでいる塊を押し上げ、降ってくる同じ柄と相殺する</li>
        <li><b>レアメタル</b> … ときどき降る特別な隕石。宇宙へ出すと 10,000 点。最下段に居座るので、指で山の高いところまで運び、その下で点火して一緒に打ち上げる</li>
        <li><b>下の帯を押す</b> … 時間が速く進む。降りが速くなる</li>
        <li><b>橙に光った列</b> … あと 1 段で大気圏。崩すか、一番上を上へ払って逃がす</li>
        <li><b>赤く光った列</b> … 大気圏まで積もった。線の上の帯が尽きると滅亡</li>
        <li><b>ヒント</b> … 一時停止でつけると、次に動かすとよい隕石と運び先を矢印で出す。緑は攻め、橙と赤は危ない列を守る手。一時停止の「速さ」でゆっくりにできる。ゲームごとにつけ直す。つけたゲームは記録に残らない</li>
      </ul>
      </div>
      <button id="menu-back">戻る</button>
    </div>`;
}

/**
 * 何が変わったかのお知らせ（`src/render/news.ts`）。トップの帯か、隅の「お知らせ」から開く。
 * 開く前に未読だった項目には印を付ける（開いた時点で全部読んだことになる）
 */
function newsHtml(): string {
  const items = NEWS.map(
    (n) => `
      <article class="news-item">
        <h2 class="section"><time>${n.date}</time>${isUnread(n, newsUnread) ? '<span class="new">NEW</span>' : ''}</h2>
        <p class="news-title">${n.title}</p>
        <ul class="news-lines">${n.lines.map((l) => `<li>${l}</li>`).join('')}</ul>
      </article>`,
  ).join('');
  return `
    <div class="panel">
      <p class="eyebrow">UPDATES</p>
      <h1>お知らせ</h1>
      <div class="panel-body">${items}</div>
      <button id="menu-back">戻る</button>
    </div>`;
}

/**
 * 「記録」に出す対戦の戦績。CPU は戦っていない強さも並べ（どれが手つかずか分かる）、
 * オンラインは戦った相手だけを新しい順に並べる
 */
function duelsHtml(): string {
  const duels = loadDuels();
  const cpu = CPU_CHOICES.map((c) => {
    const duel = duels.find((d) => d.key === cpuDuelKey(c.level));
    return `<tr><th>${c.label}</th><td>${duel ? formatTally(duel) : '―'}</td></tr>`;
  }).join('');
  const online = duels.filter((d) => d.kind === 'online');
  const rows = online
    .map((d) => `<tr><th>${escapeHtml(d.label)}</th><td>${formatTally(d)}</td></tr>`)
    .join('');
  // 相手が 1 人だけなら、その行と同じ数が並ぶだけなので通算は出さない
  const total =
    online.length > 1
      ? `<tr><th>通算</th><td>${formatTally({
          ...online[0],
          wins: online.reduce((n, d) => n + d.wins, 0),
          losses: online.reduce((n, d) => n + d.losses, 0),
          draws: online.reduce((n, d) => n + d.draws, 0),
        })}</td></tr>`
      : '';
  return `
    <h2 class="section">対戦（CPU）</h2>
    <table class="result">${cpu}</table>
    <h2 class="section">対戦（オンライン）</h2>
    ${
      online.length > 0
        ? `<table class="result">${rows}${total}</table>`
        : '<p class="sub">まだオンラインで対戦していない。</p>'
    }`;
}

/**
 * 「記録」のタブ。見るだけの画面なので、名前や公開の設定は「名前と公開」（`settingsHtml`）に分けてある。
 * 1 本の縦長に並べていたころは、ランキングの表まで見るのにスクロールが要り、
 * 下半分を設定のボタン（取り消せない「ランキングから消す」を含む）が占めていた
 */
type RecordsTab = 'best' | 'duels' | 'ranking';
const RECORDS_TABS: { id: RecordsTab; label: string }[] = [
  { id: 'best', label: '自己ベスト' },
  { id: 'duels', label: '対戦' },
  { id: 'ranking', label: 'ランキング' },
];
/** 最後に開いたタブ。「記録」を開き直したときにそこから出す（起動し直すと自己ベストに戻る） */
let recordsTab: RecordsTab = 'best';

function recordsHtml(): string {
  const best = loadRecords();
  const trip = loadTourRecords();
  const player = loadPlayer();
  const tripBody =
    trip.reached > 0
      ? `<table class="result">
        <tr><th>到達</th><td>${TOUR[Math.min(trip.reached, TOUR.length) - 1].planet.label}（${trip.reached}/${TOUR.length}）</td></tr>
        <tr><th>スコア</th><td>${trip.score.toLocaleString()}</td></tr>
        ${trip.completed ? '<tr><th>完走</th><td>した</td></tr>' : ''}
      </table>`
      : '<p class="sub">まだ出発していない。</p>';
  const body =
    best.score > 0
      ? `<table class="result">
        <tr><th>スコア</th><td>${best.score.toLocaleString()}</td></tr>
        <tr><th>打ち上げ</th><td>${best.launched}</td></tr>
        <tr><th>最大連続点火</th><td>x${best.maxCombo}</td></tr>
        <tr><th>時間</th><td>${formatTime(best.seconds)}</td></tr>
      </table>`
      : '<p class="sub">まだ記録がない。一度遊ぶとここに残る。</p>';
  const tabs = RECORDS_TABS.map(
    (t) =>
      `<button id="tab-${t.id}" class="tab" role="tab" aria-controls="pane-${t.id}" aria-selected="${t.id === recordsTab}">${t.label}</button>`,
  ).join('');
  const pane = (id: RecordsTab, html: string): string =>
    `<section id="pane-${id}" class="pane" role="tabpanel" aria-labelledby="tab-${id}"${id === recordsTab ? '' : ' hidden'}>${html}</section>`;
  return `
    <div class="panel records">
      <p class="eyebrow">RECORDS</p>
      <h1>記録</h1>
      <button id="to-settings" class="who-bar">
        <span class="who-name">${player ? escapeHtml(player.name) : '名前はまだ無い'}</span>
        <span class="who-go">名前と公開</span>
      </button>
      <div class="tabs" role="tablist">${tabs}</div>
      <div class="panel-body">
        ${pane(
          'best',
          `<h2 class="section">一人用</h2>
          ${body}
          <h2 class="section">惑星めぐり</h2>
          ${tripBody}`,
        )}
        ${pane('duels', duelsHtml())}
        ${pane(
          'ranking',
          rankingEnabled()
            ? '<div id="ranking" class="ranking-box"><p class="sub">読み込み中…</p></div>'
            : '<p class="sub">ランキングに載せない設定になっている。結果は送らない。<br>「名前と公開」で戻せる。</p>',
        )}
      </div>
      <button id="menu-back">戻る</button>
    </div>`;
}

/** 「記録」のタブを切り替える。ランキングを開いたら自分の行まで送る */
function showRecordsTab(id: RecordsTab): void {
  recordsTab = id;
  for (const t of RECORDS_TABS) {
    document.getElementById(`tab-${t.id}`)?.setAttribute('aria-selected', String(t.id === id));
    const pane = document.getElementById(`pane-${t.id}`);
    if (pane) pane.hidden = t.id !== id;
  }
  const body = document.querySelector<HTMLElement>('#menu .panel-body');
  if (body) body.scrollTop = 0;
  if (id === 'ranking') scrollToMe();
}

function setUpRecordsTabs(): void {
  for (const t of RECORDS_TABS) {
    document.getElementById(`tab-${t.id}`)!.addEventListener('click', () => {
      if (t.id !== recordsTab) audio.ui('select');
      showRecordsTab(t.id);
    });
  }
}

/** ランキングの表で自分の行が真ん中に来るよう、中身のスクロールを送る。上位 50 人の下のほうでも探さずに済む */
function scrollToMe(): void {
  const body = document.querySelector<HTMLElement>('#menu .panel-body');
  const me = document.querySelector<HTMLElement>('#ranking tr.me');
  if (!body || !me || document.getElementById('pane-ranking')?.hidden) return;
  const top = me.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
  body.scrollTop = Math.max(0, top - body.clientHeight / 2);
}

/**
 * 「名前と公開」。名前・扱う情報・ランキングへの掲載をまとめた設定の画面。
 * 取り消せない「ランキングから消す」は、ふだん開く「記録」に置かず、ここのいちばん下に離して置く
 */
function settingsHtml(): string {
  const player = loadPlayer();
  const ranked = rankingEnabled();
  return `
    <div class="panel">
      <p class="eyebrow">SETTINGS</p>
      <h1>名前と公開</h1>
      <div class="panel-body">
        <h2 class="section">名前</h2>
        <p class="sub setting-now">${player ? escapeHtml(player.name) : 'まだ決めていない'}</p>
        <button id="to-name" class="sub-button">${player ? '名前を変える' : '名前を決める'}</button>
        <button id="to-privacy" class="sub-button">扱う情報</button>
        <h2 class="section danger">ランキングへの掲載</h2>
        <p class="sub setting-now">${
          ranked ? 'いまは載せている。' : 'ランキングに載せない設定になっている。結果は送らない。'
        }</p>
        ${
          ranked
            ? '<button id="ranking-leave" class="sub-button danger-button">ランキングから消す</button>'
            : '<button id="ranking-join" class="sub-button">ランキングに載せる</button>'
        }
        <p id="ranking-note" class="sub" hidden></p>
      </div>
      <button id="menu-back">戻る</button>
    </div>`;
}

/** 画面に出す文字に混ざった記号を無害にする。名前は他の人の端末で出るので必ず通す */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

/**
 * 名前の画面。名前が要るのはランキングと対戦のときだけなので、
 * 初めて開いたときには聞かず、要るところか「記録」→「名前と公開」から呼ぶ
 */
function nameHtml(): string {
  const player = loadPlayer();
  return `
    <div class="panel">
      <p class="eyebrow">CALLSIGN</p>
      <h1>名前</h1>
      <p class="sub">${
        player
          ? 'ランキングに出ている名前が、この名前に変わる。'
          : 'ランキングと対戦で、ほかの人に見える名前。<br>あとから「記録」の「名前と公開」で変えられる。'
      }</p>
      <p class="sub">ほかの人が不快に思う名前は、「名無し」に差し替えることがある。</p>
      ${nameFieldHtml(player?.name ?? '', '決める')}
      <button id="menu-back" class="sub-button">戻る</button>
    </div>`;
}

/**
 * このゲームが扱う情報の告知。「記録」→「名前と公開」から開く。
 * 中身を変えたら（送るもの・残すものを足したら）ここも直す
 */
function privacyHtml(): string {
  return `
    <div class="panel">
      <p class="eyebrow">PRIVACY</p>
      <h1>扱う情報</h1>
      <div class="panel-body">
        <h2 class="section">この端末にだけ残すもの</h2>
        <p class="sub">遊び手の id（初めて開いたときに作る無作為の番号）、名前、自己ベスト、惑星めぐりの到達、対戦の戦績（相手の名前ごとの勝ち負け）、お知らせをどこまで読んだかの印、レアメタルを打ち上げたことがあるかの印、音の切り替え。ブラウザのサイトデータを消すと消える。</p>
        <h2 class="section">ランキングに送るもの</h2>
        <p class="sub">名前を決めた人の 1 人用の結果だけ。id・名前・スコア・打ち上げ数・最大連続点火・時間・送った時刻を残す。表に出るのは上位 50 人の名前とスコアで、id は誰にも見せない。</p>
        <p class="sub">送りすぎを止めるため、接続元の IP アドレスを日付と混ぜて元に戻せない形（ハッシュ）にしたものも残す。IP アドレスそのものは残さない。</p>
        <h2 class="section">オンライン対戦で送るもの</h2>
        <p class="sub">名前と、盤面の絵と攻撃の数を相手に送る。サーバーは中継するだけで残さない。</p>
        <h2 class="section">使っていないもの</h2>
        <p class="sub">広告、アクセス解析、Cookie は使っていない。配信は Cloudflare を通す。</p>
        <h2 class="section">消すとき</h2>
        <p class="sub">「記録」→「名前と公開」の「ランキングから消す」で、自分の行がすぐに消え、以後は送らなくなる。「ランキングに載せる」で戻せる。</p>
        <p class="sub">ほかの人が不快に思う名前は、予告なく「名無し」に差し替えるか、行ごと消すことがある。</p>
      </div>
      <button id="menu-back">戻る</button>
    </div>`;
}

/** 名前を入れる欄。「名前」の画面と、結果画面から決めるときで同じものを使う */
function nameFieldHtml(value: string, label: string): string {
  return `
      <input id="name-input" class="name-input" type="text" inputmode="text"
        maxlength="${NAME_MAX}" placeholder="名前" autocomplete="nickname"
        value="${escapeHtml(value)}">
      <p id="name-error" class="name-error" hidden>1〜${NAME_MAX} 文字で入れる</p>
      <button id="name-save">${label}</button>`;
}

/**
 * ランキングの表。自分の行は目立たせ、上位に入っていなければ下に足す。
 * 表には遊び手の id が無いので（他の人に見せない）、自分の行は順位で見分ける
 */
function rankingHtml(ranking: Ranking): string {
  if (ranking.scores.length === 0) {
    return '<p class="sub">まだ誰も送っていない。最初の 1 人になる。</p>';
  }
  const mine = ranking.self?.rank ?? null;
  const row = (s: RankedScore, gap = false): string =>
    `<tr class="${s.rank === mine ? 'me' : ''}${gap ? ' gap' : ''}">
      <td class="rank">${s.rank}</td>
      <td class="who">${escapeHtml(s.name)}</td>
      <td class="score">${s.score.toLocaleString()}</td>
    </tr>`;
  const inTop = ranking.scores.some((s) => s.rank === mine);
  const self = !inTop && ranking.self ? row(ranking.self, true) : '';
  return `
    <p class="best ranking-sum">${
      ranking.self ? `自分は ${ranking.self.rank} 位 / 全 ${ranking.total} 人` : `全 ${ranking.total} 人。まだ自分の記録は送っていない`
    }</p>
    <table class="ranking">${ranking.scores.map((s) => row(s)).join('')}${self}</table>`;
}

/** 記録の画面を開いたあとでランキングを読みに行き、届いたら差し込む */
async function fillRanking(): Promise<void> {
  const box = document.getElementById('ranking');
  if (!box) return;
  const id = ensureUserId();
  try {
    const ranking = await fetchRanking(id);
    // 読んでいるあいだに別の画面へ移っていたら捨てる
    if (menuPage !== 'records') return;
    box.innerHTML = rankingHtml(ranking);
    scrollToMe();
  } catch {
    if (menuPage !== 'records') return;
    box.innerHTML = '<p class="sub">今は見られない。電波の届くところでもう一度。</p>';
  }
}

/**
 * 「ランキングから消す」と「ランキングに載せる」。
 * 消すほうは取り消せないので、1 度目は確かめる文に替えるだけで、もう 1 度押すと消す
 */
function setUpRankingChoice(): void {
  const note = document.getElementById('ranking-note')!;
  const join = document.getElementById('ranking-join');
  join?.addEventListener('click', () => {
    audio.ui('confirm');
    joinRanking();
    showMenu('settings');
  });
  const leave = document.getElementById('ranking-leave');
  if (!leave) return;
  let armed = false;
  leave.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      audio.ui('confirm');
      leave.textContent = 'もう一度押すと消える';
      note.textContent = '自分の行をランキングから消し、以後は結果を送らない。';
      note.hidden = false;
      return;
    }
    leave.setAttribute('disabled', '');
    leave.textContent = '消している…';
    const done = await leaveRanking();
    if (menuPage !== 'settings') return;
    if (done) {
      audio.ui('confirm');
      showMenu('settings');
      return;
    }
    audio.ui('error');
    armed = false;
    leave.removeAttribute('disabled');
    leave.textContent = 'ランキングから消す';
    note.textContent = '今は消せない。電波の届くところでもう一度。';
  });
}

// ------------------------------------------------------- オープニング

/**
 * どの画面にも敷く背景。星空（`sky.ts` が組み立てる）と惑星の地平線。
 * メニューのあいだ canvas は隠れているので、ここに見えるものは全部 DOM と CSS。
 * 星は開くたびに同じ並びになるので、1 度だけ組み立てて使い回す
 */
const SKY_LAYERS = `${skyHtml()}<div class="planet"></div>`;

/** ページを読み込んでから、まだトップを 1 度も出していないか。演出を流すのは最初の 1 回だけ */
let introPending = true;
let introTimer: number | null = null;

/**
 * トップメニューのオープニングを始める。2.4 秒。
 * 起動して最初にトップを出したときだけ流す（ゲームから戻ってきたときは流さない。
 * 毎回待たされないため）
 */
function startIntro(): void {
  introPending = false;
  // 動きを減らす設定の人には流さず、完成した見た目をそのまま出す
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  menuEl.classList.add('intro');
  introTimer = window.setTimeout(settleIntro, 2500);
}

/**
 * 演出を終わらせる。CSS の animation を外すだけで、どの要素も終了状態のスタイルになる。
 * 時間切れでも、触られても、キーを押されてもここへ来る
 */
function settleIntro(): void {
  if (introTimer !== null) {
    clearTimeout(introTimer);
    introTimer = null;
  }
  menuEl.classList.remove('intro');
}

// 触られたら演出を飛ばす。そのタップはボタンにもそのまま届く
//（「1 回目のタップは演出を飛ばすだけ」にすると、押したのに反応しないように見える）。
// 飛ばすのは指を離してから。押しているあいだに画面が動くと、押し始めた要素と
// 離したときの要素が食い違って、ボタンの click が起きなくなる
menuEl.addEventListener('pointerup', () => settleIntro(), { capture: true });

// ------------------------------------------------------------------ 画面の出し入れ

const PAGES: Record<MenuPage, () => string> = {
  top: topMenuHtml,
  name: nameHtml,
  tour: tourHtml,
  versus: versusHtml,
  online: onlineHtml,
  waiting: waitingHtml,
  how: howHtml,
  records: recordsHtml,
  settings: settingsHtml,
  privacy: privacyHtml,
  news: newsHtml,
};

/** メニューを出す。トップから「遊び方」「記録」へ降り、「戻る」で 1 つ上（`parentPage`）へ戻る */
function showMenu(page: MenuPage = 'top'): void {
  running = false;
  paused = false;
  audio.scene('menu');
  menuPage = page;
  // 戻るの行き先。トップが一番浅いので、積んだぶんはここで戻しておく
  if (page === 'top') dropHistoryGuard();
  else pushHistoryGuard();
  boostHeld = false;
  touches.clear();
  // 相手待ちの画面以外へ移るなら、つなぎっぱなしの回線を切る
  if (page !== 'waiting') leaveOnline();
  // 名前の画面から離れたら、決めたあとの続きと戻り先は捨てる
  if (page !== 'name') {
    afterName = null;
    nameReturn = 'top';
  }

  // ゲームの上に重ねるのではなく、canvas と入れ替える。
  // メニューのあいだは盤面を描かないので、フレームを丸ごとメニューに使える
  closeOverlay();
  canvas.hidden = true;
  // 惑星めぐりの先の空のままメニューに戻らないよう、母星の色に戻してから空を塗り直す。
  // 滅亡しかけの赤も、ここで元に戻る
  view.setPlanet(NOVARIA.name);
  view.applySky(0);
  if (page !== 'top') hideNewsToast();
  menuEl.innerHTML = SKY_LAYERS + PAGES[page]();
  if (page === 'news') {
    markNewsRead();
    newsUnread = 0;
    showNewsDot();
  }
  menuEl.classList.add('shown');
  showBuildFooter(true);
  // 遊んでいるあいだに取り終えた新版があれば、トップに戻ったここで入れ替える
  if (page === 'top') applyDeferredUpdate();
  // オープニングは、起動してから最初にトップを出したときだけ
  if (page === 'top' && introPending) startIntro();
  else settleIntro();

  if (page === 'top') {
    for (const [i, item] of MENU_ITEMS.entries()) {
      const button = document.getElementById(item.id)!;
      // 触れた項目にカーソルを寄せてから実行する。キーボードで選んだときと同じ見た目になる
      button.addEventListener('pointerenter', () => moveCursor(i));
      button.addEventListener('click', () => {
        audio.unlock();
        audio.ui('confirm');
        moveCursor(i);
        item.run();
      });
    }
    return;
  }

  const back = parentPage(page);
  document.getElementById('menu-back')?.addEventListener('click', () => {
    audio.ui('back');
    showMenu(back);
  });
  if (page === 'versus') {
    document.getElementById('to-online')!.addEventListener('click', () => {
      audio.ui('confirm');
      showMenu('online');
    });
    for (const choice of CPU_CHOICES) {
      document.getElementById(choice.id)!.addEventListener('click', () => {
        audio.unlock();
        audio.ui('confirm');
        startGame(choice.level);
      });
    }
  }
  if (page === 'tour') {
    document.getElementById('tour-start')!.addEventListener('click', () => {
      audio.unlock();
      audio.ui('confirm');
      startTour();
    });
  }
  if (page === 'online') setUpOnlinePage();
  if (page === 'name') setUpNameInput();
  if (page === 'records') {
    document.getElementById('to-settings')!.addEventListener('click', () => {
      audio.ui('confirm');
      showMenu('settings');
    });
    setUpRecordsTabs();
    if (rankingEnabled()) void fillRanking();
  }
  if (page === 'settings') {
    document.getElementById('to-name')!.addEventListener('click', () => {
      audio.ui('confirm');
      // 決めたら（戻っても）この画面に帰る
      nameReturn = 'settings';
      afterName = () => showMenu('settings');
      showMenu('name');
    });
    document.getElementById('to-privacy')!.addEventListener('click', () => {
      audio.ui('confirm');
      showMenu('privacy');
    });
    setUpRankingChoice();
  }
}

/**
 * 名前が要るところで呼ぶ。決まったら next を続きとして走らせる。
 * 決めずに戻られたら next は捨てる（`showMenu` が下ろす）
 */
let afterName: (() => void) | null = null;
/** 名前の画面の「戻る」の行き先。「名前と公開」から開いたときはそこへ帰る */
let nameReturn: MenuPage = 'top';

/**
 * 画面の 1 つ上。「戻る」ボタンと端末の戻るの行き先。
 * 「オンライン」は対戦の下、「名前と公開」は記録の下、「扱う情報」は名前と公開の下にある
 */
function parentPage(page: MenuPage): MenuPage {
  if (page === 'online') return 'versus';
  if (page === 'settings') return 'records';
  if (page === 'privacy') return 'settings';
  if (page === 'name') return nameReturn;
  return 'top';
}

function askName(next: () => void): void {
  afterName = next;
  showMenu('name');
}

/**
 * 名前の欄を使えるようにする。決まったら onSaved を呼ぶ。
 * 空や記号だけのときは、その場に案内を出して先へ進まない
 */
function setUpNameField(onSaved: (player: Player) => void): void {
  const input = document.getElementById('name-input') as HTMLInputElement;
  const error = document.getElementById('name-error')!;
  const save = (): void => {
    audio.unlock();
    const player = savePlayer(input.value);
    if (!player) {
      audio.ui('error');
      error.hidden = false;
      input.focus();
      return;
    }
    audio.ui('confirm');
    onSaved(player);
  };
  document.getElementById('name-save')!.addEventListener('click', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  });
  input.focus();
}

/** 名前の画面。決まったら、呼んだところの続きへ進む（何も無ければトップ） */
function setUpNameInput(): void {
  setUpNameField((player) => {
    // 名前を変えたら、ランキングに出ている名前も付け替える。
    // 送れずに残っている結果があれば、それも新しい名前で送り直す
    void renamePlayer(player);
    void flushPending();
    const next = afterName;
    afterName = null;
    if (next) next();
    else showMenu('top');
  });
}

// ------------------------------------------------------- オンライン対戦

/** オンラインの画面。「相手を探す」と、合言葉を入れてつなぐところ */
function setUpOnlinePage(): void {
  const input = document.getElementById('code-input') as HTMLInputElement;
  document.getElementById('online-random')!.addEventListener('click', () => {
    audio.unlock();
    audio.ui('confirm');
    startOnline(null);
  });
  const byCode = (): void => {
    audio.unlock();
    const code = normalizeCode(input.value);
    if (code.length === 0) {
      audio.ui('error');
      input.focus();
      return;
    }
    audio.ui('confirm');
    startOnline(code);
  };
  document.getElementById('online-code')!.addEventListener('click', byCode);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      byCode();
    }
  });
}

/**
 * 相手を探し始める。合言葉を渡すと、同じ言葉を入れた人とだけつながる。
 * 見つかるまでは「相手待ち」の画面で待つ
 */
function startOnline(code: string | null): void {
  const player = loadPlayer();
  if (!player) {
    // 相手の画面に名前が出る。決めてもらってから、そのまま探し始める
    askName(() => startOnline(code));
    return;
  }
  // Worker は整えた形の合言葉しか受け取らない。空になったら相手を選ばずに探す
  const word = code === null ? null : normalizeCode(code) || null;
  leaveOnline();
  lastOnlineCode = word;
  tour = null;
  online = new OnlineMatch(openMatchSocket(player.name, word), onOnlineChange);
  showMenu('waiting');
}

/** 回線を切る。相手待ちでも対戦中でも、メニューへ戻るときは必ず通る */
function leaveOnline(): void {
  online?.leave();
  online = null;
}

/** 対戦の段階が変わったときに呼ばれる。待ち画面の書き替えと、盤面の出し入れをする */
function onOnlineChange(): void {
  const match = online;
  if (!match) return;
  if (match.phase === 'playing' && menuPage === 'waiting') {
    // 相手が見つかった。ここで初めて盤面を出す
    versus = null;
    lastLevel = null;
    audio.ui('matched');
    beginPlay(match.game!);
    return;
  }
  if (menuPage === 'waiting') {
    const note = document.getElementById('wait-note');
    if (!note) return;
    if (match.busy) note.textContent = '混んでいてつなげなかった。少し待ってからもう一度';
    else if (match.phase === 'ended') note.textContent = 'つながらなかった。電波の届くところでもう一度';
    else note.textContent = match.code ? '同じ合言葉の人を待っている…' : '相手を探している…';
    return;
  }
  // 遊んでいる最中に相手の接続が切れた。
  // 勝ち負けと相打ちは盤面を進める側（`step`）が拾って、決着の演出から結果へ流す
  if (match.result === 'left' && running) scheduleResult();
}

/** トップメニューのカーソルを i 番へ動かす */
function moveCursor(i: number): void {
  const next = (i + MENU_ITEMS.length) % MENU_ITEMS.length;
  if (next !== menuIndex) audio.ui('select');
  menuIndex = next;
  for (const [n, item] of MENU_ITEMS.entries()) {
    document.getElementById(item.id)?.classList.toggle('on', n === menuIndex);
  }
}

/**
 * 結果の画面の得点を 0 から数え上げる。行が滑り込むのを待ってから 0.9 秒かけて上がる。
 * 動きを減らす設定の人には最初から最後の数字を見せる（HTML に入れた値のまま触らない）
 */
function countUp(el: Element | null, value: number): void {
  if (!el || value <= 0) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const start = performance.now() + 300;
  const tick = (now: number): void => {
    // 別の画面に替わっていたら止める
    if (!document.body.contains(el)) return;
    const t = Math.max(0, Math.min(1, (now - start) / 900));
    const eased = 1 - (1 - t) ** 3;
    el.textContent = Math.round(value * eased).toLocaleString();
    if (t < 1) requestAnimationFrame(tick);
  };
  el.textContent = '0';
  requestAnimationFrame(tick);
}

function formatTime(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ 画面

/** 直前に遊んだ対戦の強さ。「もう一度」で同じ相手と始めるために覚えておく */
let lastLevel: CpuLevel | null = null;
/**
 * 直前のオンライン対戦のつなぎ方（合言葉。ランダムなら null）。
 * undefined なら直前はオンラインではない。「もう一度」の行き先を決めるのに使う
 */
let lastOnlineCode: string | null | undefined;

/** level に CPU の強さを渡すと対戦、null なら 1 人用 */
function startGame(level: CpuLevel | null): void {
  leaveOnline();
  lastLevel = level;
  lastOnlineCode = undefined;
  tour = null;
  versus = level ? new Versus({ seed: nextSeed(), level }) : null;
  hintOn = false;
  hintUsed = false;
  beginPlay(versus ? versus.player : new Game({ seed: nextSeed() }));
}

/** 惑星めぐりを母星から始める */
function startTour(): void {
  leaveOnline();
  lastLevel = null;
  lastOnlineCode = undefined;
  versus = null;
  tour = new Tour({ seed: nextSeed() });
  hintOn = false;
  hintUsed = false;
  beginPlay(tour.game);
}

/** メニューを片付けて盤面を出し、その盤面で遊び始める */
function beginPlay(started: Game): void {
  menuPage = null;
  hideNewsToast();
  pushHistoryGuard();
  showBuildFooter(false);
  menuEl.classList.remove('shown');
  menuEl.innerHTML = '';
  canvas.hidden = false;
  game = started;
  // 惑星ごとに空と地面の色が変わる。1 人用と対戦は母星のまま
  view.setPlanet(game.planet.name);
  view.resize(game.cols);
  closeOverlay();
  running = true;
  paused = false;
  ending = false;
  finale = null;
  margin = null;
  fx.clear();
  view.lightsOn();
  wasDanger = false;
  wasWarn = false;
  boostHeld = false;
  touches.clear();
  levelMark = 0;
  audio.scene('play', true);
  audio.ui('start');
  announceStart();
}

/** 始まりの帯は、盤面が下から組み上がる（`View` の 36 フレーム）のを半分ほど待ってから開く */
const START_DELAY = 16;

/** 始まりの帯。何を遊んでいるか（惑星めぐりならどの惑星か、対戦なら誰とか）を出す */
function announceStart(): void {
  if (tour) {
    fx.banner(
      tour.stage.planet.label,
      `PLANET ${tour.index + 1} / ${tour.stages.length}`,
      UI.combo,
      84,
      START_DELAY,
    );
  } else if (online) {
    fx.banner(`VS ${online.rivalName}`, 'ONLINE BATTLE', '#ff9ad8', 84, START_DELAY);
  } else if (versus) {
    const cpu = CPU_CHOICES.find((c) => c.level === lastLevel)?.label ?? '';
    fx.banner('VS CPU', `BATTLE · ${cpu}`, '#ff9ad8', 84, START_DELAY);
  } else {
    fx.banner('MISSION START', 'DEFEND THE PLANET', UI.accent, 84, START_DELAY);
  }
}

/** 結果画面の「もう一度」。オンラインなら同じつなぎ方で相手を探し直す */
function playAgain(): void {
  if (tour) startTour();
  else if (lastOnlineCode !== undefined) startOnline(lastOnlineCode);
  else startGame(lastLevel);
}

/**
 * 盤面の上（得点の並び）を触ると一時停止する。
 * オンライン対戦では相手の盤面が止まらないので、こちらだけ止めるわけにいかない。
 * 代わりに「やめるか」を聞く（聞いているあいだも盤面は動き続ける）
 */
function showPause(): void {
  if (!running || paused || finale) return;
  if (online) {
    showQuit();
    return;
  }
  paused = true;
  overlayKind = 'pause';
  boostHeld = false;
  touches.clear();
  game.release();
  audio.scene('paused');
  audio.ui('pause');
  overlay.innerHTML = `
    <div class="panel">
      <p class="eyebrow">PAUSE</p>
      <h1>一時停止</h1>
      <table class="result">
        <tr><th>スコア</th><td>${(tour ? tour.score : game.score).toLocaleString()}</td></tr>
        <tr><th>打ち上げ</th><td>${game.launched.normal + game.launched.dust + game.launched.rare}</td></tr>
        ${
          tour
            ? `<tr><th>惑星</th><td>${tour.stage.planet.label}</td></tr>
        <tr><th>脱出まで</th><td>あと ${Math.max(0, tour.stage.goal - tour.launched)}</td></tr>`
            : ''
        }
      </table>
      <button id="resume">続ける</button>
      <button id="pause-mute" class="sub-button toggle" aria-pressed="${!audio.muted}">${audio.muted ? '音 なし' : '音 あり'}</button>
      ${
        versus
          ? ''
          : `<button id="pause-hint" class="sub-button toggle" aria-pressed="${hintOn}">${hintLabel()}</button>
      <div id="hint-speed-box" class="speed"${hintOn ? '' : ' hidden'}>
        <div class="speed-head"><span>速さ</span><b id="hint-speed-value">${speedLabel()}</b></div>
        <input id="hint-speed" type="range" min="0" max="${HINT_SPEEDS.length - 1}" step="1" value="${hintSpeedIndex}" aria-label="ヒントを使うときの速さ">
        <div class="speed-ends"><span>ゆっくり</span><span>ふつう</span></div>
      </div>
      <p id="hint-note" class="best"${hintUsed ? '' : ' hidden'}>${HINT_NOTE}</p>`
      }
      <button id="restart" class="sub-button">最初から</button>
      <button id="to-menu" class="sub-button">メニューへ</button>
    </div>`;
  overlay.classList.add('shown');
  document.getElementById('resume')!.addEventListener('click', () => {
    paused = false;
    audio.scene('play');
    audio.ui('resume');
    closeOverlay();
  });
  const mute = document.getElementById('pause-mute')!;
  mute.addEventListener('click', () => {
    audio.muted = !audio.muted;
    mute.textContent = audio.muted ? '音 なし' : '音 あり';
    mute.setAttribute('aria-pressed', String(!audio.muted));
    if (!audio.muted) audio.ui('confirm');
  });
  const hint = document.getElementById('pause-hint');
  hint?.addEventListener('click', () => {
    hintOn = !hintOn;
    if (hintOn) hintUsed = true;
    hint.textContent = hintLabel();
    hint.setAttribute('aria-pressed', String(hintOn));
    document.getElementById('hint-note')!.hidden = !hintUsed;
    // 速さはヒントをつけているときだけ効くので、消しているあいだは隠す
    document.getElementById('hint-speed-box')!.hidden = !hintOn;
    audio.ui('confirm');
  });
  const speed = document.getElementById('hint-speed') as HTMLInputElement | null;
  speed?.addEventListener('input', () => {
    hintSpeedIndex = Number(speed.value);
    document.getElementById('hint-speed-value')!.textContent = speedLabel();
  });
  document.getElementById('restart')!.addEventListener('click', () =>
    tour ? startTour() : startGame(lastLevel),
  );
  document.getElementById('to-menu')!.addEventListener('click', () => showMenu('top'));
}

function hintLabel(): string {
  return hintOn ? 'ヒント あり' : 'ヒント なし';
}

/** ヒントをつけたゲームで、一時停止と結果の画面に出す断り書き */
const HINT_NOTE = 'ヒントを使ったので、このゲームは記録にもランキングにも残さない';

/**
 * オンライン対戦の途中で「やめるか」を聞く。
 * 盤面は裏で動き続ける（止めると相手だけが進んでしまう）ので、
 * 迷っているあいだは指を動かせないぶんだけ不利になる
 */
function showQuit(): void {
  if (overlayKind !== null) return;
  overlayKind = 'quit';
  boostHeld = false;
  touches.clear();
  game.release();
  overlay.innerHTML = `
    <div class="panel lost">
      <p class="eyebrow">WARNING</p>
      <h1>やめる？</h1>
      <p class="sub">対戦の途中。やめると負けになる。<br>迷っている間も隕石は降り続ける。</p>
      <button id="resume">続ける</button>
      <button id="give-up" class="sub-button">やめる</button>
    </div>`;
  overlay.classList.add('shown');
  document.getElementById('resume')!.addEventListener('click', () => {
    closeOverlay();
  });
  document.getElementById('give-up')!.addEventListener('click', () => {
    closeOverlay();
    online?.resign();
  });
}

/**
 * 対戦の結果の見出し。CPU 戦もオンラインも同じ言い方にする。
 * 勝ち負けの下には、誰の惑星が落ちたのかを相手の名前で書く
 */
function versusTitle(result: OnlineOutcome | null, rival: string): string {
  const eyebrow = '<p class="eyebrow">BATTLE RESULT</p>';
  const name = escapeHtml(rival);
  if (result === 'win') {
    return `${eyebrow}<h1 class="win">勝ち</h1><p class="sub">${name}の惑星を滅ぼした。</p>`;
  }
  if (result === 'draw') {
    return `${eyebrow}<h1 class="over">相打ち</h1><p class="sub">${name}の惑星と同時に滅亡した。</p>`;
  }
  if (result === 'left') {
    return `${eyebrow}<h1 class="over">中断</h1><p class="sub">相手の接続が切れた。</p>`;
  }
  return `${eyebrow}<h1 class="over">負け</h1><p class="sub">${name}に惑星を滅ぼされた。</p>`;
}

/**
 * 決着の瞬間の盤面の余裕を一言にする。負けたら相手の、勝ったら自分の余裕を見る。
 * 惜しかったのか完敗だったのかが分かると、次の 1 戦を始めたくなる
 */
function marginLine(result: OnlineOutcome | null): string | null {
  if (!margin) return null;
  if (result === 'lose') {
    if (margin.rivalDanger) return '相手も大気圏まで積もっていた。あと一押しだった';
    if (margin.rival <= 2) return `相手もあと ${margin.rival} 段で大気圏だった`;
    return `相手にはまだ ${margin.rival} 段の余裕があった`;
  }
  if (result === 'win') {
    if (margin.mineDanger) return '自分も大気圏まで積もっていた。紙一重の勝ち';
    if (margin.mine <= 2) return `自分もあと ${margin.mine} 段で大気圏だった`;
    return `${margin.mine} 段の余裕を残して勝った`;
  }
  return null;
}

/**
 * 連勝・連敗の一言。2 回から数え、途切れたときもその数を書く。
 * before はこの 1 戦を足す前の連勝（正）か連敗（負）
 */
function streakLine(duel: Duel, before: number): string | null {
  const name = escapeHtml(duel.label);
  if (duel.streak >= 2) return `${name}に ${duel.streak} 連勝`;
  if (duel.streak <= -2) return `${name}に ${-duel.streak} 連敗`;
  if (duel.streak === 1 && before <= -2) return `連敗を ${-before} で止めた`;
  if (duel.streak === -1 && before >= 2) return `連勝が ${before} で止まった`;
  return null;
}

/** 1 人用の 1 回ぶんの成績。記録にもランキングにも同じ形で渡す */
interface Run {
  score: number;
  launched: number;
  maxCombo: number;
  seconds: number;
}

/**
 * 惑星を抜けた。次の惑星へ進む前に、ここまでの成績と次の行き先を出す。
 * 最後の惑星を抜けたなら完走の結果へ
 */
function showEscape(): void {
  if (!tour) return;
  if (tour.completed) {
    showResult();
    return;
  }
  const t = tour;
  running = false;
  paused = false;
  boostHeld = false;
  touches.clear();
  audio.scene('paused');
  const next = t.stages[t.index + 1];
  overlayKind = 'escape';
  overlay.innerHTML = `
    <div class="panel won result-panel">
      <p class="eyebrow">PLANET ESCAPED</p>
      <h1 class="win">脱出</h1>
      <p class="sub">${t.stage.planet.label} を抜けた。</p>
      <table class="result">
        <tr><th>スコア</th><td>${t.score.toLocaleString()}</td></tr>
        <tr><th>打ち上げ</th><td>${t.totalLaunched}</td></tr>
        <tr><th>時間</th><td>${formatTime(Math.floor(t.frames / 60))}</td></tr>
      </table>
      <p class="best">次は ${next.planet.label}（${t.index + 2} / ${t.stages.length}）… ${next.note}</p>
      <button id="go-next">${next.planet.label} へ</button>
      <button id="to-menu" class="sub-button">メニューへ</button>
    </div>`;
  overlay.classList.add('shown');
  document.getElementById('go-next')!.addEventListener('click', () => {
    audio.ui('confirm');
    t.advance();
    beginPlay(t.game);
  });
  document.getElementById('to-menu')!.addEventListener('click', () => showMenu('top'));
}

/**
 * 惑星めぐりの結果。滅亡しても完走しても、道のり全体の成績を出す。
 * ランキングには送らない（惑星が変わるので、1 人用と同じ物差しにならない）
 */
function showTourResult(t: Tour): void {
  running = false;
  paused = false;
  audio.scene('over');
  const reached = t.index + 1;
  const updated = hintUsed ? [] : saveTourRecords({ reached, score: t.score, completed: t.completed });
  const mark = (key: string) =>
    updated.includes(key as never) ? ' <span class="new">新記録</span>' : '';
  overlayKind = 'result';
  overlay.innerHTML = `
    <div class="panel result-panel ${t.completed ? 'won' : 'lost'}">
      <p class="eyebrow">TOUR REPORT</p>
      ${
        t.completed
          ? '<h1 class="win">完走</h1><p class="sub">最果ての惑星まで渡りきった。</p>'
          : `<h1 class="over">滅亡</h1><p class="sub">${t.stage.planet.label} で積みきった。</p>`
      }
      <table class="result">
        <tr><th>到達${mark('reached')}</th><td>${reached} / ${t.stages.length}</td></tr>
        <tr><th>スコア${mark('score')}</th><td>${t.score.toLocaleString()}</td></tr>
        <tr><th>打ち上げ</th><td>${t.totalLaunched}</td></tr>
        <tr><th>最大連続点火</th><td>x${Math.max(1, t.maxCombo)}</td></tr>
        <tr><th>時間</th><td>${formatTime(Math.floor(t.frames / 60))}</td></tr>
      </table>
      ${hintUsed ? `<p class="best">${HINT_NOTE}</p>` : ''}
      <button id="again">もう一度</button>
      <button id="to-menu" class="sub-button">メニューへ</button>
    </div>`;
  overlay.classList.add('shown');
  document.getElementById('again')!.addEventListener('click', playAgain);
  document.getElementById('to-menu')!.addEventListener('click', () => showMenu('top'));
}

function showResult(): void {
  if (tour) {
    showTourResult(tour);
    return;
  }
  running = false;
  paused = false;
  finale = null;
  audio.scene('over');
  const total = game.launched.normal + game.launched.dust + game.launched.rare;
  const seconds = Math.floor(game.frame / 60);
  const run: Run = {
    score: game.score,
    launched: total,
    maxCombo: Math.max(1, game.maxCombo),
    seconds,
  };
  // 記録は 1 人用だけに残す。対戦は相手の攻撃で結果が変わるので、同じ物差しにならない
  const fighting = versus !== null || online !== null;
  const updated = fighting || hintUsed ? [] : saveRecords(run);
  // 得点の代わりに、相手ごとの勝ち負けを数える。
  // 中断（相手の接続が切れた）は勝ちにも負けにもしないので数えない
  const outcome = online ? online.result : versus?.result ?? null;
  const who = opponent();
  const before = who ? findDuel(who.key)?.streak ?? 0 : 0;
  const duel =
    who && outcome && outcome !== 'left' ? recordDuel(who, outcome) : who ? findDuel(who.key) : null;
  const counted = duel !== null && outcome !== null && outcome !== 'left';
  const streak = counted ? streakLine(duel, before) : null;
  const close = marginLine(outcome);
  // 負けたら「リベンジ」。同じ相手ともう一度当たれるとき（CPU と合言葉）だけそう呼ぶ
  const revenge = outcome === 'lose' && (versus !== null || !!lastOnlineCode);
  // 名前はランキングに載せるときに初めて要る。まだなら、ここで決められるようにする
  const named = loadPlayer() !== null;
  // 「ランキングから消す」を選んだ人には、送らず、名前も聞かない
  const ranked = rankingEnabled();
  overlayKind = 'result';
  const mark = (key: string) => (updated.includes(key as never) ? ' <span class="new">新記録</span>' : '');
  const title = !fighting
    ? '<p class="eyebrow">MISSION REPORT</p><h1 class="over">滅亡</h1>'
    : versusTitle(outcome, who?.label ?? '相手');
  const tone = fighting && outcome === 'win' ? 'won' : 'lost';
  // 勝ち負けには見出しの出方を変える（CSS の `.battle.won` と `.battle.lost`）
  const battle = fighting && (outcome === 'win' || outcome === 'lose') ? ' battle' : '';
  overlay.innerHTML = `
    <div class="panel result-panel ${tone}${battle}">
      ${battle && outcome === 'win' ? '<i class="burst"></i>' : ''}
      ${title}
      ${close ? `<p class="verdict">${close}</p>` : ''}
      ${streak ? `<p class="streak">${streak}</p>` : ''}
      <table class="result">
        <tr><th>スコア${mark('score')}</th><td>${game.score.toLocaleString()}</td></tr>
        <tr><th>打ち上げ${mark('launched')}</th><td>${total}</td></tr>
        <tr><th>最大連続点火${mark('maxCombo')}</th><td>x${Math.max(1, game.maxCombo)}</td></tr>
        ${
          game.launched.rare > 0
            ? `<tr><th>レアメタル</th><td>${game.launched.rare} 個</td></tr>`
            : ''
        }
        <tr><th>時間${mark('seconds')}</th><td>${formatTime(seconds)}</td></tr>
      </table>
      ${
        fighting
          ? duel
            ? `<p class="best">${escapeHtml(duel.label)}とは通算 ${formatTally(duel)}</p>`
            : ''
          : hintUsed
            ? `<p class="best">${HINT_NOTE}</p>`
            : !ranked
            ? '<p class="best">ランキングには載せない設定（「記録」の「名前と公開」で戻せる）</p>'
            : `<p id="rank-line" class="best">${
                named ? 'ランキングに送っている…' : '名前を決めるとランキングに載る'
              }</p>${named ? '' : '<div id="result-name"><button id="to-name" class="sub-button">名前を決める</button></div>'}`
      }
      <button id="again">${revenge ? 'リベンジ' : 'もう一度'}</button>
      <button id="to-menu" class="sub-button">メニューへ</button>
    </div>`;
  overlay.classList.add('shown');
  countUp(overlay.querySelector('table.result tr:first-child td'), game.score);
  document.getElementById('again')!.addEventListener('click', playAgain);
  document.getElementById('to-menu')!.addEventListener('click', () => showMenu('top'));
  if (fighting || hintUsed || !ranked) return;
  if (named) {
    void publishResult(run);
    return;
  }
  // 名前を決めるのはあとでもいい。この回のぶんは端末に取っておき、
  // 決まった時点で（結果の画面でも「記録」からでも）送る
  holdScore(run);
  setUpResultName(run);
}

/**
 * 結果の画面から名前を決める。押されたときだけ欄を出す。
 * 遊び終わるたびに入力欄とキーボードが出ると、それだけでうるさい
 */
function setUpResultName(run: Run): void {
  const box = document.getElementById('result-name')!;
  document.getElementById('to-name')!.addEventListener('click', () => {
    audio.ui('confirm');
    box.innerHTML = nameFieldHtml('', '決めて送る');
    setUpNameField(() => {
      box.remove();
      const line = document.getElementById('rank-line');
      if (line) line.textContent = 'ランキングに送っている…';
      void publishResult(run);
    });
  });
}

/**
 * 1 人用の結果をランキングへ送り、順位を結果画面に出す。
 * 送れなくてもゲームの流れは止めない。送り損ねたぶんは次に開いたときに送り直す
 */
async function publishResult(run: Run): Promise<void> {
  const line = document.getElementById('rank-line');
  const player = loadPlayer();
  if (!line) return;
  if (!player) {
    line.textContent = '名前を決めるとランキングに載る';
    return;
  }
  const ranking = await submitScore(player, run);
  // 送っているあいだに次の遊びが始まっていたら、もう出す場所がない
  if (!document.body.contains(line)) return;
  if (!ranking?.self) {
    line.textContent = 'ランキングに送れなかった。次に開いたときに送り直す';
    return;
  }
  const best = ranking.self.score > run.score;
  line.textContent = `ランキング ${ranking.self.rank} 位 / 全 ${ranking.total} 人${
    best ? `（自己最高は ${ranking.self.score.toLocaleString()}）` : ''
  }`;
}

// ------------------------------------------------------------------ ループ

const STEP = 1000 / 60;
let acc = 0;
let last = performance.now();

function frame(now: number): void {
  requestAnimationFrame(frame);

  // メニュー・一時停止・結果のあいだは盤面を進めも描きもしない。
  // 描くのがいちばん重いので、見せる必要がないときは丸ごと止める
  if (!running || paused) {
    last = now;
    acc = 0;
    return;
  }

  // ヒントでゆっくりにしているときは、進める時間を縮める。盤面の進み方そのものは変えない
  acc += Math.min(200, now - last) * timeScale();
  last = now;

  while (acc >= STEP && running) {
    acc -= STEP;
    // 決着の花火と暗転は、盤面を止めているあいだも実時間で進める（音とそろえるため）
    fx.updateShow();
    // 決着の演出のあいだは、止めたりスローにしたりする
    if (finale && !advanceFinale()) continue;
    step();
    fx.update();
  }
  // 音は step ごとではなく rAF ごとに 1 度流す。
  // 遅れを取り戻すために step が何度も回ったとき、同じ時刻へ音が積み上がって割れる
  audio.update(game, boostHeld);
  drawFrame();
}

function step(): void {
  game.boost = boostHeld;
  // CPU 戦では相手の盤面も同じ tick で進む。
  // オンラインでは相手はあちらの端末が進めていて、こちらは自分の盤面だけを進める
  let ev: Events;
  // 相手の出来事。CPU 戦でだけ取れる（攻撃がどの列に刺さったかを描くのに使う）
  let rivalEv: Events | null = null;
  if (online) {
    ev = online.tick();
  } else if (versus) {
    const both = versus.tick();
    ev = both.player;
    rivalEv = both.rival;
  } else if (tour) {
    ev = tour.tick();
  } else {
    ev = game.tick();
  }
  if (hinting()) hinter.update(game, timeScale());
  const dueling = versus !== null || online !== null;
  const L = view.layout;

  if (ev.attackTaken > 0) {
    audio.attackTaken(ev.attackTaken);
    fx.addShake(2 + Math.min(8, ev.attackTaken * 0.6));
    fx.popup(
      L.fieldX + L.fieldW / 2,
      view.rowTop(SCREEN_OUT_ROW - 2),
      `攻撃 ${ev.attackTaken}`,
      '#ff9ad8',
      26,
    );
  }
  if (ev.attackSent > 0) {
    audio.attackSent(ev.attackSent);
    // 溜めていたぶんが相手の盤面へ飛ぶ。音の着弾（`playAttackSent` の遅らせたぶん）と同じ間で届く
    fx.volley(
      view.stockSpan(ev.attackSent),
      view.rivalPoint(),
      ev.attackSent,
      rivalEv ? rivalEv.attackColumns : [],
    );
    fx.addFlash(0.06);
  }
  // 着弾したぶんだけ指にも返す。Android のみで、iOS は振動そのものが無い
  const landed = fx.takeLanded();
  if (landed >= 5) navigator.vibrate?.(18);

  for (const ig of ev.ignitions) {
    audio.ignite(ig.cells.length, ig.combo, ig.vertical, columnPan(ig.cells[0].col));
    const power = Math.min(6, ig.cells.length - 2 + ig.combo * 0.6);
    for (const c of ig.cells) {
      const x = view.colLeft(c.col) + L.cell / 2;
      const y = view.rowTop(c.row) + L.cell / 2;
      fx.blast(x, y, Kind.Triangle, power);
    }
    // 吹き出しは点火したマスの真ん中に出す
    const mid = ig.cells[Math.floor(ig.cells.length / 2)];
    const px = view.colLeft(mid.col) + L.cell / 2;
    const py = view.rowTop(mid.row);
    if (ig.combo >= 2) {
      const color = ig.combo >= 6 ? '#ff9ad8' : ig.combo >= 4 ? '#ffb347' : UI.combo;
      // 倍率の上限に届いた瞬間だけ帯で知らせる。ここから先は何連鎖しても倍率は増えない。
      // 次の点火を急ぐ場面なので、帯は大気圏の中に出し、同じ数を言う連鎖の吹き出しは出さない
      if (ig.combo === SCORE.maxComboMultiplier) {
        fx.airBanner('MAX CHAIN', `${ig.combo} CHAIN · SCORE ×${ig.combo}`, UI.combo, airBannerY(), 70);
        audio.fanfare('maxChain');
      } else {
        fx.chain(px, py, ig.combo, color, 24 + Math.min(26, ig.combo * 3));
      }
      fx.addShake(3 + ig.combo * 1.6);
      fx.addFlash(0.08 + ig.combo * 0.035);
    } else {
      fx.popup(px, py, `${ig.cells.length}`, '#ffffff', 24);
      fx.addShake(2 + ig.cells.length * 0.6);
      fx.addFlash(0.05);
    }
  }

  if (ev.screenOut.length > 0) {
    audio.screenOut(
      ev.screenOut.length,
      ev.screenOutRare,
      columnPan(ev.screenOut[Math.floor(ev.screenOut.length / 2)]),
    );
    const top = view.rowTop(SCREEN_OUT_ROW - 1);
    const stock = view.stockPoint();
    for (const col of ev.screenOut) {
      const x = view.colLeft(col) + L.cell / 2;
      fx.screenOut(x, top, ev.screenOut.length);
      // 対戦では、宇宙へ消えて終わりではなく「送るぶんが溜まった」ところまで見せる
      if (dueling) fx.stockPull(x, top, stock);
    }
    fx.addShake(1.5 + Math.min(10, ev.screenOut.length));
    // レアメタルは 1 個 10,000 点。得点の 1 割を超える 1 手なので、ここだけ別に出す
    if (ev.screenOutRare > 0) {
      learnRareMetal();
      fx.popup(
        L.fieldX + L.fieldW / 2,
        view.rowTop(VISIBLE_ROWS - 2),
        `+${(SCORE.launchRare * ev.screenOutRare).toLocaleString()}`,
        '#ffd2ef',
        40,
      );
      fx.addFlash(0.45);
      fx.addShake(12);
    }
    fx.addFlash(Math.min(0.5, 0.05 * ev.screenOut.length));
    if (ev.screenOut.length >= 3) {
      const col = ev.screenOut[Math.floor(ev.screenOut.length / 2)];
      // 大気圏の帯の中に収める。これより上げると、弾んだ瞬間に得点欄の連鎖と重なる
      fx.popup(view.colLeft(col) + L.cell / 2, top + L.cell, `+${ev.screenOut.length}`, '#bfe9ff', 26);
    }
  }

  if (ev.shot > 0) audio.shoot();
  if (ev.shootCancel > 0) {
    audio.shootCancel();
    fx.popup(L.fieldX + L.fieldW / 2, view.rowTop(10), '+300', '#6de3ff', 24);
  }
  if (ev.airDock > 0) {
    audio.airDock();
    fx.popup(L.fieldX + L.fieldW / 2, view.rowTop(9), 'ドッキング', '#9ef0ff', 24);
  }
  if (ev.rareMetal !== null) {
    audio.rareMetal();
    fx.addFlash(0.4);
    fx.addShake(8);
    for (let r = 0; r < 14; r += 1) {
      fx.burst(view.colLeft(ev.rareMetal) + L.cell / 2, view.rowTop(r) + L.cell / 2, Kind.Spark, 4);
    }
    // 取り方を知らないと、壊せないマスが最下段に溜まるだけになる。
    // 一度も打ち上げたことのない端末では、降ってきたたびに取り方を山のすぐ上の帯で出す（同じことを言う吹き出しは省く）
    if (!knowsRareMetal()) {
      fx.airBanner('RARE METAL', '山の上まで運び、その下で点火して打ち上げる', '#ff9ad8', airBannerY(), 210);
    } else {
      fx.popup(view.colLeft(ev.rareMetal) + L.cell / 2, view.rowTop(8), 'レアメタル', '#ff9ad8', 26);
    }
  }
  if (ev.landed > 0) audio.land(ev.landed, ev.lumpLanded > 0);
  if (ev.reverted > 0) audio.revert(ev.reverted);
  // 指で動かした音。同じフレームに何マスも動いていたら最後の 1 マスだけ鳴らす
  for (const m of ev.moves) {
    audio.step(m.kind, m.row, m.up);
    const t = touches.get(m.finger);
    if (t) t.moved = true;
  }
  if (ev.locked) audio.lock();
  if (ev.screenClear) {
    audio.screenClear();
    fx.addFlash(1);
    fx.airBanner('ALL CLEAR', `全消し +${(game.cols * 1000).toLocaleString()}`, '#ffffff', airBannerY());
  }
  if (ev.danger) audio.danger(game.frame, game.dangerRatio());
  else audio.safe();
  // 予兆（あと 1 段）は出た瞬間に 1 度だけ鳴らし、指にも短く返す。
  // 予兆は盤面の上端に出るので、目線が下にあると見落とす。振動なら目を向けていなくても分かる
  audio.warn(ev.warn);
  if (ev.warn && !wasWarn && !ev.danger) navigator.vibrate?.(20);
  wasWarn = ev.warn;
  // レベルの節目。20 ごとに帯で知らせる（降る速さが上がったことに気づけるように）
  const lv = Math.floor((game.level * 100) / LEVEL_STEP) * LEVEL_STEP;
  if (lv > levelMark) {
    levelMark = lv;
    if (!ev.gameOver) {
      fx.airBanner(lv >= 100 ? 'MAX LEVEL' : 'LEVEL UP', `LV ${lv}`, UI.accent, airBannerY(), 70);
      audio.fanfare('levelUp');
    }
  }
  // 警告が出た瞬間だけ、画面を揺らして指にも返す。
  // 赤い点滅は盤面を見ていないと気づけないが、揺れと振動なら手元でも分かる
  if (ev.danger && !wasDanger) {
    fx.addShake(7);
    navigator.vibrate?.(30);
  }
  wasDanger = ev.danger;
  // 脱出ゲージが満ちた。積みきったのと同じフレームでも、抜けたほうを取る（`Tour.over`）
  if (tour?.escaped) scheduleEscape();
  if (ev.gameOver && !dueling) {
    audio.gameOver();
    fx.addShake(18);
    fx.addFlash(0.6);
    // 決着の帯。結果の画面が出るまでの 0.7 秒に読ませる
    fx.banner('GAME OVER', '滅亡', UI.danger, 120);
    scheduleResult();
    return;
  }
  if (!dueling) return;
  // 対戦の決着。自分が潰れた（投了も含む）か、相手が潰れた。
  // オンラインでは自分が潰れても、相手も同じころに潰れていないかを確かめてから
  // 勝ち負けが決まる（相打ちの判定。`OnlineMatch.resolve`）ので、負けの演出を先に始めて
  // 結果の画面は決着が付くまで待たせる（`advanceFinale`）。
  // 決着してからも盤面は動くので、演出を始めるのは最初の 1 回だけ
  const result = online ? online.result : versus!.result;
  if (!ending) {
    if (game.over || result === 'lose') beginFinale(result === 'draw' ? 'draw' : 'lose');
    else if (result === 'win' || result === 'draw') beginFinale(result);
  } else if (result === 'draw' && finale && finale.outcome !== 'draw') {
    beginFinale('draw');
  }
}

/*
 * 決着の演出の長さ（フレーム）。止める 0.3 秒 → スロー 0.9 秒 → ふつうのあと結果の画面。
 * 以前は決着から 0.7 秒で結果の画面を重ねていて、帯を読む前に急に切り替わって見えた
 */
/** 決着の瞬間に盤面を止める長さ（0.3 秒） */
const FINALE_FREEZE = 18;
/** ここまではスロー（半分の速さ）で流す */
const FINALE_SLOW = 72;
/** 結果の画面を出すまでの長さ。決着の帯を読み終えるまで待つ（2.5 秒） */
const FINALE_LEN = 150;
/**
 * 勝ちは花火の大玉（`GRAND_BOOM` の 2 秒）が開いて枝垂れるのを見せてから結果の画面を出す（3.3 秒）。
 * 2.5 秒で出すと、大玉が開いた直後に結果の画面が重なっていた
 */
const FINALE_LEN_WIN = Math.round((GRAND_BOOM + 1.3) * 60);
/** 触って飛ばせるようになるまでの長さ。最後まで必死に触っていた指で、すぐに飛ばさないように */
const FINALE_SKIP = 48;

/**
 * 決着の帯の長さ。帯も盤面と一緒に止まり、スローのあいだは半分の速さで進むので、
 * 結果の画面が出るちょうどそのときに閉じきる長さにする
 */
function finaleBanner(len: number): number {
  return (FINALE_SLOW - FINALE_FREEZE) / 2 + (len - FINALE_SLOW);
}

/** 負けの暗転で、地平線が暗くなり始めるフレームと、警報が最後に光って消えるフレーム */
const DUSK_HORIZON = Math.round(DUSK_STEPS[0] * 60);
const DUSK_ALARM = Math.round(DUSK_STEPS[DUSK_STEPS.length - 1] * 60);

/**
 * 対戦の決着の演出を始める。盤面を止めて光らせ、帯と音で勝ち負けを知らせる。
 * オンラインで自分が先に潰れたあと相打ちに変わったときは、帯だけを差し替える
 */
function beginFinale(outcome: 'win' | 'lose' | 'draw'): void {
  if (finale) {
    // 負けの演出の途中で、相手も同じころに潰れていたと分かった
    finale.outcome = outcome;
    fx.withdrawCrown();
    fx.banner('DRAW', '相打ち', '#ffffff', finaleBanner(finale.len));
    return;
  }
  ending = true;
  const len = outcome === 'win' ? FINALE_LEN_WIN : FINALE_LEN;
  finale = { t: 0, outcome, len };
  margin = measureMargin();
  // 演出のあいだは盤面を触らせないので、掴んでいたものを離す
  boostHeld = false;
  touches.clear();
  game.release();
  if (outcome === 'win') {
    // 花火（音と絵は `STARMINE` の同じ段取りで上がる）
    audio.victory();
    fx.fireworks(view.fireworksBox());
    fx.addFlash(0.7);
    fx.addShake(14);
    fx.banner('VICTORY', '相手の惑星が滅亡', UI.combo, finaleBanner(len));
    navigator.vibrate?.([40, 60, 40, 60, 120]);
  } else if (outcome === 'lose') {
    // 惑星の明かりが落ちる。盤面が負けの音の 3 音に合わせて暗くなり、相手の盤面が勝ちを名乗る
    audio.gameOver();
    audio.defeat();
    fx.defeat();
    fx.addShake(18);
    fx.addFlash(0.6);
    fx.banner('DEFEAT', '自分の惑星が滅亡', UI.danger, finaleBanner(len));
    navigator.vibrate?.(300);
  } else {
    audio.gameOver();
    fx.addShake(18);
    fx.addFlash(0.6);
    fx.banner('DRAW', '相打ち', '#ffffff', finaleBanner(len));
  }
}

/**
 * 決着の演出を 1 フレーム進める。戻り値はこのフレームに盤面を進めるか。
 * 止める → スロー → ふつう、と流し、帯を読み終えて決着も付いていたら結果の画面を出す
 */
function advanceFinale(): boolean {
  const f = finale!;
  f.t++;
  if (f.outcome !== 'win') {
    if (f.t === DUSK_HORIZON) view.lightsOut('horizon');
    if (f.t === DUSK_ALARM) view.lightsOut('alarm');
  }
  if (f.t >= f.len && outcomeSettled()) {
    showResult();
    return false;
  }
  if (f.t <= FINALE_FREEZE) return false;
  if (f.t <= FINALE_SLOW) return f.t % 2 === 0;
  return true;
}

/** 決着の演出を触って飛ばす。飛ばせるのは少し見せてからで、決着が付いているときだけ */
function skipFinale(): void {
  if (!finale || finale.t < FINALE_SKIP || !outcomeSettled()) return;
  showResult();
}

/** 勝ち負けが決まっているか。オンラインで自分が潰れたときは、相打ちかどうかを待つ */
function outcomeSettled(): boolean {
  return online ? online.result !== null : true;
}

/** 双方の盤面が大気圏まであと何段あったか。決着の瞬間に 1 度だけ測る */
function measureMargin(): typeof margin {
  const rival = versus?.rival ?? online?.rival;
  if (!rival) return null;
  return {
    mine: Math.max(0, VISIBLE_ROWS - game.peak()),
    mineDanger: game.breakTimers.some((t) => t !== null),
    rival: Math.max(0, VISIBLE_ROWS - rival.peak()),
    rivalDanger: rival.dangerRatio() > 0,
  };
}

/** 列の左右の位置（-1 が左端、1 が右端）。音をその列の側から鳴らす */
/**
 * 遊んでいる最中の帯の見出しを置く高さ（帯の真ん中の y）。いちばん高い列のてっぺんの少し上。
 * 目は山のてっぺんから下を見ているので、大気圏の帯に出すとほとんど目に入らなかった
 */
function airBannerY(): number {
  const top = Math.max(0, ...game.ground.map((col) => col.length));
  return view.rowTop(top - 1) - Math.round(view.layout.cell * 0.9);
}

function columnPan(col: number): number {
  return game.cols > 1 ? (col / (game.cols - 1)) * 2 - 1 : 0;
}

/**
 * 少し余韻を置いてから結果を出す。
 * 決着のあとも盤面は動き続けるので、二重に予約しないよう印を立てる
 */
function scheduleResult(): void {
  if (ending) return;
  ending = true;
  setTimeout(showResult, 700);
}

/** 脱出も同じだけ余韻を置く。打ち上げた隕石が宇宙へ抜けきってから画面を出す */
function scheduleEscape(): void {
  if (ending) return;
  ending = true;
  audio.screenClear();
  fx.addFlash(0.5);
  if (tour) fx.banner('ESCAPE', `${tour.stage.planet.label} を脱出`, UI.combo, 120);
  setTimeout(showEscape, 700);
}

// ------------------------------------------------------------------ 新しい版

/**
 * 新版の入れ替え方。docs/decisions.md の「新しい版への入れ替え」。
 * - 起動したとき（裏から戻ったときも）メニューにいて新版が見つかったら、取り終えるまで
 *   「新しい版を読み込んでいる…」で待たせ、取り終えたらすぐ入れ替える。モードを選んだ瞬間に
 *   読み込み直されることが無くなる。新版が無い日は何も待たない
 * - 遊んでいるあいだに見つかったら、取り終えても入れ替えず、アプリが裏に回ったときか
 *   トップメニューに戻ったときに入れ替える
 * - 入れ替えて読み込み直したあとはオープニングを流さず、新版にしたことだけを小さく出す
 */
const updatingEl = document.getElementById('updating') as HTMLDivElement;
const noticeEl = document.getElementById('notice') as HTMLDivElement;

// ------------------------------------------------------------------ お知らせ

const newsToast = document.getElementById('news-toast') as HTMLButtonElement;
const newsOpen = document.getElementById('news-open') as HTMLButtonElement;
/** まだ読んでいないお知らせの数。起動したときに数え、お知らせを開いたら 0 にする */
let newsUnread = 0;
/** 帯を下げる時計 */
let newsToastTimer: number | null = null;
/** 帯を出しておく長さ。読むかどうかを決めるには足り、邪魔になるほどは居座らない */
const NEWS_TOAST_MS = 6000;

/**
 * トップメニューの下に「新しくなった」の帯を出す。触るとお知らせを開く。
 * 画面を塞がず、放っておけば消える。見逃しても隅の「お知らせ」の点が読むまで残る
 */
function showNewsToast(delay: number): void {
  newsToastTimer = window.setTimeout(() => {
    if (menuPage !== 'top' || newsUnread === 0) return;
    newsToast.hidden = false;
    newsToastTimer = window.setTimeout(hideNewsToast, NEWS_TOAST_MS);
  }, delay);
}

function hideNewsToast(): void {
  if (newsToastTimer !== null) clearTimeout(newsToastTimer);
  newsToastTimer = null;
  newsToast.hidden = true;
}

/** 隅の「お知らせ」に、未読があるあいだだけ点を付ける */
function showNewsDot(): void {
  newsOpen.classList.toggle('unread', newsUnread > 0);
}

function setUpNews(): void {
  const open = (): void => {
    audio.unlock();
    audio.ui('confirm');
    showMenu('news');
  };
  newsToast.addEventListener('click', open);
  newsOpen.addEventListener('click', open);
}
/** 新版を取り終えるまで待たせる長さの上限。電波が弱くてこれを越えたら、遊ばせてあとで入れ替える */
const UPDATE_WAIT_MS = 8000;
let updateWaitTimer: number | null = null;
/** 取り終えて、入れ替えを後回しにしている新版 */
let deferredUpdate: (() => void) | null = null;

/** 読み込み直しても失うものが無いか。メニューを見ているだけのとき（相手を待っているあいだは回線が切れるので除く） */
function idleInMenu(): boolean {
  return menuPage !== null && menuPage !== 'waiting';
}

function onUpdateDownloading(): void {
  if (!idleInMenu() || !updatingEl.hidden) return;
  settleIntro();
  updatingEl.hidden = false;
  updateWaitTimer = window.setTimeout(hideUpdating, UPDATE_WAIT_MS);
}

function hideUpdating(): void {
  if (updateWaitTimer !== null) clearTimeout(updateWaitTimer);
  updateWaitTimer = null;
  updatingEl.hidden = true;
}

function onUpdateReady(apply: () => void): void {
  // 待たせていたなら、その場で入れ替える
  if (!updatingEl.hidden) {
    apply();
    return;
  }
  deferredUpdate = apply;
}

/** 後回しにしていた新版を入れ替える。トップメニューに戻ったときと、裏に回ったときに呼ぶ */
function applyDeferredUpdate(): void {
  const apply = deferredUpdate;
  deferredUpdate = null;
  apply?.();
}

// 裏に回った瞬間なら、読み込み直しても目に入らない。遊んでいる途中（一時停止を含む）は盤面が消えるので待つ
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden' || !deferredUpdate) return;
  if (idleInMenu() || (!running && overlayKind === 'result')) applyDeferredUpdate();
});

setUpUpdates({ downloading: onUpdateDownloading, ready: onUpdateReady, failed: hideUpdating });
setUpBuildFooter();
audio.loadMuted();
setUpMuteButton();
// 初めて開いたときは id だけ発行しておく。
// 名前は、ランキングに載せるときと対戦のときに聞く（最初に名前を聞くと、遊ぶ前に手間が増える）
// id を作る前に、前から遊んでいる人かを見ておく（お知らせをどこから知らせるかが変わる）
const returning = hasUserId();
ensureUserId();
newsUnread = unreadNews(returning);
setUpNews();
showNewsDot();
// 新版に入れ替えた直後は、オープニングをもう 1 度流さない（「やり直された」ように見える）
const updated = takeUpdatedMark();
if (updated) introPending = false;
// 新しい版にしたことは、お知らせがあればその帯で、無ければ小さな知らせだけで伝える
if (updated && newsUnread === 0) {
  noticeEl.textContent = '新しい版にした';
  noticeEl.hidden = false;
  window.setTimeout(() => (noticeEl.hidden = true), 3200);
}
showMenu('top');
// オープニングが流れるなら、終わってから出す（題字と重ならないように）
if (newsUnread > 0) showNewsToast(menuEl.classList.contains('intro') ? 2600 : 400);
// 前に送れなかった結果があれば、ここで送り直す
void flushPending();
requestAnimationFrame(frame);

// 動作確認と e2e のために内部を触れるようにしておく
let debugMeteorId = 1_000_000;
let debugUpdatesApplied = 0;

(window as unknown as { __novaria: unknown }).__novaria = {
  get game() {
    return game;
  },
  get running() {
    return running && !paused;
  },
  /** メニューのどの画面を出しているか。遊んでいる最中は null */
  get menu() {
    return menuPage;
  },
  /** オープニングを流している最中か。e2e が演出の有無と終わりを見る */
  get intro() {
    return menuEl.classList.contains('intro');
  },
  start: () => startGame(null),
  /** CPU と対戦しているときだけ入る。e2e から相手の盤面と勝敗を見る */
  get versus() {
    return versus;
  },
  startVersus(level: CpuLevel = 'easy'): void {
    startGame(level);
  },
  /** 決着の演出が始まってからのフレーム数。演出をしていなければ null */
  get finale() {
    return finale?.t ?? null;
  },
  /** 惑星めぐり。e2e から脱出と惑星の移り変わりを見る */
  get tour() {
    return tour;
  },
  startTour(): void {
    startTour();
  },
  /** オンライン対戦。相手を探しているあいだも入っている */
  get online() {
    return online;
  },
  /** 合言葉を渡すと、その言葉で相手を探す。e2e が 2 つの端末をつなぐための入口 */
  startOnline(code: string | null = null): void {
    startOnline(code);
  },
  /** 練習のヒントの矢印。出していなければ null */
  /** いまのゲームの速さ（1 が通常）。ヒントを使うときだけ遅くできる */
  get speed() {
    return timeScale();
  },
  get hint() {
    return hinting() ? hinter.arrow(game) : null;
  },
  view,
  fx,
  /** 鳴らした音の並びと、いま鳴っている音源の数。e2e から見る */
  audio,
  /** 新版を見に行った回数。e2e が起動時と復帰時の確認を数えるために見る */
  get updateChecks() {
    return updateCheckCount();
  },
  /**
   * 新版の知らせを偽って流す。preview には新しい版が無いので、e2e は入れ替えの流れをここで見る。
   * ready で渡す入れ替えは、呼ばれた回数を `updatesApplied` に数えるだけ
   */
  fakeUpdate(step: 'downloading' | 'ready' | 'failed'): void {
    if (step === 'downloading') onUpdateDownloading();
    else if (step === 'ready') onUpdateReady(() => debugUpdatesApplied++);
    else hideUpdating();
  },
  get updatesApplied() {
    return debugUpdatesApplied;
  },
  /**
   * 盤面を組み直す。列ごとに、下から積む種類を渡す。
   * 降ってくる隕石と空中のカタマリは消える。e2e が狙った局面を作るための入口
   */
  setColumns(columns: Kind[][]): void {
    game.ground = game.ground.map((_, col) =>
      (columns[col] ?? []).map(
        (kind): Meteor => ({ id: debugMeteorId++, kind, revert: 0, fromAttack: false, ignitedAt: -1 }),
      ),
    );
    game.fallings = [];
    game.lumps = [];
  },
};
