import { describe, expect, it } from 'vitest';
import { CPU_STYLES, Cpu } from '../../src/core/cpu';
import { Game } from '../../src/core/game';
import { Kind } from '../../src/core/types';

/** 真ん中の 1 列だけが 11 段に積もり、ほかは空の盤面。三角が 3 つ、離れて埋まっている */
function oneTallColumn(): Game {
  const g = new Game({ seed: 5, rareMetal: false });
  for (let c = 0; c < g.cols; c++) g.ground[c] = [];
  for (let r = 0; r < 11; r++) {
    const kind = r === 1 || r === 5 || r === 9 ? Kind.Triangle : r % 2 === 0 ? Kind.Circle : Kind.Drop;
    g.ground[4].push({ id: 1000 + r, kind, revert: 0, fromAttack: false, ignitedAt: -1 });
  }
  return g;
}

/** CPU に遊ばせて、真ん中の列で点火が起きたか */
function ignitesTallColumn(g: Game, cpu: Cpu): boolean {
  for (let i = 0; i < 300; i++) {
    cpu.think();
    const events = g.tick();
    if (events.ignitions.some((e) => e.cells.some((cell) => cell.col === 4))) return true;
  }
  return false;
}

describe('CPU', () => {
  it('列を見張る CPU は、1 列だけ高く積もった山を縦にそろえて崩す', () => {
    const g = oneTallColumn();
    expect(ignitesTallColumn(g, new Cpu(g, CPU_STYLES.hard))).toBe(true);
  });

  it('横にしかそろえない CPU（よわい）は、その山に手を出せない', () => {
    const g = oneTallColumn();
    expect(ignitesTallColumn(g, new Cpu(g, CPU_STYLES.easy))).toBe(false);
  });

  it('列を見張る CPU は、放っておいても 1 人で 3 分もつ', () => {
    for (const seed of [1, 2, 3]) {
      const g = new Game({ seed });
      const cpu = new Cpu(g, CPU_STYLES.normal);
      for (let i = 0; i < 60 * 180 && !g.over; i++) {
        cpu.think();
        g.tick();
      }
      expect(g.over).toBe(false);
    }
  });
});
