import { describe, expect, it } from 'vitest';
import { groundPlans } from '../../src/core/cpu';
import { forecastDock } from '../../src/core/dock';
import { Game } from '../../src/core/game';
import { Kind, type Meteor } from '../../src/core/types';

let nextId = 9000;
const meteor = (kind: Kind): Meteor => ({ id: nextId++, kind, revert: 0, fromAttack: false, ignitedAt: -1 });

/**
 * 左の 3 列に、3 列目の丸を 1 つ下ろせば横に揃う山。その上に、浮いているカタマリを 1 つ置く。
 * カタマリは y の高さで、vy の速さで動いている
 */
function scene(y: number, vy: number): Game {
  const g = new Game({ seed: 4, rareMetal: false });
  g.ground = g.ground.map(() => []);
  g.ground[0] = [meteor(Kind.Circle), meteor(Kind.Square)];
  g.ground[1] = [meteor(Kind.Circle), meteor(Kind.Hexagon)];
  g.ground[2] = [meteor(Kind.Drop), meteor(Kind.Circle)];
  g.fallings = [];
  g.lumps = [
    {
      id: 777,
      cells: [
        { col: 1, rel: 0, meteor: meteor(Kind.Triangle) },
        { col: 1, rel: 1, meteor: meteor(Kind.Pentagon) },
      ],
      y,
      vy,
      thrustFrames: 0,
      thrustAccel: 0,
      combo: 1,
    },
  ];
  return g;
}

/** 本物の盤面を写して、delay フレーム後に手を打ち、horizon フレームのうちにドッキングが起きたか */
function docksForReal(g: Game, delay: number, horizon = 240): boolean {
  const f = g.fork();
  for (let t = 0; t < delay; t++) f.tick();
  f.grab(2, 1.5);
  f.dragBy(-1);
  f.release();
  for (let t = delay; t < horizon; t++) {
    if (f.tick().airDock > 0) return true;
  }
  return false;
}

describe('ドッキングの見積もり', () => {
  it('浮いているカタマリの真下で点火すれば、当たると見積もる', () => {
    const g = scene(5, 0);
    const plan = groundPlans(g, true).find((p) => p.moves.length === 1 && p.pattern.some((c) => c.col === 1))!;
    expect(forecastDock(g, plan, 0)).toMatchObject({ lumpId: 777 });
    expect(docksForReal(g, 0)).toBe(true);
  });

  it('打つのが遅れて、先にカタマリが着地してしまうなら当たらないと見積もる', () => {
    const g = scene(4, -0.05);
    const plan = groundPlans(g, true).find((p) => p.moves.length === 1 && p.pattern.some((c) => c.col === 1))!;
    expect(forecastDock(g, plan, 200)).toBeNull();
    expect(docksForReal(g, 200)).toBe(false);
  });

  it('高さ・速さ・遅れを振っても、本物の盤面を進めた結果と 9 割以上で合う', () => {
    let agree = 0;
    let total = 0;
    for (const y of [3, 5, 7, 9, 11]) {
      for (const vy of [-0.06, -0.02, 0, 0.05]) {
        for (const delay of [0, 40, 100, 160]) {
          const g = scene(y, vy);
          const plan = groundPlans(g, true).find(
            (p) => p.moves.length === 1 && p.pattern.some((c) => c.col === 1),
          )!;
          const said = forecastDock(g, plan, delay) !== null;
          if (said === docksForReal(g, delay)) agree++;
          total++;
        }
      }
    }
    expect(agree / total).toBeGreaterThanOrEqual(0.9);
  });
});
