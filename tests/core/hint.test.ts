import { describe, expect, it } from 'vitest';
import { Game } from '../../src/core/game';
import { Hinter } from '../../src/core/hint';
import { Kind } from '../../src/core/types';

let nextId = 5000;

/** 左の 3 列だけに積んだ盤面。3 列目の丸を 1 つ下ろせば、いちばん下で丸が横に 3 つ揃う */
function oneMoveAway(): Game {
  const g = new Game({ seed: 3, rareMetal: false });
  const put = (kinds: Kind[]) =>
    kinds.map((kind) => ({ id: nextId++, kind, revert: 0, fromAttack: false, ignitedAt: -1 }));
  g.ground = g.ground.map(() => []);
  g.ground[0] = put([Kind.Circle]);
  g.ground[1] = put([Kind.Circle]);
  g.ground[2] = put([Kind.Drop, Kind.Circle]);
  g.fallings = [];
  return g;
}

describe('ヒント', () => {
  it('揃う 1 手を、運ぶ隕石の row から運び先の row への矢印で出す', () => {
    const g = oneMoveAway();
    const hinter = new Hinter();
    hinter.update(g);
    expect(hinter.arrow(g)).toEqual({ col: 2, from: 1, to: 0 });
  });

  it('手本どおりに運ぶと、その矢印は消える', () => {
    const g = oneMoveAway();
    const hinter = new Hinter();
    hinter.update(g);
    g.grab(2, 1);
    g.dragBy(-1);
    g.release();
    expect(hinter.arrow(g)).toBeNull();
  });

  it('考えても盤面は変えない（CPU の思考を写した盤面ではなく本物の盤面で回すため）', () => {
    const g = oneMoveAway();
    const before = JSON.stringify(g.ground);
    const hinter = new Hinter();
    for (let i = 0; i < 40; i++) hinter.update(g);
    expect(JSON.stringify(g.ground)).toBe(before);
  });

  it('盤面が替わったら前の盤面の手本は出さない', () => {
    const g = oneMoveAway();
    const hinter = new Hinter();
    hinter.update(g);
    const other = oneMoveAway();
    expect(hinter.arrow(other)).toBeNull();
  });
});
