import type { Game } from '../core/game';
import { Burner } from './audio/burner';
import { Mixer } from './audio/mixer';
import { Music, type MusicState } from './audio/music';
import { comboNote, note } from './audio/palette';
import { DUSK_STEPS, GRAND_BOOM, STARMINE, TRACER_FLIGHT } from './effects';

/** 攻撃が相手の盤面へ届くまでの秒数。飛んでいく弾のフレーム数と揃える */
const ATTACK_FLIGHT = TRACER_FLIGHT / 60;

/**
 * 効果音はコードで合成する（音声ファイルを持たない）。
 * 原作は惑星ごとに 83 音のサウンドセットを持ち、点火の音は連続点火で音程が上がる。ここも同じ考え方で、音程は 1 本の音階から取る。
 *
 * 全体の組み立て:
 * - 音律は F メジャーペンタトニック 1 本（`audio/palette.ts`）。重なっても濁らない。盤面の曲と同じ調
 * - 音色は「質量・摩擦・信号・金属・警告」の 5 役（同上）
 * - バスと limiter と同時発音の上限は `audio/mixer.ts`
 * - 噴射のあいだ鳴り続ける燃焼音は `audio/burner.ts`
 * - 盤面で流す曲は `audio/music.ts`（これだけは音声ファイル）
 *
 * 鳴らし方の決めごと: 盤面の出来事はその場で鳴らさず `pending` に積み、
 * 1 フレームに 1 度 `update()` でまとめて流す。同じフレームに 10 個点火しても音は 1 つになり、
 * `frame()` が遅れを取り戻すために step を何度も回したときも、音が同じ時刻に重ならない
 */

/** 鳴らした音の名前。e2e から `played` で見る */
export type SoundName =
  | 'explode'
  | 'rise'
  | 'screenOut'
  | 'shoot'
  | 'shootCancel'
  | 'land'
  | 'airDock'
  | 'screenClear'
  | 'danger'
  | 'dangerStart'
  | 'warn'
  | 'gameOver'
  | 'victory'
  | 'defeat'
  | 'attackSent'
  | 'attackTaken'
  | 'rareMetal'
  | 'rareLaunch'
  | 'grab'
  | 'step'
  | 'release'
  | 'lock'
  | 'revert'
  | 'fanfare'
  | 'ui';

export type Scene = 'menu' | 'play' | 'paused' | 'over';
type DragKind = 'ground' | 'lump';

/** 1 フレームぶんの溜め。毎フレーム作り直さず、数値を戻して使い回す */
interface Pending {
  igniteCells: number;
  igniteCombo: number;
  igniteVertical: boolean;
  igniteHit: boolean;
  /** 点火した場所の左右（-1〜1）の合計。個数で割って真ん中を出す */
  ignitePan: number;
  igniteCount: number;
  screenOut: number;
  screenOutRare: number;
  screenOutPan: number;
  land: number;
  landHeavy: boolean;
  shot: boolean;
  shootCancel: boolean;
  airDock: boolean;
  lock: boolean;
  revert: boolean;
  rareMetal: boolean;
  screenClear: boolean;
  gameOver: boolean;
  victory: boolean;
  defeat: boolean;
  attackSent: number;
  attackTaken: number;
  grab: DragKind | null;
  release: DragKind | null;
  releaseMoved: boolean;
  move: DragKind | null;
  moveRow: number;
  moveUp: boolean;
  danger: boolean;
  dangerStart: boolean;
  warn: boolean;
}

function emptyPending(): Pending {
  return {
    igniteCells: 0,
    igniteCombo: 0,
    igniteVertical: false,
    igniteHit: false,
    ignitePan: 0,
    igniteCount: 0,
    screenOut: 0,
    screenOutRare: 0,
    screenOutPan: 0,
    land: 0,
    landHeavy: false,
    shot: false,
    shootCancel: false,
    airDock: false,
    lock: false,
    revert: false,
    rareMetal: false,
    screenClear: false,
    gameOver: false,
    victory: false,
    defeat: false,
    attackSent: 0,
    attackTaken: 0,
    grab: null,
    release: null,
    releaseMoved: false,
    move: null,
    moveRow: 0,
    moveUp: false,
    danger: false,
    dangerStart: false,
    warn: false,
  };
}

const MUTE_KEY = 'novaria.audio.v1';

export class GameAudio {
  private mixer = new Mixer();
  private burner = new Burner();
  private music = new Music();
  private built = false;
  private p = emptyPending();
  /** 同じ音を鳴らした最後の時刻。鳴らしすぎを間引くのに使う */
  private lastAt = new Map<SoundName, number>();
  private lastDangerFrame = -999;
  private wasDanger = false;
  private wasWarn = false;
  /** 直近に鳴らした音の名前。e2e が「点火のあとに爆発が鳴った」を見るための窓 */
  private ring: SoundName[] = [];
  /** メニューの音を名前ごとに間引くための時刻 */
  private lastUiAt = new Map<string, number>();

  constructor() {
    // 裏へ回ったら ctx ごと止める。止めないと、盤面は止まっているのに曲だけ裏で鳴り続ける。
    // 表に戻ったら鳴らし直す（iOS は裏にいるあいだに勝手に止めていることもある）。
    // まだ一度も触っていないなら ctx を作らない（ユーザー操作の外では動かないまま残る）
    document.addEventListener('visibilitychange', () => {
      if (!this.mixer.ctx) return;
      if (document.hidden) void this.mixer.ctx.suspend();
      else this.mixer.open();
    });
    // 曲はタップを待たずに取りに行く。メニューのあいだに展開まで済ませておく
    this.music.load();
  }

  /** 最初のタップの中で呼ぶ。ブラウザはユーザー操作の中でしか音を出せない */
  unlock(): void {
    if (!this.mixer.open() || this.built) return;
    const ctx = this.mixer.ctx;
    const musicIn = this.mixer.musicInput;
    if (ctx && musicIn) this.music.attach(ctx, musicIn);
    const buffers = this.mixer.noiseBuffers;
    if (!buffers) return;
    this.burner.build(this.mixer, buffers.white, buffers.brown);
    this.built = true;
  }

  get muted(): boolean {
    return this.mixer.muted;
  }

  set muted(value: boolean) {
    this.mixer.setMuted(value);
    try {
      localStorage.setItem(MUTE_KEY, JSON.stringify({ muted: value }));
    } catch {
      // 保存できなくても音は鳴る
    }
  }

  /** 前に選んだミュートの状態を読み直す。起動したときに 1 度だけ呼ぶ */
  loadMuted(): void {
    try {
      const raw = localStorage.getItem(MUTE_KEY);
      if (raw) this.mixer.setMuted(JSON.parse(raw).muted === true);
    } catch {
      // 読めなければ鳴らす側で始める
    }
  }

  /**
   * 盤面が動いているかを伝える。止まっているあいだは鳴り続ける音を畳む。
   * 曲は一時停止なら止めたところから、新しい盤面（fresh）なら頭から鳴らし直す
   */
  scene(next: Scene, fresh = false): void {
    if (next === 'play') {
      if (fresh) {
        // 前の試合の警報と予兆を持ち越すと、始まってすぐの 1 回目が鳴らない
        this.wasDanger = false;
        this.wasWarn = false;
        this.music.start();
      } else {
        this.music.play();
      }
      return;
    }
    if (next === 'paused') this.music.pause();
    else this.music.stop(next === 'over' ? 1.2 : 0.3);
    if (!this.mixer.ctx) return;
    this.burner.hush(this.mixer.beginFrame());
  }

  // ---------------------------------------------------------- 盤面の出来事

  /** 点火。同じフレームの点火は 1 つの爆発にまとめる */
  /** pan は点火した場所の左右（-1 が左端、1 が右端） */
  ignite(cells: number, combo: number, vertical: boolean, pan = 0): void {
    this.p.igniteHit = true;
    this.p.ignitePan += pan;
    this.p.igniteCount += 1;
    this.p.igniteCells += cells;
    this.p.igniteCombo = Math.max(this.p.igniteCombo, combo);
    this.p.igniteVertical ||= vertical;
  }

  screenOut(count: number, rare: number, pan = 0): void {
    this.p.screenOut += count;
    this.p.screenOutRare += rare;
    this.p.screenOutPan = pan;
  }

  /**
   * 節目の帯の見出しに合わせた一吹き。始まり・レベルの節目・連鎖の上限。
   * 帯と同じで 1 度に 1 つだけ鳴り、同じフレームの点火の音には重ねて鳴らす
   */
  fanfare(kind: 'levelUp' | 'maxChain'): void {
    if (!this.mixer.ctx) return;
    const now = this.mixer.beginFrame();
    if (!this.free('fanfare', 0.5, now)) return;
    this.mark('fanfare');
    const m = this.mixer;
    // 上がっていく 3 音と、最後に和音。連鎖の上限は 1 オクターブ上で鳴らす
    const base = kind === 'maxChain' ? 5 : 0;
    [0, 2, 4].forEach((step, i) => {
      m.voice({ bus: 'reward', type: 'triangle', f0: note(base + step), gain: 0.16, dur: 0.14, at: 0.06 * i, env: { tau: 0.04 }, echo: 0.3, priority: 2 });
    });
    for (const [step, detune] of [
      [base + 5, -6],
      [base + 7, 6],
      [base + 9, 0],
    ] as const) {
      m.voice({ bus: 'reward', type: 'sawtooth', f0: note(step), detune, lowpass: 2400, gain: 0.075, dur: 0.7, at: 0.18, env: { attack: 0.01, hold: 0.12, tau: 0.14 }, echo: 0.35, priority: 2 });
    }
    m.metal('reward', note(base + 9), 0.1, 0.8, 3, 0.18, 3, 0, 0.4);
  }

  /** 着地。カタマリが落ちてきたぶんは重く鳴らす */
  land(count: number, heavy: boolean): void {
    this.p.land += count;
    this.p.landHeavy ||= heavy;
  }

  shoot(): void {
    this.p.shot = true;
  }

  shootCancel(): void {
    this.p.shootCancel = true;
  }

  airDock(): void {
    this.p.airDock = true;
  }

  rareMetal(): void {
    this.p.rareMetal = true;
  }

  screenClear(): void {
    this.p.screenClear = true;
  }

  gameOver(): void {
    this.p.gameOver = true;
  }

  /** 対戦で勝った。曲を切って、勝ちのためだけの一節を鳴らす */
  victory(): void {
    this.p.victory = true;
  }

  /** 対戦で負けた。滅亡の音のあとに曲を切り、静けさの中に一節だけ残す */
  defeat(): void {
    this.p.defeat = true;
  }

  attackSent(count: number): void {
    this.p.attackSent += count;
  }

  attackTaken(count: number): void {
    this.p.attackTaken += count;
  }

  revert(count: number): void {
    if (count > 0) this.p.revert = true;
  }

  /**
   * 危ない列があるときの警告。残り猶予が減るほど間隔が詰まる。
   * 音そのものは小さいままで、鳴る間隔だけが迫ってくる。
   *
   * 間隔は 24 → 12 フレーム。以前は 48 → 18 で、レベルが最大の猶予（69 フレーム）では
   * 2 回しか鳴らないうちに滅亡していた（docs/decisions.md「ピンチの知らせ方」）
   */
  danger(frame: number, ratio: number): void {
    if (!this.wasDanger) {
      this.p.dangerStart = true;
      this.wasDanger = true;
    }
    const interval = Math.round(24 - 12 * Math.min(1, Math.max(0, ratio)));
    if (frame - this.lastDangerFrame < interval) return;
    this.lastDangerFrame = frame;
    this.p.danger = true;
  }

  /** 危ない列が無くなった。次に危なくなったら、また始まりの警報を鳴らす */
  safe(): void {
    this.wasDanger = false;
  }

  /**
   * 予兆（あと 1 段で危ない列がある）。出た瞬間に 1 度だけ鳴らす。
   * 1 試合に 2 回ほどしか出ないので、鳴りっぱなしにはならない
   */
  warn(near: boolean): void {
    if (!near) {
      this.wasWarn = false;
      return;
    }
    if (this.wasWarn) return;
    this.wasWarn = true;
    this.p.warn = true;
  }

  // ------------------------------------------------------------- 指の操作

  grab(kind: DragKind): void {
    this.p.grab = kind;
  }

  /** 1 マス動かした。同じフレームに何度も動いたら最後の 1 回だけ鳴らす */
  step(kind: DragKind, row: number, up: boolean): void {
    this.p.move = kind;
    this.p.moveRow = row;
    this.p.moveUp = up;
  }

  release(kind: DragKind, moved: boolean): void {
    this.p.release = kind;
    this.p.releaseMoved = moved;
  }

  /** なぞる途中で揃って指から離れた。点火が来る合図 */
  lock(): void {
    this.p.lock = true;
  }

  // ------------------------------------------------------------- メニュー

  /** メニューの操作音。メニューのあいだは `update()` が回らないので即座に鳴らす */
  ui(name: 'select' | 'confirm' | 'back' | 'error' | 'pause' | 'resume' | 'matched' | 'start'): void {
    if (!this.mixer.ctx) return;
    const now = this.mixer.beginFrame();
    if (now - (this.lastUiAt.get(name) ?? -1) < 0.04) return;
    this.lastUiAt.set(name, now);
    this.mark('ui');
    const m = this.mixer;
    switch (name) {
      case 'select':
        m.voice({ bus: 'ui', type: 'triangle', f0: note(9), gain: 0.06, dur: 0.03, priority: 4 });
        m.noise({
          bus: 'ui',
          color: 'white',
          filter: { type: 'bandpass', f0: 3000, q: 3 },
          gain: 0.04,
          dur: 0.012,
          priority: 5,
        });
        break;
      case 'confirm':
      case 'matched':
        m.voice({ bus: 'ui', type: 'triangle', f0: note(7), gain: 0.1, dur: 0.05, priority: 3 });
        m.voice({ bus: 'ui', type: 'triangle', f0: note(10), gain: 0.1, dur: 0.05, at: 0.045, priority: 3 });
        if (name === 'matched') m.metal('reward', note(9), 0.08, 0.3, 3, 0.09, 3);
        break;
      case 'back':
        m.voice({ bus: 'ui', type: 'triangle', f0: note(3), gain: 0.08, dur: 0.05, priority: 4 });
        m.voice({ bus: 'ui', type: 'triangle', f0: note(1), gain: 0.08, dur: 0.05, at: 0.045, priority: 4 });
        break;
      case 'error':
        // ここだけは濁らせる。半音の隣をぶつけてうなりを出す
        m.voice({ bus: 'ui', type: 'sine', f0: 220, gain: 0.1, dur: 0.12, env: { attack: 0.005 }, priority: 3 });
        m.voice({ bus: 'ui', type: 'sine', f0: 233, gain: 0.1, dur: 0.12, env: { attack: 0.005 }, priority: 3 });
        break;
      case 'pause':
        m.voice({ bus: 'ui', type: 'triangle', f0: note(3), gain: 0.08, dur: 0.06, priority: 4 });
        m.voice({ bus: 'ui', type: 'triangle', f0: note(0), gain: 0.08, dur: 0.06, at: 0.05, priority: 4 });
        break;
      case 'resume':
        m.voice({ bus: 'ui', type: 'triangle', f0: note(0), gain: 0.08, dur: 0.06, priority: 4 });
        m.voice({ bus: 'ui', type: 'triangle', f0: note(3), gain: 0.08, dur: 0.06, at: 0.05, priority: 4 });
        break;
      case 'start':
        // 発進。低いところから唸りが開いていき、盤面が組み上がって帯が開くところ（0.3 秒）で
        // 打撃と和音が鳴る。和音は完全 5 度を重ねた明るい開いた響き
        m.noise({ bus: 'burn', color: 'brown', filter: { type: 'lowpass', f0: 150, f1: 1600 }, gain: 0.2, dur: 0.4, env: { attack: 0.2, hold: 0.05, tau: 0.06 }, priority: 3 });
        m.noise({ bus: 'ui', color: 'white', filter: { type: 'bandpass', f0: 500, f1: 6000, q: 1.5 }, gain: 0.09, dur: 0.32, env: { attack: 0.25, tau: 0.04 }, priority: 3 });
        m.voice({ bus: 'impact', type: 'sine', f0: 140, f1: 45, sweep: 0.12, gain: 0.5, dur: 0.4, at: 0.3, env: { tau: 0.09 }, priority: 2 });
        m.noise({ bus: 'impact', color: 'white', filter: { type: 'highpass', f0: 2500 }, gain: 0.18, dur: 0.05, at: 0.3, env: { tau: 0.01 }, priority: 2 });
        for (const [step, detune, pan] of [
          [0, -5, -0.5],
          [3, 5, 0.5],
          [5, 0, 0],
        ] as const) {
          m.voice({ bus: 'reward', type: 'sawtooth', f0: note(step), detune, lowpass: 2600, gain: 0.07, dur: 1.1, at: 0.3, env: { attack: 0.01, hold: 0.2, tau: 0.22 }, pan, echo: 0.3, priority: 2 });
        }
        m.metal('reward', note(10), 0.1, 0.9, 3, 0.32, 3, 0, 0.4);
        break;
    }
  }

  // ----------------------------------------------------------- 1 フレーム

  /**
   * 溜めた音を鳴らし、鳴り続けている音を動かす。rAF ごとに 1 度だけ呼ぶ。
   * step ごとに呼ぶと、遅れを取り戻すために step が何度も回ったときに
   * 同じ時刻へ音が積み上がって割れる（同じ JS の仕事の中では `currentTime` が進まない）
   */
  update(game: Game, boost: boolean): void {
    const p = this.p;
    if (!this.mixer.ctx) {
      this.p = emptyPending();
      return;
    }
    const now = this.mixer.beginFrame();
    this.flush(p, now);
    this.p = emptyPending();

    // 浮いているカタマリの推進力を合計して、燃焼音 1 本の太さにする
    let rise = 0;
    let hover = 0;
    for (const lump of game.lumps) {
      const n = Math.sqrt(lump.cells.length);
      if (lump.thrustFrames > 0) rise += (1 + Math.min(2.5, lump.vy * 5)) * n;
      else hover += (lump.vy > 0 ? 0.6 : 0.35) * n;
    }
    this.burner.update(rise, hover, boost, now);
  }

  /** 曲を鳴らすことになっているか。e2e から見る */
  get musicState(): MusicState {
    return this.music.state;
  }

  /** 曲を読み終えて、いつでも鳴らせるか。e2e から見る */
  get musicReady(): boolean {
    return this.music.ready;
  }

  /** 曲を読み終えて、実際に鳴らしているか。e2e から見る */
  get musicSounding(): boolean {
    return this.music.sounding;
  }

  get sources(): number {
    return this.mixer.sources;
  }

  /** 直近に鳴らした音（新しいものが後ろ）。e2e から見る */
  get played(): readonly SoundName[] {
    return this.ring;
  }

  // ------------------------------------------------------------ 中身

  private mark(name: SoundName): void {
    this.ring.push(name);
    if (this.ring.length > 32) this.ring.shift();
  }

  /** 前に鳴らしてから `gap` 秒あいているか。あいていれば時刻を打ち直す */
  private free(name: SoundName, gap: number, now: number): boolean {
    const last = this.lastAt.get(name);
    if (last !== undefined && now - last < gap) return false;
    this.lastAt.set(name, now);
    return true;
  }

  private flush(p: Pending, now: number): void {
    // 大事なものから順に流す。混んでくると下のほうが `Mixer` に捨てられる
    if (p.gameOver) this.playGameOver();
    if (p.victory) this.playVictory();
    if (p.defeat) this.playDefeat();
    if (p.igniteHit) this.playExplode(p, now);
    if (p.screenClear) this.playScreenClear();
    if (p.rareMetal && this.free('rareMetal', 0.5, now)) this.playRareMetal();
    if (p.screenOutRare > 0) this.playRareLaunch();
    if (p.screenOut > 0) this.playScreenOut(p, now);
    if (p.attackTaken > 0 && this.free('attackTaken', 0.15, now)) this.playAttackTaken(p.attackTaken);
    if (p.attackSent > 0 && this.free('attackSent', 0.2, now)) this.playAttackSent(p.attackSent);
    if (p.airDock && this.free('airDock', 0.1, now)) this.playAirDock();
    if (p.shootCancel && this.free('shootCancel', 0.08, now)) this.playShootCancel();
    if (p.shot && this.free('shoot', 0.08, now)) this.playShoot();
    if (p.dangerStart) this.playDangerStart();
    if (p.danger) this.playDanger();
    if (p.warn) this.playWarn();
    if (p.land > 0 && this.free('land', 0.06, now)) this.playLand(p.land, p.landHeavy);
    if (p.lock && this.free('lock', 0.06, now)) this.playLock();
    if (p.grab && this.free('grab', 0.06, now)) this.playGrab(p.grab);
    if (p.move && this.free('step', 0.028, now)) this.playStep(p.move, p.moveRow, p.moveUp);
    if (p.release && this.free('release', 0.06, now)) this.playRelease(p.release, p.releaseMoved);
    if (p.revert && this.free('revert', 0.05, now)) this.playRevert();
  }

  /**
   * 点火の爆発。「ドン」と腹に来る打撃。同時点火の個数で腹が太り、連続点火で音程が上がる。
   * 重ねるのは 4 層: 立ち上がりのカチッ（高いノイズ 20ms）、キック（音程が一気に落ちる sine）、
   * スマホのスピーカーでも聞こえる中域の打撃、飛び散る破片のパチパチ。
   * 70ms 以内に続けて点火したときは音程だけを鳴らす。芯まで重ねると連鎖のあいだじゅう低音が積み上がって潰れる
   */
  private playExplode(p: Pending, now: number): void {
    const m = this.mixer;
    const cells = p.igniteCells;
    const combo = Math.max(1, p.igniteCombo);
    const s = Math.min(1, Math.max(0, (cells - 3) / 2));
    const c = Math.min(1, Math.max(0, (combo - 1) / 7));
    const root = comboNote(combo);
    const pan = p.igniteCount > 0 ? (p.ignitePan / p.igniteCount) * 0.7 : 0;
    const full = this.free('explode', 0.07, now);
    this.mark('explode');

    if (full) {
      // カチッ。打撃の輪郭
      m.noise({ bus: 'impact', color: 'white', filter: { type: 'highpass', f0: 3500 }, gain: 0.32, dur: 0.02, env: { attack: 0.0005, tau: 0.004 }, pan, priority: 1 });
      // キック。音程が 90ms で一気に落ちる
      m.voice({ bus: 'impact', type: 'sine', f0: 170, f1: 42, sweep: 0.09, gain: 0.7 + 0.15 * s + 0.1 * c, dur: 0.34 + 0.1 * s, env: { attack: 0.001, tau: 0.08 }, priority: 1 });
      // 中域の打撃。小さなスピーカーはキックの低音を出せないので、ここで「ドン」を聞かせる
      m.voice({ bus: 'impact', type: 'triangle', f0: 420, f1: 110, sweep: 0.05, gain: 0.3, dur: 0.12, env: { attack: 0.001, tau: 0.03 }, pan, priority: 1 });
      // 爆風の腹
      m.noise({ bus: 'impact', color: 'brown', filter: { type: 'bandpass', f0: 380, f1: 90, q: 0.7 }, gain: 0.42 + 0.15 * s + 0.1 * c, dur: 0.3 + 0.12 * s + 0.1 * c, env: { attack: 0.002, tau: 0.07 }, pan, priority: 1 });
      // 飛び散る破片。少し遅れて、帯域を下げながら散っていく
      m.noise({ bus: 'impact', color: 'white', filter: { type: 'bandpass', f0: 2600, f1: 700, q: 0.9 }, gain: 0.12 + 0.06 * c, dur: 0.38, at: 0.02, env: { attack: 0.005, tau: 0.09 }, pan, priority: 3 });
      m.duck('burn', 0.3, 0.08, 0.12);
      m.duck('move', 0.3, 0.08, 0.12);
    }

    // 連鎖の音程。少しずらした 2 本で厚くする
    m.voice({ bus: 'impact', type: 'triangle', f0: root, gain: 0.2, dur: 0.24, at: 0.012, env: { tau: 0.055 }, pan, priority: 1 });
    m.voice({ bus: 'impact', type: 'triangle', f0: root, detune: 9, gain: 0.1, dur: 0.24, at: 0.012, env: { tau: 0.055 }, pan, priority: 3 });
    if (combo >= 3) {
      m.voice({ bus: 'impact', type: 'sine', f0: root * 2, gain: 0.1, dur: 0.2, at: 0.02, env: { tau: 0.045 }, pan, priority: 3 });
    }
    // 縦点火は原作でも強い。完全 5 度を足して、横とは違う響きにする
    if (p.igniteVertical) {
      m.voice({ bus: 'impact', type: 'triangle', f0: root * 1.5, gain: 0.13, dur: 0.22, at: 0.03, env: { tau: 0.05 }, pan, priority: 2 });
    }
    if (!full) return;
    if (cells >= 4) {
      m.voice({ bus: 'impact', type: 'triangle', f0: comboNote(combo + 2), gain: 0.11, dur: 0.22, at: 0.03, env: { tau: 0.05 }, pan, priority: 3 });
    }
    this.playRise(combo, cells, pan, now);
  }

  /**
   * 打ち上げの「ぴゅーーん」。このゲームの顔になる音。
   * 笛の音程が 2 オクターブ駆け上がりながら薄れていき、空の向こうへ飛んでいったように聞こえる。
   * 音程の出発点は連鎖の音程なので、連鎖が続くほど高いところから飛んでいく。
   * 重ねるのは、少しずらした笛 2 本（揺らぎ）・1 オクターブ下の胴・上へ抜けていく風。
   * 笛にはこだまを掛けて、遠ざかった音が空に跳ね返る。
   * このあとの鳴り続ける噴射は燃焼音（`Burner`）が引き取る
   */
  private playRise(combo: number, cells: number, pan: number, now: number): void {
    if (!this.free('rise', 0.12, now)) return;
    this.mark('rise');
    const m = this.mixer;
    const from = comboNote(combo) * 0.75;
    const big = Math.min(1, Math.max(0, (cells - 3) / 3));
    // 消えきるまで上がり続ける。上がりきって平らになると、そこで止まって聞こえる
    const dur = 0.72 + 0.18 * big;
    const env = { attack: 0.012, hold: 0.1 + 0.08 * big, tau: 0.13 + 0.04 * big };
    m.voice({ bus: 'reward', type: 'sine', f0: from, f1: from * 5, sweep: dur, gain: 0.15, dur, at: 0.03, env, pan, echo: 0.25, priority: 2 });
    m.voice({ bus: 'reward', type: 'sine', f0: from, f1: from * 5, sweep: dur, detune: 12, gain: 0.08, dur, at: 0.03, env, pan, echo: 0.25, priority: 3 });
    m.voice({ bus: 'reward', type: 'triangle', f0: from / 2, f1: from * 2.5, sweep: dur, lowpass: 2200, gain: 0.08 + 0.04 * big, dur, at: 0.03, env, pan, priority: 3 });
    // 上へ抜けていく風。帯域が笛と一緒に上がる
    m.noise({ bus: 'burn', color: 'white', filter: { type: 'bandpass', f0: 450, f1: 6000, q: 1.8 }, gain: 0.2 + 0.06 * big, dur: dur + 0.3, at: 0.02, env: { attack: 0.04, hold: 0.08, tau: 0.13 }, pan, priority: 3 });
  }

  /**
   * 大気圏を抜けた「キラーン」。最後にもう一段ぴゅんと駆け上がり、空気の抜けるシュワッと、
   * 叩いた金属のきらめきで締める。抜けた数だけ音階を駆け上がる
   */
  private playScreenOut(p: Pending, now: number): void {
    const m = this.mixer;
    this.mark('screenOut');
    const k = Math.min(3, p.screenOut);
    const pan = p.screenOutPan * 0.7;
    // カタマリは 1 段ずつ抜けるので数フレームにまたがる。続きはきらめきだけにする
    if (!this.free('screenOut', 0.08, now)) {
      m.metal('reward', note(9) * 2, 0.06, 0.25, 2, 0, 3, pan, 0.3);
      return;
    }
    m.voice({ bus: 'reward', type: 'sine', f0: note(7), f1: note(12) * 2, sweep: 0.14, gain: 0.12, dur: 0.24, env: { attack: 0.004, tau: 0.05 }, pan, echo: 0.4, priority: 2 });
    m.noise({ bus: 'reward', color: 'white', filter: { type: 'highpass', f0: 2500, f1: 9000 }, gain: 0.1 + 0.03 * k, dur: 0.28, env: { attack: 0.01, tau: 0.07 }, pan, priority: 2 });
    m.metal('reward', note(9) * 2, 0.12, 0.45, 4, 0.03, 2, pan, 0.4);
    for (let i = 0; i < k; i++) {
      m.voice({ bus: 'reward', type: 'triangle', f0: note(9 + i * 2), gain: 0.09, dur: 0.2, at: 0.04 + 0.04 * i, env: { tau: 0.05 }, pan, echo: 0.3, priority: 3 });
    }
    if (p.screenOut >= 6) {
      m.voice({ bus: 'reward', type: 'sine', f0: note(12) * 2, gain: 0.06, dur: 0.5, at: 0.06, env: { attack: 0.05, hold: 0.1, tau: 0.08 }, echo: 0.4, priority: 3 });
    }
  }

  /**
   * レアメタルを宇宙へ出した。1 個 10,000 点で、1 試合の得点の 1 割を超える。
   * 打ち上げの音に紛れないよう、ここだけ上がっていく 4 音を重ねる
   */
  private playRareLaunch(): void {
    this.mark('rareLaunch');
    const m = this.mixer;
    m.metal('reward', note(5), 0.3, 0.8, 5, 0.02, 1);
    for (let i = 0; i < 4; i++) {
      m.voice({
        bus: 'reward', type: 'triangle', f0: note(6 + i * 2), gain: 0.12, dur: 0.3,
        at: 0.06 * i, env: { attack: 0.005, hold: 0.05, tau: 0.07 }, priority: 1,
      });
    }
    m.voice({
      bus: 'reward', type: 'sine', f0: note(12) * 2, gain: 0.07, dur: 0.7,
      at: 0.24, env: { attack: 0.02, hold: 0.2, tau: 0.12 }, priority: 2,
    });
  }

  private playShoot(): void {
    this.mark('shoot');
    const m = this.mixer;
    // 上へ払った「シュッ」。短いぴゅんを添える
    m.noise({ bus: 'impact', color: 'white', filter: { type: 'bandpass', f0: 900, f1: 4500, q: 1.1 }, gain: 0.4, dur: 0.2, env: { attack: 0.008, tau: 0.04 }, priority: 3 });
    m.voice({ bus: 'reward', type: 'sine', f0: note(5), f1: note(12), sweep: 0.12, gain: 0.16, dur: 0.18, env: { attack: 0.004, tau: 0.04 }, echo: 0.25, priority: 3 });
  }

  private playShootCancel(): void {
    this.mark('shootCancel');
    const m = this.mixer;
    m.metal('reward', note(5), 0.2, 0.3, 4, 0, 3);
    m.voice({ bus: 'impact', type: 'sine', f0: 300, f1: 150, gain: 0.12, dur: 0.12, env: { tau: 0.03 }, priority: 3 });
    m.noise({ bus: 'impact', color: 'white', filter: { type: 'highpass', f0: 4000 }, gain: 0.1, dur: 0.08, at: 0.005, env: { tau: 0.015 }, priority: 4 });
  }

  private playAirDock(): void {
    this.mark('airDock');
    const m = this.mixer;
    m.voice({ bus: 'impact', type: 'sine', f0: 90, gain: 0.12, dur: 0.08, env: { tau: 0.02 }, priority: 3 });
    m.voice({ bus: 'reward', type: 'triangle', f0: note(3), gain: 0.16, dur: 0.07, at: 0.01, env: { tau: 0.015 }, priority: 3 });
    m.voice({ bus: 'reward', type: 'triangle', f0: note(5), gain: 0.16, dur: 0.08, at: 0.055, env: { tau: 0.015 }, priority: 3 });
  }

  /** 着地。カタマリが落ちてきたぶんは、重さのぶんだけ低く長い */
  private playLand(count: number, heavy: boolean): void {
    this.mark('land');
    const m = this.mixer;
    const k = Math.min(3, count - 1);
    if (heavy) {
      m.noise({ bus: 'impact', color: 'brown', filter: { type: 'lowpass', f0: 200 }, gain: (0.18 + 0.05 * k) * 1.6, dur: 0.14, env: { attack: 0.002, tau: 0.028 }, priority: 3 });
      m.voice({ bus: 'impact', type: 'sine', f0: 60, f1: 36, gain: 0.28, dur: 0.16, env: { tau: 0.032 }, priority: 3 });
      return;
    }
    m.noise({ bus: 'impact', color: 'brown', filter: { type: 'lowpass', f0: 260 }, gain: 0.18 + 0.05 * k, dur: 0.09, env: { tau: 0.02 }, priority: 4 });
    m.voice({ bus: 'impact', type: 'sine', f0: 82, f1: 48, gain: 0.14 + 0.03 * k, dur: 0.1, env: { tau: 0.025 }, priority: 4 });
  }

  /**
   * レアメタルが降ってきて列を壊す。
   * 絵は一瞬で底に置くので、落ちる音と底に着く音を 0.45 秒ずらして高さを作る
   */
  private playRareMetal(): void {
    this.mark('rareMetal');
    const m = this.mixer;
    m.metal('reward', note(5), 0.22, 0.6, 5, 0, 2);
    m.voice({ bus: 'impact', type: 'sine', f0: 1200, f1: 300, gain: 0.12, dur: 0.5, env: { attack: 0.02, tau: 0.1 }, priority: 2 });
    m.noise({ bus: 'impact', color: 'white', filter: { type: 'bandpass', f0: 4000, f1: 800, q: 0.8 }, gain: 0.14, dur: 0.5, env: { attack: 0.02, hold: 0.1, tau: 0.0875 }, priority: 2 });
    m.voice({ bus: 'impact', type: 'sine', f0: 70, f1: 40, gain: 0.35, dur: 0.2, at: 0.45, env: { tau: 0.04 }, priority: 2 });
    m.noise({ bus: 'impact', color: 'brown', filter: { type: 'lowpass', f0: 200 }, gain: 0.3, dur: 0.15, at: 0.45, env: { tau: 0.03 }, priority: 2 });
  }

  /** 全消しと、対戦の勝ち。いちばん気持ちのいい和音を取っておく */
  private playScreenClear(): void {
    this.mark('screenClear');
    const m = this.mixer;
    const steps = [5, 7, 8, 10];
    steps.forEach((step, i) => {
      m.voice({ bus: 'reward', type: 'triangle', f0: note(step), gain: 0.16, dur: 0.35, at: 0.07 * i, env: { tau: 0.08 }, priority: 2 });
      m.voice({ bus: 'reward', type: 'sine', f0: note(step) * 2, gain: 0.06, dur: 0.3, at: 0.07 * i + 0.01, env: { tau: 0.06 }, priority: 3 });
    });
    m.metal('reward', note(10), 0.12, 0.6, 3, 0.28, 2);
    m.voice({ bus: 'reward', type: 'sawtooth', f0: 220, lowpass: 900, gain: 0.08, dur: 0.9, env: { attack: 0.15, hold: 0.3, tau: 0.1125 }, priority: 3 });
  }

  /**
   * 予兆の一声。警報（`playDangerStart`）より 1 オクターブ低く、柔らかい三角波にする。
   * 「まだ数え始めていない」ことが音色で分かるようにして、赤の警報と取り違えないようにする
   */
  private playWarn(): void {
    this.mark('warn');
    this.mixer.voice({
      bus: 'ui', type: 'triangle', f0: 330, lowpass: 1400, gain: 0.075, dur: 0.16,
      env: { attack: 0.01, hold: 0.04, tau: 0.05 }, priority: 4,
    });
  }

  /** 危なくなった瞬間の警報。ここだけ square を使う */
  private playDangerStart(): void {
    this.mark('dangerStart');
    const m = this.mixer;
    m.voice({ bus: 'ui', type: 'square', f0: 660, lowpass: 2000, gain: 0.1, dur: 0.06, env: { tau: 0.02 }, priority: 4 });
    m.voice({ bus: 'ui', type: 'square', f0: 660, lowpass: 2000, gain: 0.1, dur: 0.06, at: 0.09, env: { tau: 0.02 }, priority: 4 });
  }

  /** 危ない列があるあいだの呼吸。音は小さいまま、間隔だけが迫る */
  private playDanger(): void {
    this.mark('danger');
    const m = this.mixer;
    // 半音の隣を同時に鳴らしてうなりを作る。不協和はここと滅亡にだけ置く
    m.voice({ bus: 'ui', type: 'sine', f0: 440, gain: 0.085, dur: 0.09, env: { attack: 0.005, tau: 0.03 }, priority: 4 });
    m.voice({ bus: 'ui', type: 'sine', f0: 466, gain: 0.085, dur: 0.09, env: { attack: 0.005, tau: 0.03 }, priority: 4 });
    m.voice({ bus: 'ui', type: 'sine', f0: 55, gain: 0.14, dur: 0.12, env: { tau: 0.03 }, priority: 4 });
  }

  private playGameOver(): void {
    this.mark('gameOver');
    const m = this.mixer;
    m.voice({ bus: 'impact', type: 'sawtooth', f0: 220, f1: 27.5, lowpass: 800, gain: 0.28, dur: 1.4, env: { attack: 0.02, hold: 0.2, tau: 0.25 }, priority: 1 });
    m.noise({ bus: 'impact', color: 'brown', filter: { type: 'lowpass', f0: 400, f1: 80 }, gain: 0.3, dur: 1.2, env: { attack: 0.02, hold: 0.3, tau: 0.2 }, priority: 1 });
    m.voice({ bus: 'impact', type: 'sine', f0: 55, f1: 20, gain: 0.4, dur: 1.5, env: { attack: 0.05, hold: 0.4, tau: 0.25 }, priority: 1 });
    // 鳴り続けている音を全部畳む。滅亡のあとに噴射が残っていると間が抜ける
    m.duck('burn', 0, 2, 0.05);
    m.duck('move', 0, 2, 0.05);
  }

  /**
   * 対戦の勝ち。スターマイン: 小さな花火が詰まりながら 7 発上がって弾け、
   * 最後に低い笛の大玉が「ドーン」と開いて火の粉が枝垂れる。
   * 和音は使わない（花火のあとに和音を置くと安っぽく聞こえた）。段取りは `STARMINE` で、
   * 画面の花火（`Effects.fireworks`）と同じ時刻に上がって弾ける
   */
  private playVictory(): void {
    this.mark('victory');
    const m = this.mixer;
    // 曲は切る。ここから先は花火の音だけを聞かせる
    this.music.stop(0.4);
    this.victoryHit(0, 0.7);
    for (const s of STARMINE.shells) {
      this.victoryWhistle(s.at, note(s.pitch) * 0.7, STARMINE.rise, s.pan, 0.12);
      this.victoryPop(s.at + STARMINE.rise, s.pan, s.size);
    }
    // 大玉。低い笛がゆっくり上がり、大きく「ドーン」
    this.victoryWhistle(STARMINE.grand.at, note(0) * 0.5, STARMINE.grand.rise, 0, 0.14);
    const t = GRAND_BOOM;
    this.victoryHit(t, 1.3);
    m.voice({ bus: 'impact', type: 'sine', f0: 90, f1: 28, sweep: 1.0, gain: 0.5, dur: 1.6, at: t, env: { attack: 0.002, hold: 0.3, tau: 0.35 }, priority: 1 });
    m.noise({ bus: 'impact', color: 'brown', filter: { type: 'lowpass', f0: 900, f1: 120 }, gain: 0.45, dur: 1.8, at: t, env: { attack: 0.002, hold: 0.2, tau: 0.4 }, priority: 1 });
    // 枝垂れて落ちる火の粉。長く、だんだん低く
    for (let i = 0; i < 16; i++) {
      m.noise({ bus: 'reward', color: 'white', filter: { type: 'bandpass', f0: 7000 - i * 250, q: 8 }, gain: 0.08, dur: 0.06, at: t + 0.25 + i * 0.09 + Math.random() * 0.04, env: { attack: 0.001, tau: 0.012 }, pan: (Math.random() - 0.5) * 1.6, echo: 0.3, priority: 3 });
    }
    m.metal('reward', note(5), 0.12, 2.2, 5, t, 2, 0, 0.5);
  }

  /** 花火の一撃（カチッ + キック + 腹）。決着の瞬間と大玉に使う */
  private victoryHit(at: number, big: number): void {
    const m = this.mixer;
    m.noise({ bus: 'impact', color: 'white', filter: { type: 'highpass', f0: 3500 }, gain: 0.3, dur: 0.02, at, env: { attack: 0.0005, tau: 0.004 }, priority: 1 });
    m.voice({ bus: 'impact', type: 'sine', f0: 170, f1: 40, sweep: 0.1, gain: 0.6 * big, dur: 0.45, at, env: { attack: 0.001, tau: 0.09 }, priority: 1 });
    m.noise({ bus: 'impact', color: 'brown', filter: { type: 'bandpass', f0: 400, f1: 80, q: 0.7 }, gain: 0.4 * big, dur: 0.5, at, env: { attack: 0.002, tau: 0.1 }, priority: 1 });
  }

  /** 花火の笛。打ち上げの「ぴゅーん」（`playRise`）と同じく 2 オクターブ駆け上がる */
  private victoryWhistle(at: number, from: number, dur: number, pan: number, gain: number): void {
    const m = this.mixer;
    const env = { attack: 0.01, hold: dur * 0.3, tau: dur * 0.18 };
    m.voice({ bus: 'reward', type: 'sine', f0: from, f1: from * 5, sweep: dur, gain, dur, at, env, pan, echo: 0.3, priority: 1 });
    m.voice({ bus: 'reward', type: 'sine', f0: from, f1: from * 5, sweep: dur, detune: 12, gain: gain * 0.5, dur, at, env, pan, echo: 0.3, priority: 2 });
    m.noise({ bus: 'burn', color: 'white', filter: { type: 'bandpass', f0: 450, f1: 6000, q: 1.8 }, gain: 0.16, dur: dur + 0.1, at, env: { attack: 0.04, hold: dur * 0.3, tau: dur * 0.15 }, pan, priority: 2 });
  }

  /** 花火が弾ける「パーン」と、散る火の粉のパチパチ */
  private victoryPop(at: number, pan: number, big: number): void {
    const m = this.mixer;
    m.noise({ bus: 'impact', color: 'white', filter: { type: 'bandpass', f0: 1800, f1: 300, q: 0.6 }, gain: 0.3 * big, dur: 0.6 + 0.3 * (big - 1), at, env: { attack: 0.001, tau: 0.12 * big }, pan, priority: 1 });
    m.voice({ bus: 'impact', type: 'sine', f0: 120, f1: 40, gain: 0.32 * big, dur: 0.5, at, env: { attack: 0.001, tau: 0.08 * big }, pan, priority: 1 });
    for (let i = 0; i < 6; i++) {
      m.noise({ bus: 'reward', color: 'white', filter: { type: 'bandpass', f0: 4000 + i * 700, q: 6 }, gain: 0.11, dur: 0.05, at: at + 0.12 + i * 0.07 + Math.random() * 0.03, env: { attack: 0.001, tau: 0.01 }, pan: pan + (Math.random() - 0.5) * 0.6, priority: 3 });
    }
  }

  /**
   * 対戦の負け。滅亡の音（`playGameOver`）が沈みきったところで、1 オクターブ下の 3 音が
   * ゆっくり降りていく。曲はすぐに切り、その 3 音のほかは何も鳴らさない。
   * 負けた実感は、音が無くなることのほうで出る。
   * 3 音は画面の暗転（`DUSK_STEPS`）と同じ時刻に鳴り、1 音ごとに盤面が 1 段暗くなる
   */
  private playDefeat(): void {
    this.mark('defeat');
    const m = this.mixer;
    this.music.stop(0.15);
    [4, 2, 0].forEach((step, i) => {
      m.voice({ bus: 'reward', type: 'triangle', f0: note(step) / 2, gain: 0.16, dur: 0.9, at: DUSK_STEPS[i], env: { attack: 0.01, hold: 0.12, tau: 0.2 }, echo: 0.3, priority: 1 });
    });
    m.voice({ bus: 'impact', type: 'sine', f0: note(0) / 4, gain: 0.25, dur: 1.6, at: DUSK_STEPS[2], env: { attack: 0.08, hold: 0.3, tau: 0.35 }, priority: 1 });
  }

  /**
   * 溜めたぶんを相手へ送る。撃つ音と、相手の盤面に届く音を `ATTACK_FLIGHT` 秒ずらして鳴らす。
   * 弾が飛ぶ絵（`Effects.volley`）と同じ間で、遠くの盤面に当たったように聞こえる
   */
  private playAttackSent(count: number): void {
    this.mark('attackSent');
    const m = this.mixer;
    // 撃ち出す「ピュン、ピュン」。弾の数に合わせて 1〜4 発、少しずつ高く
    const shots = Math.min(4, 1 + Math.floor(count / 3));
    for (let i = 0; i < shots; i++) {
      const f = note(7 + i);
      m.voice({ bus: 'reward', type: 'square', f0: f, f1: f * 2.5, sweep: 0.08, lowpass: 3000, gain: 0.07, dur: 0.12, at: 0.045 * i, env: { attack: 0.002, tau: 0.03 }, pan: 0.3 + 0.1 * i, echo: 0.2, priority: 3 });
    }
    m.noise({ bus: 'reward', color: 'white', filter: { type: 'bandpass', f0: 1500, f1: 5000 }, gain: 0.07, dur: 0.22, env: { attack: 0.01, tau: 0.05 }, pan: 0.4, priority: 4 });
    // 着弾。自分が食らう音（`playAttackTaken`）より高く短く、遠くで起きたように小さく
    const w = Math.min(1, count / 12);
    const at = ATTACK_FLIGHT;
    m.noise({ bus: 'impact', color: 'white', filter: { type: 'bandpass', f0: 2600, f1: 700, q: 0.9 }, gain: 0.07 + 0.06 * w, dur: 0.22, at, env: { attack: 0.01, tau: 0.05 }, priority: 3 });
    m.voice({ bus: 'impact', type: 'sine', f0: 150, f1: 70, gain: 0.08 + 0.1 * w, dur: 0.2, at, env: { tau: 0.04 }, priority: 3 });
    if (count >= 8) m.voice({ bus: 'impact', type: 'sawtooth', f0: 220, f1: 90, lowpass: 900, gain: 0.07, dur: 0.22, at: at + 0.01, env: { tau: 0.045 }, priority: 4 });
  }

  /** 相手から攻撃が降ってきた。数が多いほど低く長い */
  private playAttackTaken(count: number): void {
    this.mark('attackTaken');
    const m = this.mixer;
    const w = Math.min(1, count / 12);
    m.noise({ bus: 'impact', color: 'white', filter: { type: 'bandpass', f0: 3000, f1: 300, q: 0.8 }, gain: 0.16 + 0.12 * w, dur: 0.35 + 0.25 * w, env: { attack: 0.03, tau: 0.075 }, priority: 2 });
    m.voice({ bus: 'impact', type: 'sawtooth', f0: 330, f1: 65, lowpass: 600, gain: 0.14 + 0.08 * w, dur: 0.35 + 0.2 * w, env: { attack: 0.02, tau: 0.0625 }, priority: 2 });
    m.voice({ bus: 'impact', type: 'sine', f0: 60, f1: 30, gain: 0.2 + 0.2 * w, dur: 0.4, env: { attack: 0.03, hold: 0.1, tau: 0.075 }, priority: 2 });
  }

  // ------------------------------------------------- 指で隕石を動かす音

  /**
   * 掴んだ。地面の岩は低く鈍く、空中のカタマリは浮いているぶん高く軽い。
   * どれも爆発の 1/10 以下で、部屋の反響にも送らない。
   * 指を動かしているあいだ鳴り続けるので、大きいと 10 秒で耳が疲れる
   */
  private playGrab(kind: DragKind): void {
    this.mark('grab');
    const m = this.mixer;
    if (kind === 'ground') {
      m.voice({ bus: 'move', type: 'sine', f0: 220, gain: 0.16, dur: 0.045, env: { tau: 0.01 }, priority: 5 });
      m.noise({ bus: 'move', color: 'white', filter: { type: 'bandpass', f0: 1800, q: 2 }, gain: 0.1, dur: 0.012, env: { tau: 0.003 }, priority: 5 });
      return;
    }
    m.voice({ bus: 'move', type: 'triangle', f0: 660, f1: 740, gain: 0.12, dur: 0.045, env: { tau: 0.01 }, priority: 5 });
    m.noise({ bus: 'move', color: 'white', filter: { type: 'bandpass', f0: 3200, q: 2 }, gain: 0.08, dur: 0.012, env: { tau: 0.003 }, priority: 5 });
  }

  /**
   * 1 マス動いた。音程は動かしたあとの段で決まるので、
   * 上へなぞると木琴のように上がり、下へなぞると下がる。
   * 連続で動かしても「いまどこにいるか」の手がかりになり、ただの雑音にならない
   */
  private playStep(kind: DragKind, row: number, up: boolean): void {
    this.mark('step');
    const m = this.mixer;
    const f = note(Math.min(row, 10)) * (kind === 'ground' ? 0.5 : 1);
    m.voice({ bus: 'move', type: 'triangle', f0: f, gain: up ? 0.07 : 0.06, dur: 0.03, env: { attack: 0.001, tau: 0.006 }, priority: 5 });
    m.noise({ bus: 'move', color: 'white', filter: { type: 'bandpass', f0: 2500, q: 4 }, gain: 0.05, dur: 0.012, env: { tau: 0.003 }, priority: 5 });
  }

  private playRelease(kind: DragKind, moved: boolean): void {
    this.mark('release');
    const m = this.mixer;
    if (kind === 'ground') {
      m.voice({ bus: 'move', type: 'sine', f0: 165, gain: moved ? 0.1 : 0.05, dur: 0.05, env: { tau: 0.012 }, priority: 5 });
      m.noise({ bus: 'move', color: 'brown', filter: { type: 'lowpass', f0: 700 }, gain: 0.06, dur: 0.04, env: { tau: 0.008 }, priority: 5 });
      return;
    }
    m.voice({ bus: 'move', type: 'triangle', f0: note(1), gain: 0.06, dur: 0.04, env: { tau: 0.008 }, priority: 5 });
  }

  /** なぞる途中で揃って指から離れた。猶予フレームのあとに爆発が来る合図 */
  private playLock(): void {
    this.mark('lock');
    const m = this.mixer;
    m.voice({ bus: 'move', type: 'triangle', f0: note(2), gain: 0.12, dur: 0.04, env: { tau: 0.01 }, priority: 4 });
    m.voice({ bus: 'move', type: 'triangle', f0: note(4), gain: 0.12, dur: 0.05, at: 0.04, env: { tau: 0.01 }, priority: 4 });
  }

  /** 燃えカスが通常の隕石に戻った。終盤は毎秒いくつも戻るので、ほとんど聞こえない大きさ */
  private playRevert(): void {
    this.mark('revert');
    this.mixer.voice({ bus: 'move', type: 'triangle', f0: note(8), gain: 0.04, dur: 0.025, env: { tau: 0.006 }, priority: 5 });
  }
}
