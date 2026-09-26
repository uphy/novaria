/**
 * CPU との対戦。2 つの盤面を同じ tick で進め、打ち上げたぶんを互いに降らせる。
 * 原作の対戦は「大気圏外へ出した隕石が相手の盤面に燃えカスとして降る」。
 */
import { CPU_STYLES, Cpu, CpuLevel } from './cpu';
import { Events, Game } from './game';

/** 自分から見た決着 */
export type VersusResult = 'win' | 'lose' | 'draw';

export interface VersusOptions {
  seed: number;
  level: CpuLevel;
}

export class Versus {
  readonly player: Game;
  readonly rival: Game;
  readonly level: CpuLevel;
  private cpu: Cpu;
  /** 決着。まだついていなければ null */
  result: VersusResult | null = null;

  constructor(opts: VersusOptions) {
    this.level = opts.level;
    this.player = new Game({ seed: opts.seed });
    // 相手には別の seed を渡す。同じだと左右で同じ盤面が降ってくる
    this.rival = new Game({ seed: ((opts.seed * 31 + 1013904223) & 0x7fffffff) || 2 });
    this.cpu = new Cpu(this.rival, CPU_STYLES[opts.level]);
  }

  /** 両方の盤面を 1 フレーム進める。戻り値は演出のための出来事 */
  tick(): { player: Events; rival: Events } {
    this.cpu.think();
    const player = this.player.tick();
    const rival = this.rival.tick();

    // 送るのは次のフレームからではなく、その場で降らせる。
    // CPU の攻撃だけは強さに応じて増減する（`CpuStyle.attackScale`）
    if (player.attackSent > 0) {
      rival.attackTaken += this.rival.receiveAttack(player.attackSent, rival);
    }
    if (rival.attackSent > 0) {
      player.attackTaken += this.player.receiveAttack(
        Math.round(rival.attackSent * this.cpu.style.attackScale),
        player,
      );
    }

    if (this.result === null) {
      if (this.player.over && this.rival.over) this.result = 'draw';
      else if (this.player.over) this.result = 'lose';
      else if (this.rival.over) this.result = 'win';
    }
    return { player, rival };
  }

  /** 一時停止などで指を離すとき、両方の盤面の操作を切る */
  release(): void {
    this.player.release();
    this.rival.release();
  }
}
