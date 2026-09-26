/**
 * 惑星めぐり。惑星を 1 つずつ渡り、打ち上げた数が脱出ゲージを満たしたら次の惑星へ進む。
 * 盤面は惑星ごとに組み直し、得点と打ち上げ数は道のり全体で足していく。
 *
 * 原作の「惑星を渡っていくひとり用」にあたるが、道のりも脱出の条件もこちら側で決めたもの
 * （docs/decisions.md「惑星めぐり」）。
 */
import { Game, type Events } from './game';
import { TOUR, type Stage } from './planets';

export interface TourOptions {
  seed: number;
  /** 道のり。テストとシミュレーションからは短い並びを渡す */
  stages?: readonly Stage[];
  /** レアメタルを出すか。テストでは切る */
  rareMetal?: boolean;
}

/** 次の惑星の seed。惑星ごとに違う盤面から始める */
function nextSeed(seed: number): number {
  return ((seed * 31 + 1013904223) & 0x7fffffff) || 2;
}

export class Tour {
  readonly stages: readonly Stage[];
  /** いまいる惑星の番号（0 から） */
  index = 0;
  game: Game;
  /** いまの惑星を抜けたか。次の惑星へ進むまで立ったまま */
  escaped = false;
  /** 最後の惑星まで抜けたか */
  completed = false;

  private seed: number;
  private readonly rareMetal: boolean;
  /** 抜けてきた惑星ぶんの合計。いまの惑星のぶんは `game` から足す */
  private clearedScore = 0;
  private clearedLaunched = 0;
  private clearedFrames = 0;
  private clearedCombo = 0;

  constructor(opts: TourOptions) {
    this.stages = opts.stages ?? TOUR;
    this.rareMetal = opts.rareMetal ?? true;
    this.seed = opts.seed;
    this.game = new Game({
      seed: this.seed,
      planet: this.stages[0].planet,
      rareMetal: this.rareMetal,
    });
  }

  get stage(): Stage {
    return this.stages[this.index];
  }

  /** いまの惑星で打ち上げた数。脱出ゲージはこれで測る */
  get launched(): number {
    const l = this.game.launched;
    return l.normal + l.dust + l.rare;
  }

  /** 脱出ゲージの満ち具合（0〜1） */
  get progress(): number {
    return Math.min(1, this.launched / this.stage.goal);
  }

  /** 道のり全体の得点 */
  get score(): number {
    return this.clearedScore + this.game.score;
  }

  /** 道のり全体で打ち上げた数 */
  get totalLaunched(): number {
    return this.clearedLaunched + this.launched;
  }

  /** 道のり全体のフレーム数 */
  get frames(): number {
    return this.clearedFrames + this.game.frame;
  }

  get maxCombo(): number {
    return Math.max(this.clearedCombo, this.game.maxCombo);
  }

  /**
   * 滅亡したか。脱出したフレームに積みきっていても、抜けたほうを取る。
   * ゲージが満ちてから結果を出すまでのあいだも盤面は動き続けるので、そこで潰れても道のりは続く
   */
  get over(): boolean {
    return this.game.over && !this.escaped;
  }

  /** 1 フレーム進める。ゲージが満ちたら `escaped` が立つ */
  tick(): Events {
    const ev = this.game.tick();
    if (!this.escaped && this.launched >= this.stage.goal) {
      this.escaped = true;
      this.completed = this.index === this.stages.length - 1;
    }
    return ev;
  }

  /** 次の惑星へ進む。盤面は組み直し、得点と打ち上げ数は持っていく */
  advance(): void {
    if (!this.escaped || this.completed) return;
    this.clearedScore += this.game.score;
    this.clearedLaunched += this.launched;
    this.clearedFrames += this.game.frame;
    this.clearedCombo = this.maxCombo;
    this.index++;
    this.escaped = false;
    this.seed = nextSeed(this.seed);
    this.game = new Game({
      seed: this.seed,
      planet: this.stage.planet,
      rareMetal: this.rareMetal,
    });
  }

  /** 一時停止などで指を離す */
  release(): void {
    this.game.release();
  }
}
