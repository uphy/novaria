import { describe, expect, it } from 'vitest';
import { Game } from '../../src/core/game';
import { Kind } from '../../src/core/types';
import { NOVARIA, IGNITION_GRACE_FRAMES } from '../../src/core/constants';

/** 落下も降下も止めた、点火だけを見るための盤面を作る */
function stillGame(columns: Kind[][]): Game {
  const g = new Game({ seed: 7, rareMetal: false });
  for (let c = 0; c < g.cols; c++) g.ground[c] = [];
  columns.forEach((col, c) => {
    for (const kind of col) g.ground[c].push({ id: c * 100 + g.ground[c].length, kind, revert: 0, fromAttack: false, ignitedAt: -1 });
  });
  return g;
}

/** 揃いから点火までの猶予ぶんだけ進める */
function settle(g: Game, extra = 0): void {
  for (let i = 0; i < IGNITION_GRACE_FRAMES + 1 + extra; i++) g.tick();
}

describe('点火', () => {
  it('横に3つ並ぶと点火して燃えカスになる', () => {
    const g = stillGame([[Kind.Triangle], [Kind.Triangle], [Kind.Triangle]]);
    settle(g);
    expect(g.lumps.length).toBe(1);
    const kinds = g.lumps[0].cells.map((c) => c.meteor.kind);
    expect(kinds).toEqual([Kind.Dust, Kind.Dust, Kind.Dust]);
  });

  it('縦に3つ並ぶと点火する', () => {
    const g = stillGame([[Kind.Drop, Kind.Drop, Kind.Drop]]);
    settle(g);
    expect(g.lumps.length).toBe(1);
    expect(g.lumps[0].cells.length).toBe(3);
  });

  it('2つでは点火しない', () => {
    const g = stillGame([[Kind.Triangle], [Kind.Triangle]]);
    settle(g);
    expect(g.lumps.length).toBe(0);
  });

  it('斜めでは点火しない', () => {
    const g = stillGame([[Kind.Triangle], [Kind.Circle, Kind.Triangle], [Kind.Circle, Kind.Circle, Kind.Triangle]]);
    settle(g);
    expect(g.lumps.length).toBe(0);
  });

  it('燃えカスは点火判定に入らない', () => {
    const g = stillGame([[Kind.Dust], [Kind.Dust], [Kind.Dust]]);
    settle(g);
    expect(g.lumps.length).toBe(0);
  });

  it('点火した隕石の上に乗った隕石ごと持ち上げる', () => {
    const g = stillGame([
      [Kind.Triangle, Kind.Circle],
      [Kind.Triangle, Kind.Circle],
      [Kind.Triangle, Kind.Drop],
    ]);
    settle(g);
    expect(g.lumps[0].cells.length).toBe(6);
    expect(g.ground.every((col) => col.length === 0)).toBe(true);
  });

  it('点火位置より下は持ち上げない', () => {
    const g = stillGame([
      [Kind.Circle, Kind.Triangle],
      [Kind.Circle, Kind.Triangle],
      [Kind.Drop, Kind.Triangle],
    ]);
    settle(g);
    expect(g.lumps[0].cells.length).toBe(3);
    expect(g.ground[0].length).toBe(1);
    expect(g.ground[0][0].kind).toBe(Kind.Circle);
  });

  it('1回の操作で2組そろってもコンボは1のまま', () => {
    const g = stillGame([
      [Kind.Triangle, Kind.Drop],
      [Kind.Triangle, Kind.Drop],
      [Kind.Triangle, Kind.Drop],
    ]);
    settle(g);
    expect(g.lumps.length).toBe(1);
    expect(g.lumps[0].combo).toBe(1);
  });

  it('6個並んでも1回の点火で燃えるのは5個まで', () => {
    const g = stillGame([[Kind.Triangle], [Kind.Triangle], [Kind.Triangle], [Kind.Triangle], [Kind.Triangle], [Kind.Triangle]]);
    settle(g);
    const dust = g.lumps[0].cells.filter((c) => c.meteor.kind === Kind.Dust).length;
    expect(dust).toBe(5);
  });

  it('得点は 100 × 同時点火数 × 連続点火回数', () => {
    const g = stillGame([[Kind.Triangle], [Kind.Triangle], [Kind.Triangle]]);
    settle(g);
    expect(g.score).toBe(100 * 3 * 1);
  });

  it('縦点火のほうが横点火より高く上がる', () => {
    const tate = stillGame([[Kind.Drop, Kind.Drop, Kind.Drop]]);
    const yoko = stillGame([[Kind.Drop], [Kind.Drop], [Kind.Drop]]);
    for (let i = 0; i < 40; i++) {
      tate.tick();
      yoko.tick();
    }
    expect(tate.lumps[0].y).toBeGreaterThan(yoko.lumps[0].y);
  });

  it('1回の点火だけでは画面外まで届かない', () => {
    const g = stillGame([[Kind.Triangle], [Kind.Triangle], [Kind.Triangle]]);
    for (let i = 0; i < 600 && g.lumps.length > 0; i++) g.tick();
    expect(g.launched.dust).toBe(0);
  });
});

describe('惑星', () => {
  it('母星ノヴァリアは9列', () => {
    expect(NOVARIA.cols).toBe(9);
    expect(new Game().cols).toBe(9);
  });
});

describe('打ち上げの届き方', () => {
  // 横にも縦にもそろわない詰め物を作る（3種を列ごとにずらして積む）
  const filler = (col: number, row: number): Kind =>
    [Kind.Circle, Kind.Square, Kind.Pentagon][(row + col) % 3];

  it('山の上のほうで点火した軽いカタマリは大気圏を抜ける', () => {
    const cols: Kind[][] = [];
    for (let c = 0; c < 3; c++) {
      const col: Kind[] = [];
      for (let r = 0; r < 7; r++) col.push(filler(c, r));
      col.push(Kind.Triangle);
      cols.push(col);
    }
    const g = stillGame(cols);
    for (let i = 0; i < 600 && g.launched.dust === 0; i++) g.tick();
    expect(g.launched.dust).toBe(3);
  });

  it('山の下のほうで点火して重いカタマリを持ち上げると届かない', () => {
    const cols: Kind[][] = [];
    for (let c = 0; c < 3; c++) {
      const col: Kind[] = [Kind.Triangle];
      for (let r = 0; r < 7; r++) col.push(filler(c, r));
      cols.push(col);
    }
    const g = stillGame(cols);
    for (let i = 0; i < 300; i++) g.tick();
    expect(g.launched.dust + g.launched.normal).toBe(0);
  });
});
