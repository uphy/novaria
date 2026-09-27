import { describe, expect, it } from 'vitest';
import { Game } from '../../src/core/game';
import { Hinter } from '../../src/core/hint';
import { Kind } from '../../src/core/types';

let nextId = 5000;

/** 列ごとに下から積んだ盤面。降ってくる隕石は消しておく */
function board(columns: Kind[][]): Game {
  const g = new Game({ seed: 3, rareMetal: false });
  g.ground = g.ground.map((_, c) =>
    (columns[c] ?? []).map((kind) => ({ id: nextId++, kind, revert: 0, fromAttack: false, ignitedAt: -1 })),
  );
  g.fallings = [];
  return g;
}

/** 3 列目の丸を 1 つ下ろせば、いちばん下で丸が横に 3 つ揃う */
function oneMoveAway(): Game {
  return board([[Kind.Circle], [Kind.Circle], [Kind.Drop, Kind.Circle]]);
}

describe('ヒント', () => {
  it('揃う 1 手を、運ぶ隕石の row から運び先の row への矢印で出す', () => {
    const g = oneMoveAway();
    const hinter = new Hinter();
    hinter.update(g);
    expect(hinter.arrow(g)).toEqual({
      col: 2,
      from: 1,
      to: 0,
      aim: { kind: 'ignite', vertical: false, count: 3, breaks: false },
    });
  });

  it('2 手かかる揃いは、1 手目を「仕込み」として出す', () => {
    // 2 列目と 3 列目の丸をどちらも下ろして、はじめて横に揃う
    const g = board([[Kind.Circle], [Kind.Drop, Kind.Circle], [Kind.Drop, Kind.Circle]]);
    const hinter = new Hinter();
    hinter.update(g);
    expect(hinter.arrow(g)?.aim).toEqual({ kind: 'setup', vertical: false, count: 3, left: 2 });
  });

  it('高く積もった列を縦に揃えて低くする手は「崩す」として出す', () => {
    // 11 段の列。三角のほかはどの柄も 2 つまで。下の三角（row 6）を row 8 まで上げれば、上の 2 つと縦に三角が 3 つ並ぶ
    const tall = [
      Kind.Circle, Kind.Drop, Kind.Square, Kind.Hexagon, Kind.Circle, Kind.Drop,
      Kind.Triangle, Kind.Square, Kind.Hexagon, Kind.Triangle, Kind.Triangle,
    ];
    const g = board([[], [], [], [], tall]);
    const hinter = new Hinter();
    hinter.update(g);
    expect(hinter.arrow(g)?.aim).toEqual({ kind: 'ignite', vertical: true, count: 3, breaks: true });
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
