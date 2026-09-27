import { ATMOSPHERE_ROWS, SCORE, SCREEN_OUT_ROW, VISIBLE_ROWS } from '../core/constants';
import { Game, burnHeat } from '../core/game';
import type { HintArrow } from '../core/hint';
import { Kind, isRareMetal, type Meteor, type RivalView } from '../core/types';
import { Effects } from './effects';
import { glowSprite, rgba } from './glow';
import { DEFAULT_LOOK, LOOKS, PLANET_LOOKS, UI, type PlanetLook } from './theme';
import { TILE_RADIUS, bakedFlame, drawTile, makeBakeCanvas, roundRect, setTileScale } from './tile';

/** 得点の並びの左右の余白 */
const HUD_PAD = 14;
/** 練習のヒントの色。盤面の差し色（水色）とも連鎖の黄色とも混ざらない緑にする */
const HINT_COLOR = '#8dffb4';
/**
 * 盤面が下から組み上がる演出の長さ（フレーム）。ゲームを始めた直後と、惑星を渡った直後に流れる。
 * 描き方を変えるだけで、ゲームはその間も進んでいる（降ってくる隕石が大気圏に届くより短い）
 */
const REVEAL_FRAMES = 36;
const SANS = "'Hiragino Sans', 'Noto Sans JP', system-ui, sans-serif";
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace";
/** 得点の桁数。下 1 桁だけ動いても並びがずれないよう、この桁数ぶんの場所を先に取る */
const SCORE_DIGITS = 7;

/**
 * 盤面の動かない部分（ガラス・格子・目盛り・大気圏・発射台）を焼いた 1 枚。
 * 毎フレーム線を何十本も引く代わりに、これを 1 回貼る
 */
interface Chrome {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 字間を空ける。対応していない端末では何もしない（詰まって出るだけ） */
function spacing(ctx: CanvasRenderingContext2D, px: number): void {
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${px}px`;
}

/** 出だしが速く、終わりがゆっくりの補間 */
function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t) * (1 - t);
}

export interface Layout {
  cell: number;
  fieldX: number;
  /** 盤面の一番下（row 0 の下辺）の画面 y */
  fieldBottomY: number;
  fieldW: number;
  fieldH: number;
  hudY: number;
  /** 一時停止ボタンの四角。得点の並びの左端 */
  pause: { x: number; y: number; size: number };
  boostY: number;
  boostH: number;
  width: number;
  height: number;
}

/**
 * 脱出ゲージ。惑星めぐりのときだけ渡す。
 * 打ち上げた数が目標に届くと、その惑星を抜けて次へ進む
 */
export interface Escape {
  /** いまいる惑星の名前 */
  label: string;
  launched: number;
  goal: number;
}

export class View {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  layout!: Layout;
  /** いまの列数。盤面の枠を焼き直すときに使う */
  private cols = 9;
  /** 盤面の動かない部分を焼いたもの。配置か惑星が変わったら捨てて、次に描くときに焼き直す */
  private chrome: Chrome | null = null;
  /** 列を塗る光の帯（予兆・警告・掴んでいる列）。色ごとに焼いておく */
  private lanes = new Map<string, HTMLCanvasElement>();
  /** 加速の帯。離しているときと押しているときの 2 枚 */
  private boostPlates: [HTMLCanvasElement, HTMLCanvasElement] | null = null;
  /** 得点の表示。実際の得点へ数フレームかけて数え上がる */
  private shownScore = 0;
  /** 連鎖の数字を弾ませる。増えた瞬間に 1、数フレームで 0 に戻る */
  private comboPunch = 0;
  private lastCombo = 0;
  private scoreOf: Game | null = null;
  /** いま body に渡している空の色。同じ値を書き込み直さないために覚えておく */
  private sky = '';
  /** 画面の縁の赤い脈を出しているか */
  private alarm = false;
  /** いまいる惑星の色。惑星めぐりで惑星ごとに入れ替える */
  private look: PlanetLook = DEFAULT_LOOK;
  /** 相手のミニ盤面の場所。攻撃の弾の飛び先にも使うので resize で決めておく */
  private rivalBox = { x: 0, y: 6, w: 0, h: 0, cell: 3 };
  /** 送るのを待っている攻撃の隕石の置き場。右端をミニ盤面の左に合わせ、左へ並べる */
  private stock = { right: 0, y: 0, size: 6 };
  /** 相手の積み上がり（0〜1）。1 フレームごとの出入りで跳ねないよう均した値 */
  private rivalFill = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context を取れない');
    this.ctx = ctx;
    this.resize(9);
  }

  /** 画面の大きさに合わせて canvas と配置を作り直す */
  resize(cols: number): void {
    this.cols = cols;
    this.chrome = null;
    this.lanes.clear();
    this.boostPlates = null;
    const w = window.innerWidth;
    const h = window.innerHeight;
    // 3 倍だと塗る画素が 2 倍の 2.25 倍になり、スマホでフレームが落ちる。
    // 2 倍でも隕石の縁のなめらかさは保てる
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    setTileScale(this.dpr);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;

    // 盤面は画面幅いっぱいに近づけ、上に大気圏、下に加速の帯を置く。
    // マスの大きさと左上は整数にする。焼いた隕石の絵をそのまま貼れて、拡大縮小の計算が要らなくなる
    const cell = Math.floor(
      Math.min((w * 0.98) / cols, h / (VISIBLE_ROWS + ATMOSPHERE_ROWS + 3.4)),
    );
    const fieldW = cell * cols;
    const fieldH = cell * VISIBLE_ROWS;
    const boostH = Math.max(56, cell * 1.15);
    const fieldBottomY = Math.round(h - boostH - cell * 0.5);

    const fieldX = Math.round((w - fieldW) / 2);

    // 一時停止ボタンは得点の並びの左端に、行の高さに合わせて置く。
    // 得点の上ではなく行の中に置くのは、16:9 の端末（iPhone SE など）では
    // 得点の並びが画面の上端まで来て、上に何も入らないため
    const hudY = Math.max(fieldBottomY - fieldH - cell * ATMOSPHERE_ROWS - cell * 1.35, 10);
    const btn = Math.round(Math.min(cell * 0.8, 36));

    this.layout = {
      cell,
      fieldX,
      fieldBottomY,
      fieldW,
      fieldH,
      hudY,
      pause: { x: fieldX + HUD_PAD, y: Math.round(hudY + cell * 0.17 - btn / 2), size: btn },
      boostY: h - boostH,
      boostH,
      width: w,
      height: h,
    };

    // 相手のミニ盤面と、攻撃の装填の場所。毎フレーム同じなのでここで決めておく。
    // 攻撃の弾はここへ飛ぶので、描くときに計算すると 1 フレーム遅れた場所を狙うことになる
    const miniTop = 6;
    const miniRoom = this.rowTop(VISIBLE_ROWS + ATMOSPHERE_ROWS - 1) - miniTop - 18;
    const miniCell = Math.max(3, Math.floor(miniRoom / SCREEN_OUT_ROW));
    this.rivalBox = {
      x: fieldX + fieldW - miniCell * cols,
      y: miniTop,
      w: miniCell * cols,
      h: miniCell * SCREEN_OUT_ROW,
      cell: miniCell,
    };
    this.stock = {
      right: this.rivalBox.x - HUD_PAD,
      y: Math.round(hudY + cell * 1.1),
      size: Math.max(5, Math.round(cell * 0.2)),
    };

    // 背景の惑星の地平線（`#backdrop .horizon`）を盤面の下辺に合わせる
    document.documentElement.style.setProperty('--ground-y', `${fieldBottomY}px`);
  }

  /**
   * 惑星の色に切り替える。空の上下は動かないので CSS 変数に 1 度だけ渡し、
   * 真ん中（`--sky-mid`）は滅亡が近いと赤くなるので `applySky` が毎フレーム見る。
   * 知らない惑星の名前が来たら母星の色にする
   */
  setPlanet(name: string): void {
    const look = PLANET_LOOKS[name] ?? DEFAULT_LOOK;
    if (look === this.look) return;
    this.look = look;
    this.chrome = null;
    const root = document.documentElement.style;
    root.setProperty('--sky-top', look.skyTop);
    root.setProperty('--sky-bottom', look.skyBottom);
    // 背景の地平線も惑星の地面の色にする
    root.setProperty('--ground', look.ground);
    root.setProperty('--ground-edge', look.groundEdge);
    // 空の真ん中も、次に盤面を描くのを待たずにここで塗り替える。
    // 描くまで待つと、惑星が変わった直後の 1 フレームに前の惑星の空が残る。
    // 新しい惑星の盤面は組み直したところなので、滅亡の近さは 0 でよい
    this.sky = '';
    this.applySky(0);
  }

  /** 勝ちの花火を上げる範囲。発射台から大気圏のあたりまで、盤面の幅いっぱい */
  fireworksBox(): { left: number; right: number; top: number; bottom: number } {
    const L = this.layout;
    return { left: L.fieldX, right: L.fieldX + L.fieldW, top: this.rowTop(SCREEN_OUT_ROW - 1), bottom: L.fieldBottomY };
  }

  /**
   * 負けて惑星の明かりが落ちる。地平線を暗くし、警報の赤い縁を最後に 1 度光らせて消す。
   * どちらも CSS の opacity を動かすだけで、canvas は塗り直さない
   */
  lightsOut(step: 'horizon' | 'alarm'): void {
    if (step === 'horizon') document.getElementById('backdrop')?.classList.add('dusk');
    else document.getElementById('alarm')?.classList.add('last');
  }

  /** 明かりを戻す。新しい盤面を始めるときに呼ぶ */
  lightsOn(): void {
    document.getElementById('backdrop')?.classList.remove('dusk');
    document.getElementById('alarm')?.classList.remove('last');
  }

  /** 攻撃の弾が飛んでいく先（相手のミニ盤面の真ん中） */
  rivalPoint(): { x: number; y: number } {
    return { x: this.rivalBox.x + this.rivalBox.w / 2, y: this.rivalBox.y + this.rivalBox.h / 2 };
  }

  /** 打ち上げた隕石が吸い寄せられる先（送るのを待っている攻撃の隕石の置き場） */
  stockPoint(): { x: number; y: number } {
    return { x: this.stock.right - this.stock.size, y: this.stock.y };
  }

  /** 並んでいる攻撃の隕石の左端から右端まで。飛び立つ場所を散らすのに使う */
  stockSpan(count: number): { x0: number; x1: number; y: number } {
    const s = this.stock;
    const gap = Math.max(2, Math.round(s.size * 0.35));
    const n = Math.max(1, Math.min(10, count));
    return { x0: s.right - n * (s.size + gap), x1: s.right - s.size, y: s.y };
  }

  /** 世界座標 row の「マスの上辺」の画面 y */
  rowTop(row: number): number {
    return this.layout.fieldBottomY - (row + 1) * this.layout.cell;
  }

  colLeft(col: number): number {
    return this.layout.fieldX + col * this.layout.cell;
  }

  /** 画面座標を盤面の (col, row) に直す */
  toBoard(px: number, py: number): { col: number; row: number } {
    const { cell, fieldX, fieldBottomY } = this.layout;
    return { col: Math.floor((px - fieldX) / cell), row: (fieldBottomY - py) / cell - 0 };
  }

  /**
   * rival を渡すと、得点欄の横に相手の盤面を小さく出す（対戦）。
   * 見出しは CPU 戦なら「相手」、オンライン対戦では相手の名前
   */
  draw(
    game: Game,
    fx: Effects,
    boostHeld: boolean,
    rival?: RivalView | null,
    rivalName = '相手',
    escape: Escape | null = null,
    hint: { arrow: HintArrow | null } | null = null,
  ): void {
    const ctx = this.ctx;
    const L = this.layout;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, L.width, L.height);

    const danger = game.dangerRatio();
    this.applySky(danger);

    ctx.save();
    fx.applyShake(ctx);
    // 始まった直後は、盤面が下から走査線で組み上がる
    const reveal = game.frame < REVEAL_FRAMES ? easeOut(game.frame / REVEAL_FRAMES) : 1;
    const from = L.fieldBottomY + L.cell;
    const scanY = from - (from - this.rowTop(SCREEN_OUT_ROW - 1) + 12) * reveal;
    if (reveal < 1) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, scanY, L.width, L.height - scanY);
      ctx.clip();
    }
    this.drawField(ctx, game, danger);
    this.drawBlocks(ctx, game, fx);
    if (hint?.arrow) this.drawHint(ctx, hint.arrow, game.frame);
    // 負けの暗い幕。隕石の上に敷き、粒と花火はその上に出す
    fx.drawDim(ctx, L.fieldX, this.rowTop(SCREEN_OUT_ROW - 1), L.fieldW, L.fieldBottomY);
    if (reveal < 1) {
      ctx.restore();
      this.drawScanLine(ctx, scanY, 1 - reveal);
    }
    fx.draw(ctx, L.fieldX, L.fieldX + L.fieldW);
    fx.drawShow(ctx);
    ctx.restore();

    this.drawHud(ctx, game, fx, rival ?? null, rivalName, escape);
    if (hint) this.drawHintTag(ctx);
    this.drawBoost(ctx, boostHeld, game.frame);
    // 帯の見出しは盤面の真ん中より少し上に、揺れの外で出す
    fx.drawBanner(ctx, L.fieldX, L.fieldW, this.rowTop(7) + L.cell / 2, L.cell);
    // 攻撃の弾は得点の並びと相手のミニ盤面の上を通るので、盤面の粒とは分けてここで描く
    fx.drawOverlay(ctx);
    fx.drawFlash(ctx, L.width, L.height);
    ctx.restore();
  }

  /**
   * 空の色。CSS 変数で body に渡す。
   * 全画面のグラデーションを毎フレーム canvas に塗ると、スマホで 1 フレーム 40ms 以上かかる。
   * メニューへ戻るときは danger 0 で呼んで、赤い空を戻す
   */
  applySky(danger: number): void {
    // 毎フレーム style を触ると要らない再計算が出るので、色が変わったときだけ書き込む
    // 危ないときの赤はどの惑星でも同じにする。色が惑星ごとに変わると警告として読めない
    // 画面の縁の赤い脈（`#alarm`）は、赤くなり始めた瞬間と戻った瞬間だけ切り替える
    if (danger > 0 !== this.alarm) {
      this.alarm = danger > 0;
      document.getElementById('alarm')?.classList.toggle('on', this.alarm);
    }
    const mid = danger > 0 ? `rgb(${Math.round(20 + danger * 60)},4,26)` : this.look.skyMid;
    if (mid === this.sky) return;
    this.sky = mid;
    document.documentElement.style.setProperty('--sky-mid', mid);
  }

  /** 盤面を組み上げている走査線。left は残り（1 から 0 へ） */
  private drawScanLine(ctx: CanvasRenderingContext2D, y: number, left: number): void {
    const L = this.layout;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(1, left * 3);
    ctx.drawImage(glowSprite(UI.accent), L.fieldX - 30, y - 16, L.fieldW + 60, 32);
    ctx.fillStyle = '#e8fbff';
    ctx.fillRect(L.fieldX, y - 1, L.fieldW, 2);
    ctx.restore();
  }

  /**
   * 盤面の動かない部分を焼く。上から順に、大気圏（斜線の網）、盤面のガラス、1 列おきの帯、
   * 格子の十字、左右の柱と高さの目盛り、四隅の括弧、大気圏の線、発射台。
   * 惑星の色を使うので、惑星が変わったときも焼き直す
   */
  private bakeChrome(): Chrome {
    const L = this.layout;
    const look = this.look;
    const cols = this.cols;
    const cell = L.cell;
    const fx = L.fieldX;
    const fw = L.fieldW;
    const bottom = L.fieldBottomY;
    const top = this.rowTop(VISIBLE_ROWS - 1);
    const atmoTop = this.rowTop(VISIBLE_ROWS + ATMOSPHERE_ROWS - 1);
    const groundH = Math.round(cell * 0.5);
    const x0 = fx - 8;
    const y0 = atmoTop - 8;
    const w = fw + 16;
    const h = bottom + groundH + 8 - y0;
    const ctx = makeBakeCanvas(w, h);
    ctx.translate(-x0, -y0);

    // 大気圏。上ほど宇宙に溶け、斜線の網を薄く張る
    const ag = ctx.createLinearGradient(0, atmoTop, 0, top);
    ag.addColorStop(0, rgba(UI.accent, 0));
    ag.addColorStop(1, rgba(UI.accent, 0.13));
    ctx.fillStyle = ag;
    ctx.fillRect(fx, atmoTop, fw, top - atmoTop);
    ctx.save();
    ctx.beginPath();
    ctx.rect(fx, atmoTop, fw, top - atmoTop);
    ctx.clip();
    ctx.strokeStyle = rgba(UI.accent, 0.07);
    ctx.lineWidth = 1;
    ctx.beginPath();
    const span = top - atmoTop;
    for (let x = fx - span; x < fx + fw; x += 9) {
      ctx.moveTo(x, top);
      ctx.lineTo(x + span, atmoTop);
    }
    ctx.stroke();
    ctx.restore();

    // 盤面のガラス。後ろの星と地平線の照り返しが少し透ける
    const glass = ctx.createLinearGradient(0, top, 0, bottom);
    glass.addColorStop(0, rgba(look.field, 0.86));
    glass.addColorStop(1, rgba(look.field, 0.7));
    ctx.fillStyle = glass;
    ctx.fillRect(fx, top, fw, bottom - top);
    const shine = ctx.createLinearGradient(0, bottom, 0, bottom - L.fieldH * 0.45);
    shine.addColorStop(0, rgba(look.groundEdge, 0.26));
    shine.addColorStop(1, rgba(look.groundEdge, 0));
    ctx.fillStyle = shine;
    ctx.fillRect(fx, bottom - L.fieldH * 0.45, fw, L.fieldH * 0.45);

    // 1 列おきの帯。どの列を触っているかを目で追いやすくする
    ctx.fillStyle = 'rgba(255,255,255,0.022)';
    for (let c = 1; c < cols; c += 2) ctx.fillRect(fx + c * cell, atmoTop, cell, bottom - atmoTop);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    for (let c = 1; c < cols; c++) ctx.fillRect(fx + c * cell, atmoTop, 1, bottom - atmoTop);

    // 格子の交点の十字。隕石の角の隙間から覗く
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    const arm = Math.max(2, Math.round(cell * 0.07));
    for (let r = 1; r < VISIBLE_ROWS; r++) {
      const y = bottom - r * cell;
      for (let c = 1; c < cols; c++) {
        const x = fx + c * cell;
        ctx.fillRect(x - arm, y, arm * 2 + 1, 1);
        ctx.fillRect(x, y - arm, 1, arm * 2 + 1);
      }
    }

    // 左右の柱。地面に近いほど明るい
    for (const x of [fx, fx + fw - 1.5]) {
      const rail = ctx.createLinearGradient(0, bottom, 0, atmoTop);
      rail.addColorStop(0, rgba(UI.accent, 0.65));
      rail.addColorStop(0.7, rgba(UI.accent, 0.16));
      rail.addColorStop(1, rgba(UI.accent, 0.05));
      ctx.fillStyle = rail;
      ctx.fillRect(x, atmoTop, 1.5, bottom - atmoTop);
    }
    // 高さの目盛り。3 段ごとに長くする
    for (let r = 1; r < SCREEN_OUT_ROW; r++) {
      const y = bottom - r * cell;
      const long = r % 3 === 0;
      const len = Math.round(cell * (long ? 0.2 : 0.1));
      ctx.fillStyle = rgba(UI.accent, long ? 0.5 : 0.28);
      ctx.fillRect(fx, y, len, 1);
      ctx.fillRect(fx + fw - len, y, len, 1);
    }

    // 上の四隅の括弧。盤面が宇宙へ開いた口であることを示す
    const b = Math.round(cell * 0.42);
    ctx.strokeStyle = rgba(UI.accent, 0.75);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(fx + 1, atmoTop + b);
    ctx.lineTo(fx + 1, atmoTop + 1);
    ctx.lineTo(fx + b, atmoTop + 1);
    ctx.moveTo(fx + fw - 1, atmoTop + b);
    ctx.lineTo(fx + fw - 1, atmoTop + 1);
    ctx.lineTo(fx + fw - b, atmoTop + 1);
    ctx.stroke();

    // 大気圏の線。ここを越えると宇宙へ抜ける。光りは薄い帯と細い線の 2 段で出す
    ctx.fillStyle = rgba('#96d2ff', 0.13);
    ctx.fillRect(fx, top - 2, fw, 5);
    ctx.fillStyle = rgba('#96d2ff', 0.62);
    ctx.fillRect(fx, top, fw, 1);
    for (let c = 1; c < cols; c++) ctx.fillRect(fx + c * cell, top - 2, 1, 5);
    ctx.font = `700 ${Math.max(8, Math.round(cell * 0.19))}px ${SANS}`;
    spacing(ctx, Math.max(1.5, cell * 0.05));
    ctx.fillStyle = rgba(UI.accent, 0.42);
    ctx.textAlign = 'right';
    ctx.fillText('ATMOSPHERE', fx + fw - cell * 0.28, top - 6);
    ctx.textAlign = 'left';
    spacing(ctx, 0);

    // 発射台。地面の縁を明るく光らせ、列ごとに継ぎ目と灯を入れる
    const rise = ctx.createLinearGradient(0, bottom, 0, bottom - cell * 0.35);
    rise.addColorStop(0, rgba(look.groundEdge, 0.45));
    rise.addColorStop(1, rgba(look.groundEdge, 0));
    ctx.fillStyle = rise;
    ctx.fillRect(fx, bottom - cell * 0.35, fw, cell * 0.35);
    const plate = ctx.createLinearGradient(0, bottom, 0, bottom + groundH);
    plate.addColorStop(0, look.ground);
    plate.addColorStop(1, rgba(look.ground, 0.35));
    ctx.fillStyle = plate;
    ctx.fillRect(fx, bottom, fw, groundH);
    ctx.fillStyle = look.groundEdge;
    ctx.fillRect(fx, bottom, fw, 2);
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fillRect(fx, bottom, fw, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    for (let c = 1; c < cols; c++) ctx.fillRect(fx + c * cell, bottom + 3, 1, groundH * 0.6);
    const lamp = glowSprite(look.groundEdge);
    const lr = Math.max(3, cell * 0.09);
    for (let c = 0; c < cols; c++) {
      const x = fx + c * cell + cell / 2;
      ctx.drawImage(lamp, x - lr * 2, bottom + groundH * 0.42 - lr * 2, lr * 4, lr * 4);
    }

    return { canvas: ctx.canvas, x: x0, y: y0, w, h };
  }

  /**
   * 列を塗る光の帯。上（大気圏の線の側）が濃く、下へ薄れる。左右の縁に細い線を立てる。
   * 列 1 本ぶんを色ごとに焼いておき、明るさは貼るときの globalAlpha で揺らす
   */
  private lane(color: string): HTMLCanvasElement {
    const hit = this.lanes.get(color);
    if (hit) return hit;
    const { cell, fieldH } = this.layout;
    const ctx = makeBakeCanvas(cell, fieldH);
    const g = ctx.createLinearGradient(0, 0, 0, fieldH);
    g.addColorStop(0, rgba(color, 0.5));
    g.addColorStop(0.5, rgba(color, 0.18));
    g.addColorStop(1, rgba(color, 0.08));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cell, fieldH);
    const edge = ctx.createLinearGradient(0, 0, 0, fieldH);
    edge.addColorStop(0, rgba(color, 1));
    edge.addColorStop(1, rgba(color, 0.2));
    ctx.fillStyle = edge;
    ctx.fillRect(0, 0, 1.5, fieldH);
    ctx.fillRect(cell - 1.5, 0, 1.5, fieldH);
    this.lanes.set(color, ctx.canvas);
    return ctx.canvas;
  }

  private drawField(ctx: CanvasRenderingContext2D, game: Game, danger: number): void {
    const L = this.layout;
    const top = this.rowTop(VISIBLE_ROWS - 1);
    this.chrome ??= this.bakeChrome();
    const chrome = this.chrome;
    ctx.drawImage(chrome.canvas, chrome.x, chrome.y, chrome.w, chrome.h);

    // 滅亡が近いあいだは盤面のガラスを赤く染める
    if (danger > 0) {
      ctx.fillStyle = UI.fieldBgDanger;
      ctx.globalAlpha = 0.25 + 0.35 * danger;
      ctx.fillRect(L.fieldX, top, L.fieldW, L.fieldH);
      ctx.globalAlpha = 1;
    }

    // 大気圏の線の上を、光の粒がゆっくり横切る。線がただの区切りではなく「境界」に見える
    const sweep = (game.frame * 2.2) % (L.fieldW + 240);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.55;
    ctx.drawImage(glowSprite('#96d2ff'), L.fieldX - 120 + sweep - 60, top - 6, 120, 12);
    ctx.restore();

    // 掴んでいる列を光らせる。指の下に隠れた隕石でも、どの列を動かしているかが分かる
    const drag = game.dragPosition();
    if (drag) {
      ctx.globalAlpha = 0.5;
      ctx.drawImage(this.lane(UI.accent), this.colLeft(drag.col), top, L.cell, L.fieldH);
      ctx.globalAlpha = 1;
    }

    // 予兆の列。あと 1 段で危ない。赤い警告より弱く、ゆっくり脈打たせて先に気づかせる
    for (let c = 0; c < game.cols; c++) {
      if (!game.warnings[c]) continue;
      const pulse = 0.5 + 0.5 * Math.abs(Math.sin(game.frame * 0.07));
      ctx.globalAlpha = 0.3 + 0.35 * pulse;
      ctx.drawImage(this.lane(UI.warn), this.colLeft(c), top, L.cell, L.fieldH);
      // 大気圏の線の上に帯を置く。「あと 1 段でここ」を指す
      ctx.fillStyle = UI.warn;
      ctx.globalAlpha = 0.35 + 0.4 * pulse;
      ctx.fillRect(this.colLeft(c) + 1, top - 4, L.cell - 2, 3);
      ctx.globalAlpha = 1;
    }

    // 危ない列の赤い点滅。残り猶予が減るほど速く点滅し、大気圏の線の帯が短くなる
    for (let c = 0; c < game.cols; c++) {
      const timer = game.breakTimers[c];
      if (timer === null) continue;
      const left = Math.max(0, Math.min(1, timer / game.breakFrames));
      const blink = 0.35 + 0.45 * Math.abs(Math.sin(game.frame * (0.22 + 0.34 * (1 - left))));
      ctx.globalAlpha = Math.min(1, blink * 1.3);
      ctx.drawImage(this.lane(UI.danger), this.colLeft(c), top, L.cell, L.fieldH);
      ctx.globalAlpha = 1;
      // 残り猶予。線の上の帯が端から減っていくので、あとどれだけかが読める
      ctx.fillStyle = 'rgba(255,59,92,0.3)';
      ctx.fillRect(this.colLeft(c) + 1, top - 5, L.cell - 2, 4);
      ctx.fillStyle = UI.danger;
      ctx.fillRect(this.colLeft(c) + 1, top - 5, (L.cell - 2) * left, 4);
    }
    if (danger > 0) this.drawDangerSign(ctx, game.frame, danger);
  }

  /**
   * 大気圏の帯に出す「DANGER」の札。黄と黒の斜線の帯で挟み、点滅させる。
   * 赤い列と画面の縁だけだと「何が起きているか」が字で読めない
   */
  private drawDangerSign(ctx: CanvasRenderingContext2D, frame: number, danger: number): void {
    const L = this.layout;
    const top = this.rowTop(VISIBLE_ROWS - 1);
    const atmoTop = this.rowTop(VISIBLE_ROWS + ATMOSPHERE_ROWS - 1);
    const cy = Math.round((atmoTop + top) / 2);
    const h = Math.round(L.cell * 0.62);
    // 残りが減るほど速く点滅する（列の赤と同じ速さ）
    const blink = 0.55 + 0.45 * Math.abs(Math.sin(frame * (0.12 + 0.2 * danger)));
    ctx.save();
    ctx.globalAlpha = blink;
    ctx.fillStyle = 'rgba(40,2,10,0.7)';
    ctx.fillRect(L.fieldX, cy - h / 2, L.fieldW, h);
    // 上下の斜線の帯。流して、止まった表示に見せない
    const stripe = Math.max(6, Math.round(L.cell * 0.18));
    const band = Math.max(3, Math.round(h * 0.14));
    ctx.beginPath();
    ctx.rect(L.fieldX, cy - h / 2, L.fieldW, band);
    ctx.rect(L.fieldX, cy + h / 2 - band, L.fieldW, band);
    ctx.clip();
    ctx.fillStyle = UI.danger;
    ctx.fillRect(L.fieldX, cy - h / 2, L.fieldW, h);
    ctx.fillStyle = 'rgba(10,0,4,0.85)';
    ctx.beginPath();
    const shift = (frame * 0.8) % (stripe * 2);
    for (let x = L.fieldX - stripe * 2 + shift; x < L.fieldX + L.fieldW + stripe; x += stripe * 2) {
      ctx.moveTo(x, cy + h / 2);
      ctx.lineTo(x + stripe, cy + h / 2);
      ctx.lineTo(x + stripe + h, cy - h / 2);
      ctx.lineTo(x + h, cy - h / 2);
      ctx.closePath();
    }
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = blink;
    ctx.font = `italic 900 ${Math.round(h * 0.5)}px ${SANS}`;
    spacing(ctx, Math.max(2, L.cell * 0.12));
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffe1e6';
    ctx.fillText('DANGER', L.fieldX + L.fieldW / 2, cy + h * 0.18);
    spacing(ctx, 0);
    ctx.restore();
  }

  private drawBlocks(ctx: CanvasRenderingContext2D, game: Game, fx: Effects): void {
    const L = this.layout;
    const drag = game.dragPosition();
    const dragMeteorId = drag?.meteor.id ?? -1;
    const atmoTop = this.rowTop(VISIBLE_ROWS + ATMOSPHERE_ROWS - 1);

    ctx.save();
    ctx.beginPath();
    ctx.rect(L.fieldX, atmoTop, L.fieldW, L.fieldBottomY - atmoTop);
    ctx.clip();

    // 噴射の炎。カタマリの下から出す。
    // 推進が切れて浮いているあいだも出し続ける。
    // ゆっくり降りてくるのはこの炎で支えているから、という見え方にする
    for (const lump of game.lumps) {
      // 上昇が速いほど炎を長くする。推進が切れたら一定の長さで燃やし続ける
      const power = lump.thrustFrames > 0 ? 1 + Math.min(2.5, lump.vy * 5) : 0.9;
      for (const col of new Set(lump.cells.map((c) => c.col))) {
        const cells = lump.cells.filter((c) => c.col === col).sort((a, b) => a.rel - b.rel);
        const y = this.rowTop(lump.y + cells[0].rel) + L.cell;
        const x = this.colLeft(col) + L.cell / 2;
        this.drawFlame(ctx, x, y, power, game.frame + col * 7);
        // 炎そのものを大きくしたので、粒は増やさない。増やすと上限に張り付いて爆発の破片が消える
        fx.thrust(x, y, power * 0.6);
      }
    }

    // 空中のカタマリは輪郭を光らせて、地面と見分けられるようにする。
    // 線を引くのはカタマリの外周だけ（隣に仲間のマスが無い辺だけ）。
    // マスごとに四角を描くと内側にも線が入って、カタマリが格子に見える。
    // 光りは shadowBlur ではなく、太い薄線の上に細い濃線を重ねて出す。
    // shadowBlur はマスごとにぼかしを作り直すので、5 マスのカタマリだけで 1 フレーム 11ms かかっていた
    for (const lump of game.lumps) {
      const rising = lump.vy > 0;
      const glow = rising ? 'rgba(255,170,60,0.35)' : 'rgba(120,180,255,0.28)';
      const line = rising ? 'rgba(255,214,120,0.85)' : 'rgba(150,200,255,0.55)';
      const w = Math.max(2, L.cell * 0.09);
      const has = new Set(lump.cells.map((c) => `${c.col},${c.rel}`));
      const edge = (ax: number, ay: number, bx: number, by: number): void => {
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      };
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // 道は 1 度だけ組み、太い線と細い線で 2 回なぞる
      ctx.beginPath();
      for (const cell of lump.cells) {
        const x0 = this.colLeft(cell.col);
        const x1 = x0 + L.cell;
        const y0 = this.rowTop(lump.y + cell.rel);
        const y1 = y0 + L.cell;
        // rel が大きいほど上（rowTop は row が増えると上に行く）
        if (!has.has(`${cell.col},${cell.rel + 1}`)) edge(x0, y0, x1, y0);
        if (!has.has(`${cell.col},${cell.rel - 1}`)) edge(x0, y1, x1, y1);
        if (!has.has(`${cell.col - 1},${cell.rel}`)) edge(x0, y0, x0, y1);
        if (!has.has(`${cell.col + 1},${cell.rel}`)) edge(x1, y0, x1, y1);
      }
      for (const pass of [0, 1]) {
        ctx.strokeStyle = pass === 0 ? glow : line;
        ctx.lineWidth = pass === 0 ? w * 3 : w;
        ctx.stroke();
      }
      ctx.restore();
    }

    for (const cell of game.allCells()) {
      if (cell.meteor.id === dragMeteorId) continue;
      this.drawOne(ctx, fx, cell.col, cell.row, cell.meteor, game);
    }

    if (drag) {
      // 掴んでいる隕石は少し大きくして浮かせる。
      // 影は shadowBlur ではなく、下に敷く黒い角丸で出す（なぞっているあいだ毎フレーム走るため）
      const x = this.colLeft(drag.col);
      const y = this.rowTop(drag.row);
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.38)';
      roundRect(ctx, x - L.cell * 0.04, y + L.cell * 0.06, L.cell * 1.08, L.cell * 1.08, L.cell * TILE_RADIUS * 1.1);
      ctx.fill();
      ctx.translate(x + L.cell / 2, y + L.cell / 2);
      ctx.scale(1.12, 1.12);
      ctx.translate(-(x + L.cell / 2), -(y + L.cell / 2));
      drawTile(ctx, drag.meteor.kind, x, y, L.cell);
      // 掴んでいる印の光る縁。太い薄線に細い濃線を重ねる
      roundRect(ctx, x + L.cell * 0.02, y + L.cell * 0.02, L.cell * 0.96, L.cell * 0.96, L.cell * TILE_RADIUS);
      ctx.strokeStyle = rgba(UI.accent, 0.35);
      ctx.lineWidth = Math.max(3, L.cell * 0.12);
      ctx.stroke();
      ctx.strokeStyle = '#e8fbff';
      ctx.lineWidth = Math.max(1.5, L.cell * 0.035);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  /**
   * 練習のヒント。運ぶ隕石を縁取り、運び先を点線の枠で囲んで、そのあいだを矢印でつなぐ。
   * 光りは shadowBlur を使わず、太い薄線の上に細い濃線を重ねて出す
   */
  private drawHint(ctx: CanvasRenderingContext2D, arrow: HintArrow, frame: number): void {
    const L = this.layout;
    const x = this.colLeft(arrow.col);
    const fromY = this.rowTop(arrow.from);
    const toY = this.rowTop(arrow.to);
    const cx = x + L.cell / 2;
    // 運ぶ向き。rowTop は row が増えると上へ行くので、画面の y では符号が逆になる
    const dir = toY > fromY ? 1 : -1;
    const pulse = 0.65 + 0.35 * Math.sin(frame * 0.15);
    const thick = Math.max(5, L.cell * 0.2);
    const thin = Math.max(2, L.cell * 0.07);
    const pass = (path: () => void, dash: number[] = []): void => {
      ctx.setLineDash(dash);
      path();
      ctx.strokeStyle = rgba('#0a2a18', 0.55 * pulse);
      ctx.lineWidth = thick;
      ctx.stroke();
      ctx.strokeStyle = rgba(HINT_COLOR, pulse);
      ctx.lineWidth = thin;
      ctx.stroke();
    };
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    pass(() => {
      ctx.beginPath();
      roundRect(ctx, x + 2, fromY + 2, L.cell - 4, L.cell - 4, L.cell * TILE_RADIUS);
    });
    pass(
      () => {
        ctx.beginPath();
        roundRect(ctx, x + 3, toY + 3, L.cell - 6, L.cell - 6, L.cell * TILE_RADIUS);
      },
      [L.cell * 0.14, L.cell * 0.1],
    );
    // 矢印は運ぶ隕石の真ん中から、運び先の真ん中まで。隣へ 1 マス運ぶだけの手でも見えるよう、隕石の上に重ねる
    const y0 = fromY + L.cell / 2;
    const y1 = toY + L.cell / 2;
    const head = L.cell * 0.24;
    ctx.fillStyle = rgba(HINT_COLOR, 0.9 * pulse);
    ctx.beginPath();
    ctx.arc(cx, y0, L.cell * 0.1, 0, Math.PI * 2);
    ctx.fill();
    pass(() => {
      ctx.beginPath();
      ctx.moveTo(cx, y0);
      ctx.lineTo(cx, y1);
      ctx.moveTo(cx - head, y1 - dir * head);
      ctx.lineTo(cx, y1);
      ctx.lineTo(cx + head, y1 - dir * head);
    });
    ctx.restore();
  }

  /** ヒントをつけている印。一時停止ボタンの下に出す（このゲームは記録に残らない） */
  private drawHintTag(ctx: CanvasRenderingContext2D): void {
    const L = this.layout;
    const size = Math.max(9, Math.round(L.cell * 0.22));
    ctx.save();
    ctx.font = `800 ${size}px ${SANS}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = HINT_COLOR;
    spacing(ctx, Math.max(1.5, L.cell * 0.05));
    ctx.fillText('HINT', L.pause.x, L.pause.y + L.pause.size + size + 4);
    spacing(ctx, 0);
    ctx.restore();
  }

  /**
   * 噴射の炎。粒だけだと細くて気づかないので、炎そのものを形で描く。
   * 焼いておいた舌を 2 枚、幅と長さを変えて貼る（`tile.ts` の `bakedFlame`）。
   * x はマスの中央、y は炎が出る口（マスの下辺）。frame は揺らぎの位相
   */
  private drawFlame(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    power: number,
    frame: number,
  ): void {
    const L = this.layout;
    // 周期の違う 2 つの波を混ぜて、規則正しい明滅に見えないようにする
    const flicker = 0.82 + 0.18 * Math.sin(frame * 0.55) + 0.09 * Math.sin(frame * 1.37);
    const len = L.cell * (1.5 + power * 0.7) * flicker;
    const w = L.cell * (0.62 + power * 0.16);
    const tex = bakedFlame(L.cell);
    const top = y - L.cell * 0.14;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(tex, x - w / 2, top, w, len);
    // 内側にもう 1 本、細くて長い舌を、揺らぎの位相をずらして重ねる
    const inner = w * 0.52;
    ctx.globalAlpha = 0.8;
    ctx.drawImage(tex, x - inner / 2, top, inner, len * (1.15 + 0.18 * Math.sin(frame * 0.83)));
    ctx.restore();
  }

  private drawOne(
    ctx: CanvasRenderingContext2D,
    fx: Effects,
    col: number,
    row: number,
    meteor: Meteor,
    game: Game,
  ): void {
    const L = this.layout;
    const kind = meteor.kind;
    const x = this.colLeft(col);
    const y = this.rowTop(row);
    const opts: Parameters<typeof drawTile>[5] = {};
    if (kind === Kind.Dust && meteor.revert > 0) {
      const total = Math.max(1, game.planet.revertDustStart);
      opts.revertProgress = Math.max(0, 1 - meteor.revert / total);
    }
    // 点火したての燃えカスは、まだ火が回っている（`burnHeat` は点火からの経過で出す。
    // 還元までの残りで測ると、空中のカタマリは還元が進まないので燃えっぱなしになる）
    const heat = burnHeat(meteor, game.frame);
    if (heat > 0) {
      // 半ばまでは燃えたまま、そこから薄れて燃えカスに戻る。
      // 明るさを揺らすと点滅して見えるので、揺らぎは炎の駒の切り替えだけで出す
      opts.burn = Math.min(1, heat * 1.6);
      opts.burnPhase = Math.floor(game.frame / 4) + col * 2 + Math.round(row);
      // 火の粉はマスごとに 6 フレームに 1 個。位相を散らして、揃って弾けないようにする。
      // ここを増やすと噴射のぶんと合わせて粒の上限に張り付き、爆発の破片が先に消える
      if (heat > 0.3 && (game.frame + col * 3 + Math.round(row)) % 6 === 0) {
        fx.ember(x + L.cell / 2, y + L.cell * 0.35, heat, L.cell * 0.6);
      }
    }
    if (isRareMetal(kind)) opts.shimmer = 0.5 + 0.5 * Math.sin(game.frame * 0.25);
    drawTile(ctx, kind, x, y, L.cell, opts);
  }

  private drawHud(
    ctx: CanvasRenderingContext2D,
    game: Game,
    fx: Effects,
    rival: RivalView | null,
    rivalName: string,
    escape: Escape | null,
  ): void {
    const L = this.layout;
    const pad = HUD_PAD;
    const y = L.hudY;
    // 相手の盤面は得点欄の右端に置く。時間と LV はそのぶん左へ寄せる
    const miniW = rival ? this.drawRival(ctx, rival, rivalName, fx) : 0;
    this.drawPauseButton(ctx);

    const labelFont = `800 ${Math.max(9, Math.round(L.cell * 0.22))}px ${SANS}`;
    const labelGap = Math.max(1.5, L.cell * 0.05);
    ctx.textAlign = 'left';
    ctx.font = labelFont;
    spacing(ctx, labelGap);
    // 時間と LV は右端。対戦では相手の盤面のぶん左へ寄せる
    const right = L.fieldX + L.fieldW - pad - miniW;
    // 得点は一時停止ボタンの右から。打ち上げ数はその右に置く。
    // 得点は 7 桁ぶんの場所を先に取る（下 1 桁だけ動いても並びがずれないように）
    const scoreX = L.pause.x + L.pause.size + 12;
    const digits = Math.round(L.cell * 0.62);
    const secondX = Math.max(L.fieldX + L.fieldW * (rival ? 0.5 : 0.53), scoreX + digits * 5);
    // 惑星めぐりでは、打ち上げ数の代わりにいまいる惑星と脱出ゲージを出す
    const label = escape ? escape.label : 'LAUNCH';
    // 横に細長い画面では、得点と時間のあいだに入らない。
    // 重ねて出すより落とす（打ち上げ数は一時停止と結果でも見られる）
    const room = secondX + ctx.measureText(label).width < right - L.cell * 1.2;

    // 見出しの頭に差し色の小さな四角を置く。計器の札のように見せる
    const tag = (text: string, x: number, color: string = UI.accent): void => {
      const s = Math.max(3, Math.round(L.cell * 0.09));
      ctx.fillStyle = color;
      ctx.fillRect(x, Math.round(y - s - L.cell * 0.05), s, s);
      ctx.fillStyle = UI.textDim;
      ctx.fillText(text, x + s + 5, y);
    };
    tag('SCORE', scoreX);
    if (room) tag(label, secondX, escape ? UI.combo : UI.accent);
    spacing(ctx, 0);

    // 得点。実際の値へ数フレームかけて数え上げる。上の桁の 0 は沈めて、効いている桁だけ光らせる
    if (game !== this.scoreOf || game.score < this.shownScore) {
      this.scoreOf = game;
      this.shownScore = game.score;
    } else if (this.shownScore < game.score) {
      this.shownScore += Math.ceil((game.score - this.shownScore) * 0.22);
    }
    const shown = Math.min(10 ** SCORE_DIGITS - 1, this.shownScore);
    const text = String(shown).padStart(SCORE_DIGITS, '0');
    const lead = SCORE_DIGITS - String(shown).length;
    const valueY = y + L.cell * 0.66;
    ctx.font = `900 ${digits}px ${MONO}`;
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fillText(text.slice(0, lead), scoreX, valueY);
    const litX = scoreX + ctx.measureText(text.slice(0, lead)).width;
    const lit = text.slice(lead);
    const counting = this.shownScore < game.score;
    // 数え上げているあいだは差し色のにじみを敷く
    if (counting) {
      ctx.lineJoin = 'round';
      ctx.strokeStyle = rgba(UI.accent, 0.35);
      ctx.lineWidth = Math.max(3, digits * 0.16);
      ctx.strokeText(lit, litX, valueY);
    }
    ctx.fillStyle = counting ? '#dff8ff' : UI.text;
    ctx.fillText(lit, litX, valueY);

    const total = game.launched.normal + game.launched.dust + game.launched.rare;
    const value = escape
      ? `${Math.min(999, escape.launched)}/${escape.goal}`
      : String(Math.min(9999, total));
    ctx.fillStyle = UI.text;
    if (room) ctx.fillText(value, secondX, valueY);

    // 脱出ゲージ。数字の右から、時間の下（ゲームレベルを出していた場所）までを使う
    if (escape) {
      const barX = room ? secondX + ctx.measureText(value).width + 10 : secondX;
      this.drawEscapeBar(ctx, barX, right, y + L.cell * 0.45, escape);
    }

    // 経過時間とゲームレベル
    const sec = Math.floor(game.frame / 60);
    ctx.textAlign = 'right';
    ctx.font = `700 ${Math.round(L.cell * 0.34)}px ${MONO}`;
    ctx.fillStyle = UI.textDim;
    ctx.fillText(
      `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`,
      right,
      y,
    );
    // 惑星めぐりでは、ここは脱出ゲージが使う
    if (!escape) {
      const lv = String(Math.round(game.level * 100));
      ctx.font = `900 ${Math.round(L.cell * 0.44)}px ${MONO}`;
      ctx.fillStyle = UI.text;
      ctx.fillText(lv, right, valueY);
      const lvW = ctx.measureText(lv).width;
      ctx.font = labelFont;
      spacing(ctx, labelGap);
      ctx.fillStyle = UI.textDim;
      ctx.fillText('LV', right - lvW - 6, valueY);
      spacing(ctx, 0);
    }

    ctx.textAlign = 'left';
    // いま続いている連鎖。得点の数字の下、大気圏の帯までの隙間に置く
    this.drawCombo(ctx, game, scoreX, right - scoreX);
    // 相手へ送るのを待っている攻撃の隕石
    if (rival) this.drawStock(ctx, game.pendingAttack);
  }

  /**
   * いま続いている連鎖の倍率と、切れるまでの残り。
   * 点火の得点は「マス数 × この倍率」で、得点の 8 割がここで決まる。
   * 点火の瞬間の吹き出しだけだと「まだ続いているか」が分からないので、続くあいだ出しておく。
   * 倍率は上限（10）までの目盛りの点灯で、残りはその下の細い帯で出す
   */
  private drawCombo(
    ctx: CanvasRenderingContext2D,
    game: Game,
    x: number,
    room: number,
  ): void {
    const combo = game.combo;
    if (combo > this.lastCombo) this.comboPunch = 1;
    this.lastCombo = combo;
    this.comboPunch = Math.max(0, this.comboPunch - 0.12);
    if (combo <= 0) return;
    const L = this.layout;
    const max = SCORE.maxComboMultiplier;
    const capped = combo >= max;
    const color = capped ? UI.combo : UI.accent;
    // 得点の数字（baseline は hudY + 0.66 マス）の下。大気圏の帯は hudY + 1.35 マスから
    const y = L.hudY + L.cell * 1.04;
    const h = Math.max(4, Math.round(L.cell * 0.16));

    const text = `×${combo}`;
    ctx.font = `italic 900 ${Math.round(L.cell * 0.4)}px ${MONO}`;
    // 目盛りの位置は弾む前の幅で決める（弾むたびに目盛りが横へ揺れないように）
    const barX = Math.round(x + ctx.measureText(text).width + 8);
    // 増えた瞬間だけ数字を大きくして白く光らせる。左下を支点に膨らませる
    const punch = this.comboPunch * this.comboPunch;
    ctx.save();
    ctx.translate(x, y + h);
    ctx.scale(1 + punch * 0.45, 1 + punch * 0.45);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = rgba(color, 0.3 + punch * 0.4);
    ctx.lineWidth = Math.max(3, L.cell * 0.1);
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = punch > 0.3 ? '#ffffff' : color;
    ctx.fillText(text, 0, 0);
    ctx.restore();
    const pip = Math.max(4, Math.round(L.cell * 0.13));
    const gap = Math.max(2, Math.round(pip * 0.4));
    const barW = Math.min(max * (pip + gap) - gap, room - (barX - x) - 4);
    if (barW < L.cell * 0.4) return;
    const count = Math.min(max, Math.floor((barW + gap) / (pip + gap)));

    // 倍率の目盛り。斜めに切った札を並べ、いまの倍率まで点ける
    const pipH = Math.max(4, Math.round(h * 0.95));
    const slant = Math.round(pipH * 0.35);
    for (let i = 0; i < count; i++) {
      const px = barX + i * (pip + gap);
      ctx.fillStyle = i < combo ? color : 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.moveTo(px + slant, y);
      ctx.lineTo(px + pip + slant, y);
      ctx.lineTo(px + pip, y + pipH);
      ctx.lineTo(px, y + pipH);
      ctx.closePath();
      ctx.fill();
    }

    // 残り。空中にカタマリがあるあいだは切れないので満ちたまま
    const ratio = game.comboRatio();
    const w = count * (pip + gap) - gap + slant;
    const ty = y + pipH + 3;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(barX, ty, w, 2);
    if (ratio > 0) {
      ctx.fillStyle = color;
      ctx.fillRect(barX, ty, Math.max(2, w * ratio), 2);
    }
  }

  /**
   * 脱出ゲージ。あと何個打ち上げればこの惑星を抜けるかを帯で出す。
   * 数字だけだと残りが読めないので満ち具合を見せる。
   * 描くのは角丸 2 つだけで、ぼかしは使わない（マスごとに作り直すと重い）
   */
  private drawEscapeBar(
    ctx: CanvasRenderingContext2D,
    x0: number,
    x1: number,
    midY: number,
    escape: Escape,
  ): void {
    const L = this.layout;
    const w = x1 - x0;
    // 帯が入らないほど狭い画面では出さない。数字だけでも残りは読める
    if (w < L.cell * 0.8) return;
    const h = Math.max(4, Math.round(L.cell * 0.18));
    const top = Math.round(midY - h / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    roundRect(ctx, x0, top, w, h, h / 2);
    ctx.fill();
    const ratio = Math.max(0, Math.min(1, escape.launched / escape.goal));
    if (ratio <= 0) return;
    // 満ちたら色を変える。次の惑星へ進む合図
    const color = ratio >= 1 ? UI.combo : UI.accent;
    ctx.strokeStyle = rgba(color, 0.3);
    ctx.lineWidth = h;
    roundRect(ctx, x0, top, Math.max(h, w * ratio), h, h / 2);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fill();
  }

  /**
   * 送るのを待っている攻撃の隕石。数字ではなく弾として並べる。
   * 打ち上げるたびにここへ吸い寄せられ、1 秒静かになると相手の盤面へ飛んでいく
   */
  private drawStock(ctx: CanvasRenderingContext2D, count: number): void {
    if (count <= 0) return;
    const s = this.stock;
    const gap = Math.max(2, Math.round(s.size * 0.35));
    const n = Math.min(10, count);
    const glow = glowSprite('#ffd257');
    for (let i = 0; i < n; i++) {
      // 左へ行くほど薄くして、並びの端が切れて見えないようにする
      const cx = s.right - (i + 1) * (s.size + gap) + s.size / 2;
      const half = s.size * 0.62;
      ctx.globalAlpha = 1 - i * 0.05;
      ctx.drawImage(glow, cx - s.size * 1.4, s.y - s.size * 1.4, s.size * 2.8, s.size * 2.8);
      ctx.fillStyle = '#ffd257';
      ctx.beginPath();
      ctx.moveTo(cx, s.y - half);
      ctx.lineTo(cx + half * 0.8, s.y);
      ctx.lineTo(cx, s.y + half);
      ctx.lineTo(cx - half * 0.8, s.y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // 10 個より多いぶんは並べきれないので数で出す
    if (count > n) {
      ctx.fillStyle = '#ffd257';
      ctx.font = `800 ${Math.round(this.layout.cell * 0.3)}px ${MONO}`;
      ctx.textAlign = 'right';
      ctx.fillText(`${count}`, s.right - n * (s.size + gap) - 4, s.y + s.size / 2);
      ctx.textAlign = 'left';
    }
  }

  /**
   * 一時停止ボタン。得点の並びを押しても止まるが、それだけでは気づけないので印を出す。
   * ぼかしは使わず、丸い枠と縦線 2 本で描く
   */
  private drawPauseButton(ctx: CanvasRenderingContext2D): void {
    const { x, y, size } = this.layout.pause;
    const c = size / 2;

    ctx.beginPath();
    ctx.arc(x + c, y + c, c - 1, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fill();
    ctx.strokeStyle = rgba(UI.accent, 0.4);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const barW = Math.max(2, Math.round(size * 0.1));
    const barH = Math.round(size * 0.36);
    const barY = Math.round(y + (size - barH) / 2);
    const gap = Math.round(size * 0.12);
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.fillRect(Math.round(x + c - gap / 2 - barW), barY, barW, barH);
    ctx.fillRect(Math.round(x + c + gap / 2), barY, barW, barH);
  }

  /**
   * 相手の盤面を小さく描く。使った幅を返す。
   * 焼いた隕石の絵は貼らずに色の四角だけを並べる。
   * 焼いた絵の置き場はマスの大きさ 1 つぶんしか持てないので、ここで `drawTile` を呼ぶと
   * 大小 2 つの大きさで毎フレーム焼き直しになり、盤面の描画ごと遅くなる
   */
  private drawRival(
    ctx: CanvasRenderingContext2D,
    rival: RivalView,
    label: string,
    fx: Effects,
  ): number {
    const L = this.layout;
    const { x, y: top, w, h, cell } = this.rivalBox;
    const bottom = top + h;
    const danger = rival.dangerRatio();
    const hit = fx.rivalHit;

    ctx.save();
    if (hit > 0) {
      // 着弾した瞬間だけ膨らませる。色の四角が数個増えるのは小さくて気づけないが、
      // 盤面ごと動けば目の端でも分かる
      const cx = x + w / 2;
      const cy = top + h / 2;
      const scale = 1 + 0.16 * hit;
      ctx.translate(cx, cy);
      ctx.scale(scale, scale);
      ctx.translate(-cx, -cy);
    }

    ctx.fillStyle = 'rgba(6,8,24,0.82)';
    ctx.fillRect(x, top, w, h);
    // 1 段ごとの細い横線。小さな盤面でも計器の画面に見える
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    for (let r = 1; r < SCREEN_OUT_ROW; r++) ctx.fillRect(x, bottom - r * cell, w, 1);

    // 描きながら列ごとの積み上がりも数える。盤面を 2 度なぞらないため
    const heights = new Array<number>(rival.cols).fill(0);
    for (const c of rival.allCells()) {
      if (c.row < VISIBLE_ROWS && c.col >= 0 && c.col < heights.length) heights[c.col] += 1;
      const cy = bottom - (c.row + 1) * cell;
      if (cy < top - cell || cy > bottom) continue;
      ctx.fillStyle = c.meteor.kind === Kind.Dust ? '#4a4a55' : LOOKS[c.meteor.kind].light;
      ctx.fillRect(x + c.col * cell, cy, cell - 0.5, cell - 0.5);
    }

    if (hit > 0) {
      // 刺さった列を上から光らせる。オンラインでは列が届かないので、そのときは盤面全体だけ光る
      ctx.fillStyle = `rgba(255,210,87,${0.4 * hit})`;
      for (const col of fx.rivalHitCols) ctx.fillRect(x + col * cell, top, cell - 0.5, cell * 3);
      ctx.fillStyle = `rgba(255,255,255,${0.16 * hit})`;
      ctx.fillRect(x, top, w, h);
    }

    // 滅亡が近い相手は枠が赤く点滅する。着弾のあいだは金色が勝つ
    if (hit > 0.15) {
      ctx.strokeStyle = `rgba(255,222,140,${0.5 + 0.5 * hit})`;
      ctx.lineWidth = 2.5;
    } else {
      ctx.strokeStyle =
        danger > 0
          ? `rgba(255,59,92,${0.4 + 0.5 * Math.abs(Math.sin(rival.frame * 0.22))})`
          : rgba(UI.accent, 0.22);
      ctx.lineWidth = danger > 0 ? 2 : 1;
    }
    ctx.strokeRect(x - 0.5, top - 0.5, w + 1, h + 1);
    // 四隅の括弧。自分の盤面の枠と同じ意匠にする
    const b = Math.max(5, Math.round(w * 0.12));
    ctx.strokeStyle = danger > 0 ? UI.danger : rgba(UI.accent, 0.8);
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [cx, cy, dx, dy] of [
      [x - 1, top - 1, 1, 1],
      [x + w + 1, top - 1, -1, 1],
      [x - 1, bottom + 1, 1, -1],
      [x + w + 1, bottom + 1, -1, -1],
    ]) {
      ctx.moveTo(cx, cy + b * dy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + b * dx, cy);
    }
    ctx.stroke();
    // 負けたとき、相手の盤面が金色に光って「WIN」と名乗る。誰に負けたのかを目に残す
    const crown = fx.rivalWins;
    if (crown > 0.01) {
      const pulse = 0.75 + 0.25 * Math.sin(rival.frame * 0.15);
      ctx.fillStyle = `rgba(255,232,115,${0.22 * crown * pulse})`;
      ctx.fillRect(x, top, w, h);
      ctx.strokeStyle = `rgba(255,232,115,${crown})`;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(x - 1.5, top - 1.5, w + 3, h + 3);
      ctx.globalAlpha = crown;
      ctx.font = `italic 900 ${Math.round(Math.min(w * 0.36, L.cell * 0.56))}px 'Hiragino Sans', system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(20,12,0,0.85)';
      ctx.strokeText('WIN', x + w / 2, top + h * 0.56);
      ctx.fillStyle = '#ffe873';
      ctx.fillText('WIN', x + w / 2, top + h * 0.56);
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
    }
    ctx.restore();

    // 相手の積み上がり。効いているかどうかは四角の増減より棒のほうが読める。
    // 均さないと、降っている隕石の出入りで毎フレーム跳ねる
    let worst = 0;
    for (const n of heights) worst = Math.max(worst, n);
    this.rivalFill += (Math.min(1, worst / VISIBLE_ROWS) - this.rivalFill) * 0.12;
    const gaugeW = 4;
    const gaugeX = x - gaugeW - 4;
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(gaugeX, top, gaugeW, h);
    const fillH = Math.round(h * this.rivalFill);
    ctx.fillStyle =
      this.rivalFill > 0.8 ? UI.danger : this.rivalFill > 0.55 ? '#ffd257' : '#4fd6a0';
    ctx.fillRect(gaugeX, bottom - fillH, gaugeW, fillH);

    // 見出しは盤面の下に置く。上に置くと画面のふちで切れる
    ctx.font = `800 ${Math.round(L.cell * 0.26)}px ${SANS}`;
    ctx.fillStyle = danger > 0 ? UI.danger : UI.textDim;
    ctx.textAlign = 'right';
    // 長い名前は切る。右詰めなので、そのまま出すと得点の上まで伸びる
    const chars = [...label];
    ctx.fillText(chars.length > 6 ? `${chars.slice(0, 6).join('')}…` : label, x + w, bottom + 13);

    // 送り込んだ個数。自分が食らうときの「攻撃 N」と対になる。
    // 盤面の真ん中に重ねる。横に出すと時計と場所を取り合う
    if (hit > 0.05 && fx.rivalHitCount > 0) {
      ctx.globalAlpha = Math.min(1, hit * 1.6);
      ctx.font = `900 ${Math.round(Math.min(w * 0.42, L.cell * 0.62))}px 'Hiragino Sans', system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      const ny = top + h * 0.5 + L.cell * 0.2 - (1 - hit) * 10;
      ctx.strokeText(`+${fx.rivalHitCount}`, x + w / 2, ny);
      ctx.fillStyle = '#ffd257';
      ctx.fillText(`+${fx.rivalHitCount}`, x + w / 2, ny);
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'left';
    return w + 22;
  }

  /**
   * 加速の帯の地。離しているときと押しているときの 2 枚を焼いておく。
   * 角丸の中を時の色のグラデーションで塗り、上の縁に細い光を入れる
   */
  private bakeBoostPlates(): [HTMLCanvasElement, HTMLCanvasElement] {
    const L = this.layout;
    const ring = LOOKS[Kind.Ring];
    const w = L.fieldW;
    const h = L.boostH - 14;
    const plate = (held: boolean): HTMLCanvasElement => {
      const ctx = makeBakeCanvas(w, h);
      const r = h * 0.28;
      roundRect(ctx, 1, 1, w - 2, h - 2, r);
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, rgba(ring.dark, held ? 0.34 : 0.1));
      g.addColorStop(1, rgba(ring.dark, held ? 0.16 : 0.03));
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = held ? ring.light : rgba(ring.dark, 0.4);
      ctx.lineWidth = held ? 2 : 1;
      ctx.stroke();
      // 上の縁の光
      ctx.fillStyle = rgba(ring.light, held ? 0.5 : 0.18);
      ctx.fillRect(r, 2, w - r * 2, 1);
      return ctx.canvas;
    };
    return [plate(false), plate(true)];
  }

  private drawBoost(ctx: CanvasRenderingContext2D, held: boolean, frame: number): void {
    const L = this.layout;
    const ring = LOOKS[Kind.Ring];
    const x = L.fieldX;
    const w = L.fieldW;
    // 押している間は上辺だけ 2px 下げて、帯が沈んだように見せる
    const y = L.boostY + 6 + (held ? 2 : 0);
    const base = L.boostH - 14;
    const h = base - (held ? 2 : 0);

    ctx.save();
    this.boostPlates ??= this.bakeBoostPlates();
    ctx.drawImage(this.boostPlates[held ? 1 : 0], x, y, w, h);

    // シェブロンは帯の幅に合わせて 3〜7 本。1 本につき 2 つを半周期ずらして流す。
    // 大きさと本数は沈み込む前の高さから出す（沈んだときに本数が変わらないように）
    const cols = Math.max(3, Math.min(7, Math.round(w / (base * 1.5))));
    const travel = base * 0.34;
    const hw = base * 0.3;
    const hh = base * 0.15;
    // シェブロンの上端ではなく真ん中が cy なので、流れる幅の半分だけ戻せば帯の中央に来る
    const top = y + h / 2 - travel / 2;
    // 押すと 4 倍の速さで流れる
    const phase = (frame / 60) * (held ? 1.9 : 0.45);
    ctx.strokeStyle = held ? ring.light : '#c9f5e2';
    ctx.lineWidth = Math.max(2.5, base * 0.1);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (held) ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < cols; i += 1) {
      const cx = x + (w * (i + 0.5)) / cols;
      for (let k = 0; k < 2; k += 1) {
        // 左から右へわずかに遅らせると、帯ぜんぶが同時に明滅するより流れて見える
        const p = (phase + k * 0.5 + i * 0.06) % 1;
        // 出るときと消えるときに薄くして、上下の端で途切れて見えないようにする
        ctx.globalAlpha = (held ? 0.95 : 0.38) * Math.sin(p * Math.PI);
        const cy = top + travel * p;
        ctx.beginPath();
        ctx.moveTo(cx - hw, cy - hh);
        ctx.lineTo(cx, cy + hh);
        ctx.lineTo(cx + hw, cy - hh);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /** 加速の帯に触れているか */
  inBoost(px: number, py: number): boolean {
    const L = this.layout;
    return py >= L.boostY && px >= L.fieldX && px <= L.fieldX + L.fieldW;
  }

  /** 盤面の上（得点の並びと一時停止ボタン）に触れているか。ここを押すと一時停止する */
  inHud(_px: number, py: number): boolean {
    return py < this.rowTop(VISIBLE_ROWS + ATMOSPHERE_ROWS - 1);
  }
}
