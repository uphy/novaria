import { describe, expect, it } from 'vitest';
import { Game } from '../../src/core/game';
import { Kind } from '../../src/core/types';
import { IGNITION_GRACE_FRAMES, PHYSICS } from '../../src/core/constants';

function meteor(kind: Kind, id = Math.floor(Math.random() * 1e6)) {
  return { id, kind, revert: 0, fromAttack: false, ignitedAt: -1 };
}

function stillGame(columns: Kind[][]): Game {
  const g = new Game({ seed: 3, rareMetal: false });
  for (let c = 0; c < g.cols; c++) g.ground[c] = [];
  columns.forEach((col, c) => col.forEach((k) => g.ground[c].push(meteor(k))));
  return g;
}

function settle(g: Game, extra = 0): void {
  for (let i = 0; i < IGNITION_GRACE_FRAMES + 1 + extra; i++) g.tick();
}

/** 揃いが起きない詰め物。列ごとにずらして縦にも横にも 3 つ続かないようにする */
function filler(count: number, col: number): Kind[] {
  return Array.from({ length: count }, (_, i) => ((i + col) % 2 === 0 ? Kind.Circle : Kind.Drop));
}

/** カタマリが空中にいたフレーム数 */
function airborneFrames(g: Game, limit = 2000): number {
  let frames = 0;
  for (let i = 0; i < limit; i++) {
    g.tick();
    if (g.lumps.length > 0) frames++;
    else if (frames > 0) break;
  }
  return frames;
}

describe('打ち上げたカタマリの滞空', () => {
  // 空中で揃え直す（第二次点火）にも、下から当てて合体させる（空中ドッキング）にも、
  // 指で掴んで動かす間合いが要る。上で止めて待たせるのではなく、
  // 降りてくる速さを落として、落ちながら手を出せる時間を稼いでいる
  it('小さいカタマリは 4 秒以上かけて降りてくる', () => {
    const g = stillGame([0, 1, 2].map((c) => [Kind.Triangle, ...filler(0, c)]));
    settle(g);
    expect(g.lumps.length).toBe(1);
    expect(airborneFrames(g)).toBeGreaterThan(240);
  });

  it('重くてほとんど上がらないカタマリでも 1.5 秒以上浮いている', () => {
    // 9 段積み上げた上での点火。ほとんど上がらないぶん、降りるのが遅いことが効く
    const g = stillGame([0, 1, 2].map((c) => [Kind.Triangle, ...filler(9, c)]));
    settle(g);
    expect(g.lumps.length).toBe(1);
    expect(g.lumps[0].cells.length).toBeGreaterThan(20);
    expect(airborneFrames(g)).toBeGreaterThan(90);
  });

  it('上がりきったあとは止まらず、ずっと下がり続ける', () => {
    const g = stillGame([0, 1, 2].map((c) => [Kind.Triangle, ...filler(2, c)]));
    settle(g);
    const lump = g.lumps[0];

    // 上がりきるまで進める
    for (let i = 0; i < 300 && lump.vy > 0; i++) g.tick();
    let previous = lump.y;
    for (let i = 0; i < 60; i++) {
      g.tick();
      // 1 フレームでも高さが止まらない（上で待たされる時間を作らない）
      expect(lump.y).toBeLessThan(previous);
      previous = lump.y;
    }
  });

  it('降りる速さは、降ってくる隕石よりずっと遅い', () => {
    const g = stillGame([0, 1, 2].map((c) => [Kind.Triangle, ...filler(2, c)]));
    settle(g);
    const lump = g.lumps[0];
    for (let i = 0; i < 400 && lump.vy > -PHYSICS.maxLumpFallSpeed * 0.99; i++) g.tick();
    expect(lump.vy).toBeGreaterThan(-PHYSICS.maxLumpFallSpeed - 1e-9);
    expect(PHYSICS.maxLumpFallSpeed).toBeLessThan(PHYSICS.maxFallSpeed / 5);
  });

  it('加速を押すと速く降りてきて、待たされない', () => {
    const make = (boost: boolean): number => {
      const g = stillGame([0, 1, 2].map((c) => [Kind.Triangle, ...filler(2, c)]));
      settle(g);
      g.boost = boost;
      return airborneFrames(g);
    };
    expect(make(true)).toBeLessThan(make(false));
  });
});

describe('空中のカタマリへの手出し', () => {
  it('浮いているカタマリの中の隕石を掴んで動かせる', () => {
    const g = stillGame([0, 1, 2].map((c) => [Kind.Triangle, ...filler(4, c)]));
    settle(g);
    const lump = g.lumps[0];
    const before = lump.cells
      .filter((c) => c.col === 0)
      .sort((a, b) => a.rel - b.rel)
      .map((c) => c.meteor.kind);

    const bottom = Math.min(...lump.cells.filter((c) => c.col === 0).map((c) => c.rel));
    expect(g.grab(0, Math.floor(lump.y + bottom))).toBe(true);
    expect(g.drag?.kind).toBe('lump');
    g.dragBy(1);

    const after = lump.cells
      .filter((c) => c.col === 0)
      .sort((a, b) => a.rel - b.rel)
      .map((c) => c.meteor.kind);
    expect(after).not.toEqual(before);
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[0]);
  });

  it('下から来たカタマリが触れると、合体して一緒に浮き続ける', () => {
    const g = stillGame([]);
    const mk = (id: number, y: number, vy: number) => ({
      id,
      cells: [{ col: 0, rel: 0, meteor: meteor(Kind.Triangle, id) }],
      y,
      vy,
      thrustFrames: 0,
      thrustAccel: 0,
      combo: 1,
    });
    // ゆっくり降りているカタマリに、下から上がってきたカタマリが追いつく
    g.lumps.push(mk(1, 5, -0.02), mk(2, 3.5, 0.12));

    let docked = false;
    for (let i = 0; i < 60 && !docked; i++) docked = g.tick().airDock > 0;
    expect(docked).toBe(true);
    expect(g.lumps.length).toBe(1);
    expect(g.lumps[0].cells.length).toBe(2);

    // 合体したあとも落ちずに浮いている
    for (let i = 0; i < 40; i++) g.tick();
    expect(g.lumps.length).toBe(1);
  });
});
