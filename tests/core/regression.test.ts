import { describe, expect, it } from 'vitest';
import { Game } from '../../src/core/game';
import { Kind } from '../../src/core/types';
import { NOVARIA, GRID_ROWS, IGNITION_GRACE_FRAMES, SCORE, VISIBLE_ROWS } from '../../src/core/constants';

function meteor(kind: Kind, id: number) {
  return { id, kind, revert: 0, fromAttack: false, ignitedAt: -1 };
}

function stillGame(columns: Kind[][]): Game {
  const g = new Game({ seed: 13, rareMetal: false });
  for (let c = 0; c < g.cols; c++) g.ground[c] = [];
  columns.forEach((col, c) => col.forEach((k, i) => g.ground[c].push(meteor(k, c * 100 + i))));
  return g;
}

function settle(g: Game, extra = 0): void {
  for (let i = 0; i < IGNITION_GRACE_FRAMES + 1 + extra; i++) g.tick();
}

/** 見つかったバグを、直したあとも戻らないように固定する */
describe('直したバグ', () => {
  it('空中ドッキングで同じマスに隕石が重ならない', () => {
    const g = stillGame([]);
    const mk = (id: number, kind: Kind, y: number) => ({
      id,
      cells: [{ col: 0, rel: 0, meteor: meteor(kind, id) }],
      y,
      vy: 0.2,
      thrustFrames: 0,
      thrustAccel: 0,
      combo: 1,
    });
    g.lumps.push(mk(1, Kind.Triangle, 6), mk(2, Kind.Drop, 6.4));
    g.tick();
    expect(g.lumps.length).toBe(1);
    const keys = g.lumps[0].cells.map((c) => `${c.col},${c.rel}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('全消しのボーナスは空になっている間に1回だけ入る', () => {
    // 隕石が降ってこない惑星にして、盤面を空のまま保つ
    const g = new Game({ seed: 2, rareMetal: false, planet: { ...NOVARIA, spawnStart: 1e9, spawnMax: 1e9 } });
    for (let i = 0; i < 70; i++) g.tick(); // 全消しの判定が有効になるまで進める
    for (let c = 0; c < g.cols; c++) g.ground[c] = [];
    g.fallings.length = 0;
    const before = g.score;
    let fired = 0;
    for (let i = 0; i < 200; i++) if (g.tick().screenClear) fired++;
    expect(fired).toBe(1);
    expect(g.score - before).toBe(SCORE.screenClearPerCol * g.cols);
  });

  it('段差のある盤面に落ちたカタマリは、触れた列だけ着地する', () => {
    const g = stillGame([
      [Kind.Circle, Kind.Square, Kind.Pentagon, Kind.Circle, Kind.Square], // 高さ5
      [], // 高さ0
    ]);
    g.lumps.push({
      id: 1,
      cells: [
        { col: 0, rel: 0, meteor: meteor(Kind.Bolt, 900) },
        { col: 1, rel: 0, meteor: meteor(Kind.Hexagon, 901) },
      ],
      y: 5,
      vy: -0.05,
      thrustFrames: 0,
      thrustAccel: 0,
      combo: 1,
    });
    g.tick();
    expect(g.ground[0].length).toBe(6); // 触れた列は積まれる
    expect(g.ground[1].length).toBe(0); // 触れていない列は落ち続ける
    expect(g.lumps.length).toBe(1);
  });

  it('点火したマスの上でも、間が空いているカタマリは巻き込まない', () => {
    const g = stillGame([[Kind.Triangle], [Kind.Triangle], [Kind.Triangle]]);
    g.lumps.push({
      id: 99,
      cells: [{ col: 0, rel: 0, meteor: meteor(Kind.Bolt, 910) }],
      y: 8,
      vy: 0.2,
      thrustFrames: 0,
      thrustAccel: 0,
      combo: 1,
    });
    settle(g);
    // 点火でできたカタマリと、離れていたカタマリの 2 つが別々にある
    expect(g.lumps.some((l) => l.cells.some((c) => c.meteor.id === 910) && l.cells.length === 1)).toBe(true);
  });

  it('大気圏より上に積まれた隕石も点火の判定に入る', () => {
    const tall = (c: number): Kind[] => {
      const col: Kind[] = [];
      for (let r = 0; r < VISIBLE_ROWS + 2; r++) col.push([Kind.Circle, Kind.Square, Kind.Pentagon][(r + c) % 3]);
      col.push(Kind.Triangle);
      return col;
    };
    const g = stillGame([tall(0), tall(1), tall(2)]);
    expect(g.ground[0].length).toBeLessThan(GRID_ROWS);
    settle(g);
    expect(g.lumps.length).toBe(1);
  });

  it('滅亡の猶予は仕様どおりの長さになる', () => {
    const col: Kind[] = [];
    for (let r = 0; r < VISIBLE_ROWS; r++) col.push(r % 2 === 0 ? Kind.Triangle : Kind.Circle);
    const g = stillGame([col]);
    let frames = 0;
    while (!g.over && frames < 60 * 10) {
      g.tick();
      frames++;
    }
    // レベル0の猶予は 320 単位 = 約3.33秒
    expect(frames).toBeGreaterThanOrEqual(Math.round((320 / 96) * 60));
    expect(frames).toBeLessThan(Math.round((320 / 96) * 60) + 10);
  });

  it('レアメタルが降ってきた列を掴んでいても、掴み直しにならない', () => {
    const g = new Game({ seed: 4, rareMetal: false });
    g.grab(0, 0);
    expect(g.drag).not.toBeNull();
    // レアメタルの落下を直接起こす
    (g as unknown as { dropRareMetal: (k: Kind) => void }).dropRareMetal(Kind.Spark);
    expect(g.drag).toBeNull();
  });
});
