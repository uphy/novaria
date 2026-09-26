import { describe, expect, it } from 'vitest';
import { Game } from '../../src/core/game';

/** 放っておいたときに何秒で滅亡するか。遊びの速さの目安 */
describe('放置したときの長さ', () => {
  it('30秒から3分のあいだで滅亡する', () => {
    const times: number[] = [];
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const g = new Game({ seed });
      let f = 0;
      while (!g.over && f < 60 * 60 * 6) {
        g.tick();
        f++;
      }
      times.push(f / 60);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    expect(avg).toBeGreaterThan(30);
    expect(avg).toBeLessThan(180);
  });
});
