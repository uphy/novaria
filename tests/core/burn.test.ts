/**
 * 点火した隕石が燃えて見える長さ。見た目だけのものだが、いつ燃え終わるかは
 * `Meteor.ignitedAt` で決まるのでコア側で確かめる
 */
import { describe, expect, it } from 'vitest';
import { Game, burnHeat } from '../../src/core/game';
import { Kind } from '../../src/core/types';
import { BURN_FRAMES, IGNITION_GRACE_FRAMES } from '../../src/core/constants';

function stillGame(columns: Kind[][]): Game {
  const g = new Game({ seed: 3, rareMetal: false });
  for (let c = 0; c < g.cols; c++) g.ground[c] = [];
  columns.forEach((col, c) =>
    col.forEach((kind, i) =>
      g.ground[c].push({ id: c * 100 + i, kind, revert: 0, fromAttack: false, ignitedAt: -1 }),
    ),
  );
  return g;
}

function tick(g: Game, count: number): void {
  for (let i = 0; i < count; i++) g.tick();
}

describe('燃える長さ', () => {
  it('空中に浮いたままの燃えカスも、点火から BURN_FRAMES で燃え終わる', () => {
    // 横 3 つそろえて打ち上げる。燃えカスはカタマリの一部として空中に居続ける
    const g = stillGame([[Kind.Triangle], [Kind.Triangle], [Kind.Triangle]]);
    tick(g, IGNITION_GRACE_FRAMES + 1);
    const dust = g.lumps[0].cells.find((c) => c.meteor.kind === Kind.Dust)!.meteor;
    expect(dust.ignitedAt).toBeGreaterThanOrEqual(0);
    expect(burnHeat(dust, g.frame)).toBeGreaterThan(0);

    // 燃えている途中は弱まっていく
    tick(g, BURN_FRAMES / 2);
    expect(burnHeat(dust, g.frame)).toBeGreaterThan(0);
    expect(burnHeat(dust, g.frame)).toBeLessThan(0.6);

    // 燃え終わったら 0。ここで空中に居続けていても消える
    // （還元までの残りフレームで測っていたころは、地面に着くまで減らないので燃えっぱなしだった）
    tick(g, BURN_FRAMES);
    expect(g.lumps.length).toBe(1);
    expect(dust.revert).toBe(g.revertDustFrames);
    expect(burnHeat(dust, g.frame)).toBe(0);
  });

  it('攻撃で降ってきた燃えカスは燃えない', () => {
    const g = stillGame([[], [], []]);
    g.receiveAttack(3);
    tick(g, 30);
    const dust = g.fallings.map((f) => f.meteor).filter((m) => m.kind === Kind.Dust);
    expect(dust.length).toBe(3);
    // 相手の惑星で燃え終わったあとのぶんなので、こちらでは燃えない
    for (const m of dust) expect(burnHeat(m, g.frame)).toBe(0);
  });

  it('燃えカス以外は燃えない', () => {
    const g = stillGame([[Kind.Triangle], [Kind.Drop], [Kind.Circle]]);
    for (const m of g.ground.flat()) expect(burnHeat(m, g.frame)).toBe(0);
  });
});
