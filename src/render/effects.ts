import { beamSprite, glowSprite } from './glow';
import { LOOKS } from './theme';
import { Kind } from '../core/types';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  /** 四角い破片として描く（丸い火の粉と混ぜると爆発に見える） */
  shard: boolean;
  spin: number;
  angle: number;
  /** 重力を受けるか。噴射の炎は受けない */
  heavy: boolean;
}

interface Popup {
  x: number;
  y: number;
  text: string;
  life: number;
  maxLife: number;
  color: string;
  size: number;
  /** 連鎖の吹き出しなら、字の右に小さく添える札（`CHAIN`） */
  tag?: string;
  /** 盤面の端からはみ出さないよう x を寄せ終えたか。最初に描くときに 1 度だけ寄せる */
  fitted?: boolean;
  /** いちばん大きく弾んだときの、縁取りまで含めた幅の半分。寄せるときに測る */
  half?: number;
}

/**
 * 帯の見出しを出す場所。
 * - center: 盤面の真ん中を横切る。手を止めている場面（始まり・決着・脱出）で使う
 * - air: いちばん高い列のすぐ上の空きに細く出す。遊んでいる最中の節目（レベル・連鎖の上限・全消し・レアメタル）で使う。
 *   目は山のてっぺんから下を見ているので、その近くに出しつつ、積もった隕石は隠さない
 */
export type BannerPlace = 'center' | 'air';

/**
 * 帯の見出し。始まり・惑星の到着・レベルの節目・連鎖の上限・全消し・決着に出す。
 * 1 度に 1 本だけで、新しいものが来たら入れ替える
 */
interface Banner {
  title: string;
  place: BannerPlace;
  /** air のときの帯の真ん中の y。出した瞬間の山の高さで決め、出ているあいだは動かさない */
  y: number;
  /** 見出しの上に小さく出す説明 */
  sub: string;
  color: string;
  /** 出てからのフレーム数 */
  t: number;
  /** 出している長さ（フレーム） */
  len: number;
}

/** 字の太さと書体。吹き出しと帯の見出しで使う */
const DISPLAY = "'Hiragino Sans', 'Noto Sans JP', system-ui, sans-serif";

/** 字間を空ける。対応していない端末では何もしない */
function spacing(ctx: CanvasRenderingContext2D, px: number): void {
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${px}px`;
}

/** 点火や大気圏突破で広がる衝撃波の輪 */
interface Ring {
  x: number;
  y: number;
  r: number;
  maxR: number;
  life: number;
  color: string;
  width: number;
}

/** 点火や大気圏突破の瞬間の閃き。焼いた光の玉を大きく貼って、すぐ縮めて消す */
interface Flare {
  x: number;
  y: number;
  r: number;
  life: number;
  /** 1 フレームに減る life */
  decay: number;
  color: string;
}

/** 大気圏を抜けたカタマリの通り道に残る光の柱。根元から上へ抜けて消える */
interface Beam {
  x: number;
  /** 柱の根元（大気圏の上端）の y */
  y: number;
  w: number;
  life: number;
}

/** 大気圏を抜けたときに上へ伸びる光の筋 */
interface Streak {
  x: number;
  y: number;
  len: number;
  life: number;
  speed: number;
}

/**
 * 攻撃の弾。打ち上げた隕石が右上の装填へ吸い寄せられるぶんと、
 * 溜まったぶんが相手の盤面へ飛ぶぶんの両方に使う。
 * 狙った場所へ必ず届かせたいので、粒のような物理ではなく始点と終点の補間で動かす
 */
interface Tracer {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 弧の高さ。まっすぐだと何本飛ばしても 1 本に重なって見える */
  bend: number;
  /** 飛び始めるまでのフレーム数 */
  delay: number;
  /** 0 から 1 まで進む */
  t: number;
  step: number;
  size: number;
  color: string;
}

/** 相手の盤面に着弾する予約。弾が飛んでいるあいだ待たせる */
interface Impact {
  frames: number;
  count: number;
  cols: number[];
  x: number;
  y: number;
}

/**
 * 弾の上限。連鎖で 20 個抜けると同じ数だけ飛ぶので、粒と同じように頭を押さえる。
 * 粒より重い（1 本ごとに線と四角を描く）ぶん少なめ
 */
const MAX_TRACERS = 80;

/** 弾が飛んでいるフレーム数。着弾の音（`playAttackSent` の遅らせたぶん）と合わせる */
export const TRACER_FLIGHT = 22;

/** 勝ちの花火の 1 発。at は上がり始め（秒）、pan は左右（-1〜1）、pitch は笛の出だしの音階の段 */
export interface Shell {
  at: number;
  pan: number;
  pitch: number;
  size: number;
}

/**
 * 勝ちの花火（スターマイン）の段取り。音（`GameAudio.playVictory`）と絵（`Effects.fireworks`）の
 * 両方がこれを見て、笛の上がりと弾ける瞬間をそろえる。時刻は決着からの秒。
 * 小さな玉が詰まりながら 7 発上がり、最後に低い笛の大玉が「ドーン」と開く
 */
export const STARMINE = {
  shells: [-0.7, 0.5, -0.2, 0.8, -0.5, 0.2, 0].map(
    (pan, i): Shell => ({ at: 0.05 + i * 0.16 - i * i * 0.006, pan, pitch: i % 4, size: 0.7 + i * 0.05 }),
  ),
  /** 笛が上がりきって弾けるまで */
  rise: 0.55,
  /** 大玉。最後の小玉が弾ける 0.1 秒前に上がり始め、0.8 秒かけて上がる */
  grand: { at: 1.244, rise: 0.8 },
} as const;

/** 大玉が開く時刻（秒） */
export const GRAND_BOOM = STARMINE.grand.at + STARMINE.grand.rise;

/**
 * 負けの暗転の段取り（秒）。負けの音（`GameAudio.playDefeat`）の降りていく 3 音に合わせて、
 * 盤面が 1 段ずつ暗くなる。3 音目で警報の赤い縁が最後に 1 度光って消える
 */
export const DUSK_STEPS = [1.1, 1.46, 1.82] as const;

/**
 * 同時に出せる粒の上限。
 * 粒は 1 個ずつ別の描画になるので、数がそのままフレーム時間になる。
 * 上限なしだと連鎖と噴射で 4,000 個を超え、1 フレーム 57ms を粒だけで使っていた。
 * 420 個なら、いちばん派手な連鎖でも見た目が痩せずに 1 フレーム 2ms 弱で収まる
 */
const MAX_PARTICLES = 420;
/** 入れ替わった隣の隕石が新しいマスへ寄るまでのフレーム数（0.1 秒）。長いと指に遅れて見える */
const SLIDE_FRAMES = 6;

/**
 * 閃きの上限。光の玉は粒よりずっと広い面を塗る。上限 40 で半径も大きかったころ、
 * 9 列が続けて点火する場面で閃きだけに 1 フレーム 60ms 使っていた（Pixel 7 相当・CPU 4 倍遅）
 */
const MAX_FLARES = 8;

/** 花火の笛の頭。発射台から弾ける高さまで上がる */
interface Rocket {
  x: number;
  y0: number;
  y1: number;
  /** 上がり始めてからのフレーム数 */
  t: number;
  len: number;
  size: number;
  color: string;
  grand: boolean;
}

/** 花火の火の粉。粒（`Particle`）より空気の抵抗が強く、ゆっくり落ちる */
interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  /** 1 フレームに速さへ掛ける数。小さいほどすぐ止まって枝垂れる */
  drag: number;
  gravity: number;
}

/**
 * 花火の火の粉の上限。粒とは別に数える（粒の上限で古い爆発を消さないため）。
 * 小玉 7 発と大玉で 1 度に出るのは 300 個ほどで、ここで頭を押さえる
 */
const MAX_SPARKS = 320;

/** 花火の玉の色。隕石の色から明るいものを選ぶ */
const SHELL_COLORS = ['#ffd257', '#6de3ff', '#ff9ad8', '#b9ff8a', '#ffffff'];

/** 点火の破片、連鎖の吹き出し、画面の揺れ。ゲームロジックには影響しない */
export class Effects {
  private particles: Particle[] = [];
  private popups: Popup[] = [];
  private rings: Ring[] = [];
  private streaks: Streak[] = [];
  private flares: Flare[] = [];
  private beams: Beam[] = [];
  private bannerNow: Banner | null = null;
  private tracers: Tracer[] = [];
  private impacts: Impact[] = [];
  /** 相手の盤面が攻撃を食らった勢い（1 が着弾の瞬間、0 で収まる） */
  private hit = 0;
  private hitCount = 0;
  private hitCols: number[] = [];
  /** このフレームに着弾した個数。main が振動に使い、読んだら 0 に戻る */
  private landed = 0;
  private shake = 0;
  /** 画面全体の閃光（0〜1） */
  private flash = 0;
  /** 噴射の火を出したフレーム。毎フレーム出すと、上昇中ずっと 700 個ほど溜まる */
  private thrustTick = 0;
  /**
   * 指で運んだ隕石と入れ替わって 1 マスずれた相手の、絵だけの滑り。
   * 盤面の上では一瞬で入れ替わるが、絵は元いた位置（from、マス単位のずれ）から
   * 新しいマスへ数フレームで寄せる。盤面の計算には効かない
   */
  private slides = new Map<number, { from: number; t: number }>();
  /**
   * 決着の演出（勝ちの花火・負けの暗転・相手の勝ち名乗り）。盤面が止まっているあいだも
   * 実時間で進める（`updateShow`）。t は始まってからのフレーム数
   */
  private show: {
    kind: 'win' | 'lose';
    t: number;
    /** 花火を上げる範囲。発射台（bottom）から弾ける高さ（top）まで */
    box: { left: number; right: number; top: number; bottom: number };
    next: number;
    grandFired: boolean;
  } | null = null;
  private rockets: Rocket[] = [];
  private sparks: Spark[] = [];
  /** 盤面を覆う暗い幕の高さ（0〜1）。負けの音に合わせて段ごとに上がる */
  private dim = 0;
  /** 相手のミニ盤面の勝ち名乗り（0〜1） */
  private rivalCrown = 0;
  private crownOff = false;

  /** いま出ている花火の火の粉の数。上限を超えていないかを e2e が見る */
  get sparkCount(): number {
    return this.sparks.length;
  }

  /** 決着の演出で打ち上げた花火の数（大玉を含む）。e2e が見る */
  get shellsFired(): number {
    return this.show?.kind === 'win' ? this.show.next + (this.show.grandFired ? 1 : 0) : 0;
  }

  /** 盤面を覆う暗い幕の高さ（0〜1）。負けの暗転を e2e が見る */
  get dusk(): number {
    return this.dim;
  }

  /** 相手のミニ盤面の勝ち名乗りの強さ（0〜1） */
  get rivalWins(): number {
    return this.rivalCrown;
  }

  /** いま出ている吹き出しの数。新しい盤面に前の盤面の字が残っていないかを e2e が見る */
  get popupCount(): number {
    return this.popups.length;
  }

  /** いま出ている粒の数。上限を超えていないかを e2e が見る */
  get particleCount(): number {
    return this.particles.length;
  }

  /** いまの揺れの強さ。警告で揺れたことを e2e が見る */
  get shakeAmount(): number {
    return this.shake;
  }

  /** いま飛んでいる攻撃の弾の数 */
  get tracerCount(): number {
    return this.tracers.length;
  }

  /** 相手の盤面が食らった勢い（0〜1）。ミニ盤面の膨らみと光りに使う */
  get rivalHit(): number {
    return this.hit;
  }

  /** 着弾した個数。膨らんでいるあいだミニ盤面の横に出す */
  get rivalHitCount(): number {
    return this.hitCount;
  }

  /** 攻撃が刺さった相手の列。分からないとき（オンライン）は空 */
  get rivalHitCols(): readonly number[] {
    return this.hitCols;
  }

  /** このフレームに着弾した個数を取り出す。取り出すと 0 に戻る */
  /**
   * 入れ替わって反対へ 1 マスずれた隕石を、元の位置から滑らせる。
   * up は指の隕石が上へ動いたかで、相手はその逆（下へ 1 マス）へずれている。
   * 続けて何マスも運ばれたときは、前の滑りの残りを引き継いで途切れないようにする
   */
  slide(meteorId: number, up: boolean): void {
    const prev = this.slideOffset(meteorId);
    this.slides.set(meteorId, { from: prev + (up ? 1 : -1), t: 1 });
  }

  /** 滑っている途中の隕石の、いま描くべき位置のずれ（マス単位。上が正） */
  slideOffset(meteorId: number): number {
    const s = this.slides.get(meteorId);
    if (!s) return 0;
    // 出だしが速く、終わりはゆっくり寄る
    return s.from * s.t * s.t;
  }

  takeLanded(): number {
    const n = this.landed;
    this.landed = 0;
    return n;
  }

  /** 弾を足したあとに上限まで削る */
  private trimTracers(): void {
    const over = this.tracers.length - MAX_TRACERS;
    if (over > 0) this.tracers.splice(0, over);
  }

  /**
   * 打ち上げた隕石が、右上の装填へ吸い寄せられる。
   * 「宇宙へ消えて終わり」ではなく「相手へ送るぶんが溜まった」と見せるための線
   */
  stockPull(x: number, y: number, to: { x: number; y: number }): void {
    const tx = to.x;
    const ty = to.y;
    this.tracers.push({
      x0: x,
      y0: y,
      x1: tx,
      y1: ty,
      bend: 20 + Math.random() * 40,
      delay: Math.floor(Math.random() * 6),
      t: 0,
      step: 1 / (22 + Math.random() * 8),
      size: 3,
      color: '#bfe9ff',
    });
    this.trimTracers();
  }

  /**
   * 溜まった攻撃が相手の盤面へ飛ぶ。
   * 着弾は `TRACER_FLIGHT` フレーム後で、そこでミニ盤面が膨らむ
   */
  volley(
    from: { x0: number; x1: number; y: number },
    to: { x: number; y: number },
    count: number,
    cols: number[],
  ): void {
    const n = Math.min(14, count);
    for (let i = 0; i < n; i++) {
      // 並べてあった弾が 1 つずつ飛び立つように、装填の左端から右端へ散らして出す。
      // 1 点から出すと、相手の盤面までが近すぎて飛んだことが分からない
      const at = n === 1 ? 0.5 : i / (n - 1);
      this.tracers.push({
        x0: from.x0 + (from.x1 - from.x0) * at,
        y0: from.y + (Math.random() - 0.5) * 6,
        x1: to.x + (Math.random() - 0.5) * 14,
        y1: to.y + (Math.random() - 0.5) * 14,
        // 装填と相手の盤面は近いので、横ではなく上へ大きく弧を描かせて見せる。
        // 遠い弾ほど高く上がる（まっすぐだと全部が 1 本の線に重なる）
        bend: 46 + (1 - at) * 40 + Math.random() * 12,
        delay: Math.round((1 - at) * 5),
        t: 0,
        step: 1 / TRACER_FLIGHT,
        size: 4 + Math.min(3, count * 0.2),
        color: '#ffd257',
      });
    }
    // 撃った場所の火花。並んでいた弾が消える瞬間に何も出ないと、送ったことに気づけない
    for (let i = 0; i < Math.min(12, n * 2); i++) {
      this.particles.push({
        x: from.x0 + (from.x1 - from.x0) * Math.random(),
        y: from.y,
        vx: (Math.random() - 0.5) * 1.6,
        vy: -1 - Math.random() * 1.6,
        life: 1,
        maxLife: 12 + Math.random() * 8,
        size: 1.4 + Math.random() * 1.8,
        color: '#ffe9a8',
        shard: false,
        spin: 0,
        angle: 0,
        heavy: false,
      });
    }
    this.impacts.push({ frames: TRACER_FLIGHT + 4, count, cols, x: to.x, y: to.y });
    this.trimParticles();
    this.trimTracers();
  }

  /** 粒を足したあとに上限まで削る。古いものから消えるので、出たばかりの爆発は残る */
  private trimParticles(): void {
    const over = this.particles.length - MAX_PARTICLES;
    if (over > 0) this.particles.splice(0, over);
  }

  /**
   * 点火の爆発。個数と連続点火の回数で派手さが上がる。
   * 火の粉・破片・衝撃波の輪を重ねて、打ち上がる瞬間を強く見せる。
   */
  blast(x: number, y: number, kind: Kind, power: number): void {
    const look = LOOKS[kind];
    const n = Math.round(14 + power * 8);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (1.2 + Math.random() * 4.5) * (1 + power * 0.25);
      const shard = Math.random() < 0.45;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 1.4,
        life: 1,
        maxLife: 22 + Math.random() * 22,
        size: (shard ? 3 : 2) + Math.random() * 4,
        color: Math.random() < 0.35 ? '#ffffff' : Math.random() < 0.5 ? '#ffd257' : look.light,
        shard,
        spin: (Math.random() - 0.5) * 0.4,
        angle: Math.random() * Math.PI,
        heavy: true,
      });
    }
    this.trimParticles();
    this.ring(x, y, 22 + power * 18, '#ffe9a8', 4 + power);
    this.flare(x, y, 24 + power * 6, look.light, 0.1);
  }

  /** 閃き。r は光の玉の半径（外の薄いところまで）、decay は 1 フレームに消える割合 */
  flare(x: number, y: number, r: number, color: string, decay = 0.08): void {
    this.flares.push({ x, y, r, life: 1, decay, color });
    // 閃きは連鎖で 1 フレームに十数個出る。1 個ずつが広い面を塗るので、
    // 数が増えるとそのままフレーム時間になる。古いものから消して 8 個までにする
    if (this.flares.length > MAX_FLARES) this.flares.splice(0, this.flares.length - MAX_FLARES);
  }

  burst(x: number, y: number, kind: Kind, count = 10): void {
    const look = LOOKS[kind];
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1 + Math.random() * 3.5;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 1,
        life: 1,
        maxLife: 24 + Math.random() * 16,
        size: 2 + Math.random() * 4,
        color: Math.random() < 0.4 ? '#ffffff' : look.light,
        shard: false,
        spin: 0,
        angle: 0,
        heavy: true,
      });
    }
    this.trimParticles();
  }

  ring(x: number, y: number, maxR: number, color: string, width: number): void {
    this.rings.push({ x, y, r: maxR * 0.15, maxR, life: 1, color, width });
  }

  /**
   * 打ち上げの噴射。カタマリの下から火が伸びる。
   * 毎フレーム出すと上昇のあいだじゅう粒が溜まり続けるので、1 フレームおきに出して数を半分にする
   */
  thrust(x: number, y: number, power = 1): void {
    if (this.thrustTick % 2 === 1) return;
    const n = Math.max(1, Math.round(3 * power));
    // 推進が切れたあとの火は細く短くして、打ち上げの勢いと見分けられるようにする
    const scale = Math.min(1, 0.45 + power * 0.35);
    for (let i = 0; i < n; i++) {
      this.particles.push({
        x: x + (Math.random() - 0.5) * 10 * scale,
        y: y + Math.random() * 6,
        vx: (Math.random() - 0.5) * 1.4,
        vy: (2 + Math.random() * 3.5) * scale,
        life: 1,
        maxLife: 14 + Math.random() * 10,
        size: (4 + Math.random() * 5) * scale,
        color: Math.random() < 0.35 ? '#fff4c2' : Math.random() < 0.6 ? '#ffd257' : '#ff6a3d',
        shard: false,
        spin: 0,
        angle: 0,
        heavy: false,
      });
    }
    this.trimParticles();
  }

  /**
   * 点火した隕石そのものから散る火の粉。heat は燃え盛りの強さ、spread はマスの大きさ。
   * 1 マスにつき数フレームに 1 個だけ出す。毎フレーム出すと噴射のぶんと食い合って、
   * 上限で古い爆発の破片が先に消える
   */
  ember(x: number, y: number, heat: number, spread: number): void {
    this.particles.push({
      x: x + (Math.random() - 0.5) * spread * 0.8,
      y: y + (Math.random() - 0.5) * spread * 0.8,
      vx: (Math.random() - 0.5) * 1.8,
      vy: -1.6 + Math.random() * 2.6,
      life: 1,
      maxLife: 16 + Math.random() * 12,
      size: (1.6 + Math.random() * 3.4) * heat,
      color: Math.random() < 0.35 ? '#fff3c4' : Math.random() < 0.6 ? '#ffb43c' : '#ff6a2a',
      shard: false,
      spin: 0,
      angle: 0,
      heavy: false,
    });
    this.trimParticles();
  }

  /** 大気圏を抜けた瞬間。上へ光の筋が伸びる */
  screenOut(x: number, y: number, count: number): void {
    for (let i = 0; i < Math.min(6, count); i++) {
      this.streaks.push({
        x: x + (Math.random() - 0.5) * 12,
        y,
        len: 30 + Math.random() * 60,
        life: 1,
        speed: 14 + Math.random() * 10,
      });
    }
    this.ring(x, y, 26, '#bfe9ff', 3);
    this.flare(x, y, 32, '#bfe9ff', 0.08);
    this.beams.push({ x, y, w: 22 + Math.min(20, count * 3), life: 1 });
    if (this.beams.length > 12) this.beams.splice(0, this.beams.length - 12);
    for (let i = 0; i < 6; i++) {
      this.particles.push({
        x,
        y,
        vx: (Math.random() - 0.5) * 3,
        vy: -4 - Math.random() * 4,
        life: 1,
        maxLife: 18 + Math.random() * 10,
        size: 2 + Math.random() * 3,
        color: '#ffffff',
        shard: false,
        spin: 0,
        angle: 0,
        heavy: false,
      });
    }
    this.trimParticles();
  }

  popup(x: number, y: number, text: string, color: string, size = 26): void {
    this.popups.push({ x, y, text, life: 1, maxLife: 52, color, size });
  }

  /** 連鎖の吹き出し。大きな数字に `CHAIN` の札を添え、斜めに切った台に載せる */
  chain(x: number, y: number, combo: number, color: string, size: number): void {
    this.popups.push({ x, y, text: String(combo), tag: 'CHAIN', life: 1, maxLife: 58, color, size });
  }

  /**
   * 帯の見出しを出す。出ているものがあれば入れ替える。
   * delay だけ待ってから開く（始まりは盤面が組み上がるのを待つ）
   */
  banner(title: string, sub: string, color: string, len = 84, delay = 0): void {
    this.bannerNow = { title, place: 'center', y: 0, sub, color, t: -delay, len };
  }

  /** いちばん高い列のすぐ上（y が帯の真ん中）に、細い帯の見出しを出す。出ているものがあれば入れ替える */
  airBanner(title: string, sub: string, color: string, y: number, len = 84): void {
    this.bannerNow = { title, place: 'air', y, sub, color, t: 0, len };
  }

  /** 描いたことのある吹き出しの真ん中と幅の半分。盤面からはみ出していないかを e2e が見る */
  get popupSpans(): { x: number; half: number }[] {
    return this.popups.filter((p) => p.fitted).map((p) => ({ x: p.x, half: p.half ?? 0 }));
  }

  /** いま出ている帯の見出し。e2e が見る */
  get bannerTitle(): string | null {
    return this.bannerNow?.title ?? null;
  }

  /** いま出ている山の上の帯の真ん中の y（盤面の真ん中に出ているときは null）。e2e が見る */
  get bannerY(): number | null {
    return this.bannerNow?.place === 'air' ? this.bannerNow.y : null;
  }

  /** いま出ている帯の場所。e2e が見る */
  get bannerPlace(): BannerPlace | null {
    return this.bannerNow?.place ?? null;
  }

  addShake(n: number): void {
    this.shake = Math.min(26, this.shake + n);
  }

  /**
   * 勝ちの花火を始める。段取りは `STARMINE` で、音と同じ時刻に上がって弾ける。
   * box は発射台（bottom）と、弾ける高さの上限（top）、左右の端
   */
  fireworks(box: { left: number; right: number; top: number; bottom: number }): void {
    this.show = { kind: 'win', t: 0, box, next: 0, grandFired: false };
  }

  /** 負けの暗転と、相手のミニ盤面の勝ち名乗りを始める */
  defeat(): void {
    this.show = { kind: 'lose', t: 0, box: { left: 0, right: 0, top: 0, bottom: 0 }, next: 0, grandFired: false };
  }

  /** 負けの演出の途中で相打ちと分かった。相手の勝ち名乗りを引っ込める */
  withdrawCrown(): void {
    this.crownOff = true;
  }

  /**
   * 盤面に重ねたものをすべて片付ける。新しい盤面を始めるときに呼ぶ。
   * 惑星めぐりで次の惑星へ渡ると、前の盤面の吹き出しや帯が新しい盤面の出だしに残っていた
   */
  clear(): void {
    this.particles = [];
    this.popups = [];
    this.rings = [];
    this.streaks = [];
    this.flares = [];
    this.beams = [];
    this.bannerNow = null;
    this.tracers = [];
    this.impacts = [];
    this.hit = 0;
    this.hitCount = 0;
    this.hitCols = [];
    this.landed = 0;
    this.shake = 0;
    this.flash = 0;
    this.resetShow();
  }

  /** 決着の演出を片付ける */
  resetShow(): void {
    this.show = null;
    this.rockets = [];
    this.sparks = [];
    this.dim = 0;
    this.rivalCrown = 0;
    this.crownOff = false;
  }

  /**
   * 決着の演出を 1 フレーム進める。盤面が止まっている（ヒットストップ・スロー）あいだも
   * 実時間で進め、音とずれないようにする。止まった盤面の上で花火が上がる
   */
  updateShow(): void {
    const show = this.show;
    if (!show) return;
    show.t += 1;
    const sec = show.t / 60;
    if (show.kind === 'win') {
      const { box } = show;
      const width = box.right - box.left;
      const shells = STARMINE.shells;
      while (show.next < shells.length && shells[show.next].at <= sec) {
        const s = shells[show.next];
        const x = box.left + width * (0.5 + s.pan * 0.4);
        // 弾ける高さは盤面の上のほうに散らす。真ん中の帯の見出しに重なりすぎないように
        const y1 = box.top + (box.bottom - box.top) * (0.08 + ((show.next * 37) % 5) * 0.05);
        this.rockets.push({
          x, y0: box.bottom, y1, t: 0, len: Math.round(STARMINE.rise * 60), size: s.size,
          color: SHELL_COLORS[show.next % SHELL_COLORS.length], grand: false,
        });
        show.next += 1;
      }
      if (!show.grandFired && STARMINE.grand.at <= sec) {
        show.grandFired = true;
        this.rockets.push({
          x: box.left + width / 2, y0: box.bottom, y1: box.top + (box.bottom - box.top) * 0.18,
          t: 0, len: Math.round(STARMINE.grand.rise * 60), size: 1.6, color: '#ffe873', grand: true,
        });
      }
    } else {
      // 負けの音の 3 音が鳴るたびに、暗い幕を 1 段ずつ上げる
      const step = DUSK_STEPS.filter((at) => at <= sec).length;
      this.dim += (step / DUSK_STEPS.length - this.dim) * 0.12;
    }
    // 相手の勝ち名乗りは、止まっている 0.3 秒のあとから浮かび上がらせる
    const crown = show.kind === 'lose' && sec > 0.35 && !this.crownOff ? 1 : 0;
    this.rivalCrown += (crown - this.rivalCrown) * 0.08;

    for (const r of this.rockets) {
      r.t += 1;
      if (r.t === r.len) this.explode(r);
    }
    this.rockets = this.rockets.filter((r) => r.t < r.len);
    for (const p of this.sparks) {
      p.vx *= p.drag;
      p.vy = p.vy * p.drag + p.gravity;
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 1 / p.maxLife;
    }
    this.sparks = this.sparks.filter((p) => p.life > 0);
  }

  /** 花火が弾ける。火の粉を輪に散らし、真ん中を光らせる。大玉は 2 重の輪と長い枝垂れ */
  private explode(r: Rocket): void {
    const layers: { n: number; speed: number; color: string; life: number; drag: number; gravity: number }[] = r.grand
      ? [
          { n: 70, speed: 5.2, color: '#ffe873', life: 95, drag: 0.955, gravity: 0.045 },
          { n: 40, speed: 3.0, color: '#ffffff', life: 70, drag: 0.95, gravity: 0.04 },
        ]
      : [{ n: Math.round(30 * r.size), speed: 3.4 * r.size, color: r.color, life: 50, drag: 0.93, gravity: 0.035 }];
    for (const l of layers) {
      for (let i = 0; i < l.n; i++) {
        const a = (i / l.n) * Math.PI * 2 + Math.random() * 0.1;
        const sp = l.speed * (0.85 + Math.random() * 0.3);
        this.sparks.push({
          x: r.x, y: r.y1, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          life: 1, maxLife: l.life * (0.8 + Math.random() * 0.4),
          size: 2, color: Math.random() < 0.2 ? '#ffffff' : l.color,
          drag: l.drag, gravity: l.gravity,
        });
      }
    }
    if (this.sparks.length > MAX_SPARKS) this.sparks.splice(0, this.sparks.length - MAX_SPARKS);
    // 閃きは広い面を塗るので、大玉でも半径を抑える（大きくすると 1 フレームが倍になった）
    this.flare(r.x, r.y1, r.grand ? 80 : 44 * r.size, r.color, r.grand ? 0.05 : 0.08);
    this.ring(r.x, r.y1, r.grand ? 90 : 36 * r.size, r.color, r.grand ? 4 : 2.5);
    // 大玉は揺らすだけにする。全画面の閃光は 1 フレーム 6ms かかるうえ、光の玉だけで十分明るい
    if (r.grand) this.addShake(10);
  }

  /** 花火の笛の頭と火の粉を描く。盤面と粒の上、帯の見出しの下 */
  drawShow(ctx: CanvasRenderingContext2D): void {
    if (this.rockets.length === 0 && this.sparks.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const r of this.rockets) {
      const e = r.t / r.len;
      // 上がるほど遅くなる（打ち上げ花火の失速）
      const k = 1 - (1 - e) * (1 - e);
      const y = r.y0 + (r.y1 - r.y0) * k;
      const trail = Math.min(60, (r.y0 - y) * 0.5);
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = r.color;
      ctx.fillRect(r.x - 1, y, 2, trail);
      ctx.globalAlpha = 1;
      const g = r.grand ? 16 : 9;
      ctx.drawImage(glowSprite(r.color), r.x - g, y - g, g * 2, g * 2);
    }
    // 火の粉は、飛んでいる向きに短い尾を引く線で描く。1 個ずつ描くと色と濃さの切り替えで
    // 大玉のときに重くなるので、色と濃さ（3 段）が同じものを 1 本の path にまとめて 1 度で引く
    ctx.lineCap = 'round';
    ctx.lineWidth = 2.6;
    const buckets = new Map<string, Spark[]>();
    for (const p of this.sparks) {
      // 消える前にちらついて、燃え尽きるように見せる
      const alpha = Math.min(1, p.life * 1.4) * (p.life < 0.3 && Math.random() < 0.5 ? 0.3 : 1);
      const key = `${p.color}|${Math.max(1, Math.ceil(alpha * 3))}`;
      const list = buckets.get(key);
      if (list) list.push(p);
      else buckets.set(key, [p]);
    }
    for (const [key, list] of buckets) {
      const [color, level] = key.split('|');
      ctx.globalAlpha = Number(level) / 3;
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (const p of list) {
        ctx.moveTo(p.x - p.vx * 2.5, p.y - p.vy * 2.5);
        ctx.lineTo(p.x + 0.01, p.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * 負けの暗い幕。盤面の下から上へ、dim の高さまで覆う。上の縁だけぼかす。
   * x, top, w, bottom は盤面の範囲
   */
  drawDim(ctx: CanvasRenderingContext2D, x: number, top: number, w: number, bottom: number): void {
    if (this.dim <= 0.001) return;
    const h = (bottom - top) * this.dim;
    const edge = Math.min(40, h);
    const y = bottom - h;
    ctx.save();
    ctx.fillStyle = 'rgba(3,2,12,0.78)';
    ctx.fillRect(x, y + edge, w, h - edge);
    const g = ctx.createLinearGradient(0, y, 0, y + edge);
    g.addColorStop(0, 'rgba(3,2,12,0)');
    g.addColorStop(1, 'rgba(3,2,12,0.78)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, edge);
    ctx.restore();
  }

  addFlash(n: number): void {
    this.flash = Math.min(1, this.flash + n);
  }

  update(): void {
    this.thrustTick += 1;
    for (const [id, s] of this.slides) {
      s.t -= 1 / SLIDE_FRAMES;
      if (s.t <= 0) this.slides.delete(id);
    }
    for (const p of this.particles) {
      p.x += p.vx;
      p.y += p.vy;
      if (p.heavy) p.vy += 0.16;
      p.vx *= 0.98;
      p.angle += p.spin;
      p.life -= 1 / p.maxLife;
    }
    this.particles = this.particles.filter((p) => p.life > 0);

    for (const p of this.popups) {
      p.y -= 1.1;
      p.life -= 1 / p.maxLife;
    }
    this.popups = this.popups.filter((p) => p.life > 0);

    for (const r of this.rings) {
      r.r += (r.maxR - r.r) * 0.22;
      r.life -= 0.055;
    }
    this.rings = this.rings.filter((r) => r.life > 0);

    for (const s of this.streaks) {
      s.y -= s.speed;
      s.life -= 0.06;
    }
    this.streaks = this.streaks.filter((s) => s.life > 0);

    if (this.bannerNow) {
      this.bannerNow.t += 1;
      if (this.bannerNow.t >= this.bannerNow.len) this.bannerNow = null;
    }

    for (const f of this.flares) f.life -= f.decay;
    this.flares = this.flares.filter((f) => f.life > 0);
    for (const b of this.beams) b.life -= 0.045;
    this.beams = this.beams.filter((b) => b.life > 0);

    for (const t of this.tracers) {
      if (t.delay > 0) t.delay -= 1;
      else t.t += t.step;
    }
    this.tracers = this.tracers.filter((t) => t.t < 1);

    for (const im of this.impacts) im.frames -= 1;
    for (const im of this.impacts) {
      if (im.frames > 0) continue;
      this.hit = 1;
      this.hitCount = im.count;
      this.hitCols = im.cols;
      this.landed += im.count;
      // 着弾の火花。ミニ盤面は小さいので、粒も小さく数を抑える
      for (let i = 0; i < Math.min(10, 4 + im.count); i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 1 + Math.random() * 2.4;
        this.particles.push({
          x: im.x,
          y: im.y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          life: 1,
          maxLife: 14 + Math.random() * 10,
          size: 1.5 + Math.random() * 2,
          color: Math.random() < 0.5 ? '#ffd257' : '#ffffff',
          shard: false,
          spin: 0,
          angle: 0,
          heavy: false,
        });
      }
      this.trimParticles();
    }
    this.impacts = this.impacts.filter((im) => im.frames > 0);

    this.hit *= 0.88;
    if (this.hit < 0.02) this.hit = 0;

    this.shake *= 0.86;
    if (this.shake < 0.2) this.shake = 0;
    this.flash *= 0.86;
    if (this.flash < 0.01) this.flash = 0;
  }

  /**
   * 描画の前に呼ぶ。揺れの分だけ原点をずらす。
   * ずらしは整数の px にする。小数でずらすと焼いた絵（隕石・盤面の枠）が画素に揃わず、
   * 貼るたびに補間が入って、揺れているあいだだけ 1 フレームが 17ms 重くなっていた
   */
  applyShake(ctx: CanvasRenderingContext2D): void {
    if (this.shake === 0) return;
    ctx.translate(
      Math.round((Math.random() - 0.5) * this.shake),
      Math.round((Math.random() - 0.5) * this.shake),
    );
  }

  /** left と right は盤面の左右の端。吹き出しをこの内側に収める */
  draw(ctx: CanvasRenderingContext2D, left: number, right: number): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // 光の柱。根元から上へ、画面の上端まで伸ばす。細りながら消える
    for (const b of this.beams) {
      const w = b.w * (0.35 + 0.65 * b.life);
      ctx.globalAlpha = b.life * 0.85;
      ctx.drawImage(beamSprite('#8fd8ff'), b.x - w / 2, 0, w, b.y);
    }

    for (const f of this.flares) {
      // 出た瞬間が最も大きく、そこから縮みながら消える
      const r = f.r * (0.55 + 0.45 * f.life);
      ctx.globalAlpha = f.life;
      ctx.drawImage(glowSprite(f.color), f.x - r, f.y - r, r * 2, r * 2);
    }

    for (const s of this.streaks) {
      ctx.globalAlpha = Math.max(0, s.life) * 0.9;
      const g = ctx.createLinearGradient(s.x, s.y, s.x, s.y + s.len);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, '#cfe9ff');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x, s.y + s.len);
      ctx.stroke();
    }

    for (const r of this.rings) {
      ctx.globalAlpha = Math.max(0, r.life) * 0.85;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.width * r.life;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
    }

    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      if (p.shard) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        const s = p.size * p.life;
        ctx.fillRect(-s / 2, -s / 2, s, s);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    for (const p of this.popups) this.drawPopup(ctx, p, left, right);
  }

  /**
   * 吹き出しを 1 つ描く。left と right は盤面の左右の端で、字がここからはみ出さないよう寄せる。
   * 端の列で点火すると、真ん中に置いた字の半分が画面の外へ切れていた
   */
  private drawPopup(ctx: CanvasRenderingContext2D, p: Popup, left: number, right: number): void {
    // 出た瞬間ははっきり見せ、最後だけ消える
    const t = Math.min(1, Math.max(0, p.life) * 2.2);
    // 出てすぐ大きく弾ませる
    const pop = 1 + Math.max(0, 1 - (1 - p.life) * 8) * 0.55;
    const numSize = p.tag ? p.size * 1.3 : p.size;
    const tagSize = p.size * 0.42;
    const gap = p.size * 0.12;
    ctx.save();
    ctx.lineJoin = 'round';

    // 最初に描くとき、いちばん大きく弾んだ幅で測って、盤面の中に収まるよう x を寄せる。
    // 毎フレーム測って寄せると、縮むにつれて字が横へ流れる
    const measure = (scale: number): { num: number; tag: number } => {
      ctx.font = `italic 900 ${numSize * scale}px ${DISPLAY}`;
      const num = ctx.measureText(p.text).width;
      let tag = 0;
      if (p.tag) {
        ctx.font = `italic 900 ${tagSize * scale}px ${DISPLAY}`;
        spacing(ctx, 1);
        tag = ctx.measureText(p.tag).width + gap * scale;
        spacing(ctx, 0);
      }
      return { num, tag };
    };
    if (!p.fitted) {
      p.fitted = true;
      const peak = measure(1.55);
      // 縁取りと斜体のぶん、字の幅より少し広く取る
      const half = (peak.num + peak.tag) / 2 + p.size * 0.45;
      p.half = half;
      const lo = left + half;
      const hi = right - half;
      p.x = lo > hi ? (left + right) / 2 : Math.min(hi, Math.max(lo, p.x));
    }
    const w = measure(pop);
    const x0 = p.x - (w.num + w.tag) / 2;

    if (p.tag) {
      // 斜めに切った台。字より先に伸びて、字の後ろに敷かれる
      const grow = Math.min(1, (1 - p.life) * 9);
      const ph = p.size * 1.15 * pop;
      const skew = ph * 0.3;
      const pad = p.size * 0.35;
      const pw = (w.num + w.tag + pad * 2) * grow;
      const px = p.x - pw / 2;
      const py = p.y - ph * 0.8;
      ctx.globalAlpha = t;
      ctx.fillStyle = 'rgba(4,6,20,0.62)';
      ctx.beginPath();
      ctx.moveTo(px + skew, py);
      ctx.lineTo(px + pw + skew, py);
      ctx.lineTo(px + pw - skew, py + ph);
      ctx.lineTo(px - skew, py + ph);
      ctx.closePath();
      ctx.fill();
      // 下の縁に色の線。台が浮いた札に見える
      ctx.fillStyle = p.color;
      ctx.fillRect(px - skew, py + ph - 2, pw, 2);
    }

    ctx.font = `italic 900 ${numSize * pop}px ${DISPLAY}`;
    ctx.textAlign = 'left';
    // 外側のにじみ。色の太線を薄く足し合わせる
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = t * 0.28;
    ctx.lineWidth = numSize * pop * 0.32;
    ctx.strokeStyle = p.color;
    ctx.strokeText(p.text, x0, p.y);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = t;
    ctx.lineWidth = Math.max(5, numSize * pop * 0.18);
    ctx.strokeStyle = 'rgba(4,2,16,0.85)';
    ctx.strokeText(p.text, x0, p.y);
    // 上が白く、下へ色に染まる字。金属の文字のように見せる
    const g = ctx.createLinearGradient(0, p.y - numSize * pop * 0.8, 0, p.y);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.55, p.color);
    g.addColorStop(1, p.color);
    ctx.fillStyle = g;
    ctx.fillText(p.text, x0, p.y);

    if (p.tag) {
      ctx.font = `italic 900 ${tagSize * pop}px ${DISPLAY}`;
      spacing(ctx, 1);
      const tx = x0 + w.num + gap * pop;
      ctx.lineWidth = Math.max(3, tagSize * pop * 0.3);
      ctx.strokeText(p.tag, tx, p.y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.tag, tx, p.y);
      spacing(ctx, 0);
    }
    ctx.restore();
  }

  /**
   * 帯の見出し。盤面の幅いっぱいの暗い帯が真ん中から左右へ開き、字が右から滑り込み、
   * 最後は帯が上下から閉じて消える。揺れの外で、得点欄より後に描く。
   * x・w は盤面の左端と幅、centerY は盤面の真ん中に出すときの y、skyY は air の帯を寄せられるいちばん上の y
   * （大気圏の帯の下寄り。山が高くて空きが無いときはここに出す）。
   * air の帯は細く薄くして、降ってくる隕石や浮いているカタマリが透けて見えるようにする。
   * 滅亡の数え上げのあいだ（hideAir）は山が大気圏まで届いていて DANGER の札と重なるので、air の帯は描かない
   */
  drawBanner(
    ctx: CanvasRenderingContext2D,
    x: number,
    w: number,
    centerY: number,
    skyY: number,
    cell: number,
    hideAir: boolean,
  ): void {
    const b = this.bannerNow;
    if (!b || b.t < 0) return;
    const air = b.place === 'air';
    if (air && hideAir) return;
    const cy = air ? Math.max(b.y, skyY) : centerY;
    // 大気圏の帯（2 マスぶん、左上に練習のヒントの方針）に寄せても収まる大きさにする
    const scale = air ? 0.6 : 1;
    const open = Math.min(1, b.t / 9);
    const openE = 1 - (1 - open) * (1 - open);
    const close = Math.max(0, (b.t - (b.len - 10)) / 10);
    const h = cell * 1.9 * scale * (1 - close * close);
    if (h <= 1) return;
    const bw = w * openE;
    const bx = x + (w - bw) / 2;
    const top = cy - h / 2;

    ctx.save();
    // 帯。真ん中が濃く、上下の縁に色の線を引く
    ctx.fillStyle = air ? 'rgba(3,4,16,0.42)' : 'rgba(3,4,16,0.74)';
    ctx.fillRect(bx, top, bw, h);
    ctx.fillStyle = b.color;
    ctx.fillRect(bx, top, bw, 2);
    ctx.fillRect(bx, top + h - 2, bw, 2);
    // 縁の線の上を光が走る
    ctx.globalCompositeOperation = 'lighter';
    const run = ((b.t * 14) % (w + cell * 4)) - cell * 2;
    const glow = glowSprite(b.color);
    ctx.globalAlpha = 0.8;
    ctx.drawImage(glow, x + run - cell * 1.5, top - 6, cell * 3, 12);
    ctx.drawImage(glow, x + w - run - cell * 1.5, top + h - 6, cell * 3, 12);
    ctx.globalCompositeOperation = 'source-over';

    ctx.beginPath();
    ctx.rect(bx, top, bw, h);
    ctx.clip();

    // 両端の流れる山形。帯が止まって見えないようにする
    ctx.globalAlpha = 0.35 * (1 - close);
    ctx.strokeStyle = b.color;
    ctx.lineWidth = 2;
    const chev = cell * 0.22 * scale;
    for (let i = 0; i < 3; i++) {
      const off = ((b.t * 0.6 + i * chev * 1.4) % (chev * 4.2));
      for (const [ax, d] of [
        [x + cell * 0.3 + off, 1],
        [x + w - cell * 0.3 - off, -1],
      ] as const) {
        ctx.beginPath();
        ctx.moveTo(ax - chev * 0.5 * d, cy - chev);
        ctx.lineTo(ax + chev * 0.5 * d, cy);
        ctx.lineTo(ax - chev * 0.5 * d, cy + chev);
        ctx.stroke();
      }
    }

    // 字は右から滑り込んで、真ん中で止まる
    const slide = Math.min(1, Math.max(0, (b.t - 3) / 10));
    const slideE = 1 - (1 - slide) * (1 - slide) * (1 - slide);
    const dx = (1 - slideE) * cell * 2.4;
    const fade = slideE * (1 - close);
    const cx = x + w / 2 + dx;
    ctx.textAlign = 'center';
    ctx.globalAlpha = fade;

    if (b.sub) {
      ctx.font = `800 ${Math.max(9, Math.round(cell * 0.26 * (air ? 0.75 : 1)))}px ${DISPLAY}`;
      spacing(ctx, Math.max(2, cell * 0.08));
      ctx.fillStyle = b.color;
      ctx.fillText(b.sub, cx, cy - h * 0.2);
      spacing(ctx, 0);
    }
    const size = Math.round(Math.min(cell * 0.82 * scale, (w * 0.8) / Math.max(4, b.title.length * 0.72)));
    ctx.font = `italic 900 ${size}px ${DISPLAY}`;
    spacing(ctx, Math.max(1, size * 0.06));
    const ty = cy + (b.sub ? h * 0.3 : size * 0.35);
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = fade * 0.3;
    ctx.lineWidth = size * 0.3;
    ctx.strokeStyle = b.color;
    ctx.strokeText(b.title, cx, ty);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = fade;
    const g = ctx.createLinearGradient(0, ty - size * 0.8, 0, ty);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.6, '#ffffff');
    g.addColorStop(1, b.color);
    ctx.fillStyle = g;
    ctx.fillText(b.title, cx, ty);
    spacing(ctx, 0);
    ctx.restore();
  }

  /**
   * 攻撃の弾。得点の並びや相手のミニ盤面の上を通るので、盤面の粒とは分けて最後に描く。
   * 揺れの中で描くと狙った場所へ飛んでいるように見えないので、揺れの外で呼ぶ
   */
  drawOverlay(ctx: CanvasRenderingContext2D): void {
    if (this.tracers.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const t of this.tracers) {
      if (t.delay > 0) continue;
      const here = tracerAt(t, t.t);
      const tail = tracerAt(t, Math.max(0, t.t - 0.18));
      // 着く直前だけ薄くして、盤面に吸い込まれたように見せる
      ctx.globalAlpha = Math.min(1, (1 - t.t) * 5);
      ctx.strokeStyle = t.color;
      ctx.lineWidth = t.size * 0.8;
      ctx.beginPath();
      ctx.moveTo(tail.x, tail.y);
      ctx.lineTo(here.x, here.y);
      ctx.stroke();
      const r = t.size * 1.6;
      ctx.drawImage(glowSprite(t.color), here.x - r, here.y - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  /** 画面全体の閃光。最後に重ねる */
  drawFlash(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    if (this.flash <= 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255,255,255,${this.flash * 0.7})`;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
}

/** 弾の位置。終点へ向かうほど速くし、上へ弧を描く */
function tracerAt(t: Tracer, at: number): { x: number; y: number } {
  const e = at * at * (3 - 2 * at);
  return {
    x: t.x0 + (t.x1 - t.x0) * e,
    y: t.y0 + (t.y1 - t.y0) * e - Math.sin(e * Math.PI) * t.bend,
  };
}
