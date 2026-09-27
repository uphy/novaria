import { describe, expect, it } from 'vitest';
import { Game } from '../../src/core/game';
import { Kind } from '../../src/core/types';
import { IGNITION_GRACE_FRAMES } from '../../src/core/constants';

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

/**
 * 一番下の段（index 1）に Triangle が 3 つ並ぶと揃う盤面。
 * 列 0 の Triangle は index 3 にあるので、下へ 2 マス運ぶと揃う
 */
function boardWhereDraggingDownMatches(): Game {
  return stillGame([
    [Kind.Circle, Kind.Square, Kind.Pentagon, Kind.Triangle],
    [Kind.Circle, Kind.Triangle, Kind.Square, Kind.Pentagon],
    [Kind.Square, Kind.Triangle, Kind.Pentagon, Kind.Circle],
  ]);
}

/** 揃いが起きない詰め物。列ごとにずらして縦にも横にも 3 つ続かないようにする */
function filler(count: number, col: number): Kind[] {
  return Array.from({ length: count }, (_, i) => ((i + col) % 2 === 0 ? Kind.Circle : Kind.Drop));
}

describe('空中のカタマリを掴む', () => {
  it('マスの真ん中に触れたら、その隕石を掴む（カタマリが小数の高さにいても）', () => {
    const g = stillGame([0, 1, 2].map((c) => [Kind.Triangle, ...filler(2, c)]));
    settle(g);
    expect(g.lumps.length).toBe(1);

    // カタマリは小数の高さを漂う。端数が 0.5 を越えているところで掴む。
    // 端数を切り捨てて行を出すと、ここで指の下にいる隕石と 1 マスずれる
    let lump = g.lumps[0];
    for (let i = 0; i < 600 && lump.y - Math.floor(lump.y) < 0.6; i++) {
      g.tick();
      lump = g.lumps[0];
    }
    expect(lump.y - Math.floor(lump.y)).toBeGreaterThan(0.6);

    const cells = lump.cells.filter((c) => c.col === 0).sort((a, b) => a.rel - b.rel);
    expect(cells.length).toBe(3);
    for (const cell of cells) {
      // 指はマスの真ん中に触れる。マスは世界座標の lump.y + rel から 1 マスぶん
      expect(g.grab(0, lump.y + cell.rel + 0.5)).toBe(true);
      expect(g.dragPosition()?.meteor).toBe(cell.meteor);
      g.release();
    }
  });

  it('上の隕石が宇宙へ消えても、掴んでいる隕石は指から離れない', () => {
    // 高い位置で点火させて、上から順に大気圏を抜けていくカタマリを作る
    const g = stillGame([0, 1, 2].map((c) => [...filler(9, c), Kind.Triangle, ...filler(1, c + 1)]));
    settle(g);
    expect(g.lumps.length).toBe(1);

    const lump = g.lumps[0];
    const bottom = lump.cells.filter((c) => c.col === 0).sort((a, b) => a.rel - b.rel)[0];
    expect(g.grab(0, lump.y + bottom.rel + 0.5)).toBe(true);

    let launched = false;
    for (let i = 0; i < 600; i++) {
      g.tick();
      if (!g.lumps.some((l) => l.cells.some((c) => c.meteor === bottom.meteor))) break;
      // 掴んでいる隕石がカタマリに残っているあいだは、指から離れない
      expect(g.drag).not.toBeNull();
      if (g.launched.normal + g.launched.dust > 0) launched = true;
    }
    expect(launched).toBe(true);
  });
});

describe('なぞっている途中の揃い', () => {
  it('指を速く動かして揃う位置を通り過ぎても、そこで揃ったことにする', () => {
    const g = boardWhereDraggingDownMatches();
    g.tick();
    expect(g.lumps.length).toBe(0);

    expect(g.grab(0, 3)).toBe(true);
    // 1 回の移動で 3 マス下へ。揃う位置（index 1）は途中で、素通りしていた
    g.dragBy(-3);

    // 揃った時点で指から離れ、それ以上は運ばれない
    expect(g.drag).toBeNull();
    expect(g.ground[0][1].kind).toBe(Kind.Triangle);

    settle(g, 10);
    expect(g.score).toBeGreaterThan(0);
    expect(g.lumps.length).toBe(1);
  });

  it('1 マスずつゆっくり動かしたときも同じ位置で止まる', () => {
    const g = boardWhereDraggingDownMatches();
    g.tick();
    g.grab(0, 3);
    for (let i = 0; i < 3; i++) {
      g.dragBy(-1);
      g.tick();
    }
    expect(g.drag).toBeNull();
    expect(g.ground[0][1].kind).toBe(Kind.Triangle);
    settle(g, 10);
    expect(g.score).toBeGreaterThan(0);
  });

  it('揃わない位置は今までどおり通り過ぎられる', () => {
    const g = stillGame([
      [Kind.Circle, Kind.Square, Kind.Pentagon, Kind.Triangle],
      [Kind.Circle, Kind.Pentagon, Kind.Square, Kind.Pentagon],
      [Kind.Square, Kind.Circle, Kind.Pentagon, Kind.Circle],
    ]);
    g.tick();
    g.grab(0, 3);
    g.dragBy(-3);
    // 掴んだまま一番下まで運べる
    expect(g.drag).not.toBeNull();
    expect(g.ground[0][0].kind).toBe(Kind.Triangle);
    settle(g, 10);
    expect(g.score).toBe(0);
  });

  it('空中のカタマリの中でも、揃った位置で止まる', () => {
    // 3 つ揃いの上に 2 段乗せて打ち上げ、空中のカタマリを作る
    const g = stillGame([
      [Kind.Triangle, Kind.Square, Kind.Bolt],
      [Kind.Triangle, Kind.Bolt, Kind.Square],
      [Kind.Triangle, Kind.Square, Kind.Bolt],
    ]);
    settle(g);
    expect(g.lumps.length).toBe(1);
    const lump = g.lumps[0];

    // 点火に使った Triangle は燃えカスになって一緒に上がる。
    // 列 1 だけ Bolt と Square が逆なので、そこを入れ替えると横に揃う
    const colKinds = (col: number) =>
      lump.cells
        .filter((c) => c.col === col)
        .sort((a, b) => a.rel - b.rel)
        .map((c) => c.meteor.kind);
    expect(colKinds(0)).toEqual([Kind.Dust, Kind.Square, Kind.Bolt]);
    expect(colKinds(1)).toEqual([Kind.Dust, Kind.Bolt, Kind.Square]);

    const zap = lump.cells.filter((c) => c.col === 1).sort((a, b) => a.rel - b.rel)[1];
    expect(g.grab(1, lump.y + zap.rel + 0.5)).toBe(true);
    g.dragBy(1);

    expect(g.drag).toBeNull();
    expect(colKinds(1)).toEqual([Kind.Dust, Kind.Square, Kind.Bolt]);
  });
});

describe('両手で運ぶ', () => {
  /** 列 0〜3 に揃いの無い詰め物を積んだ盤面 */
  function quiet(): Game {
    const g = stillGame([0, 1, 2, 3].map((c) => filler(4, c)));
    g.tick();
    return g;
  }

  it('指ごとに別の列を掴み、それぞれの指の動きがその列だけを動かす', () => {
    const g = quiet();
    const col0 = [...g.ground[0]];
    const col3 = [...g.ground[3]];
    expect(g.grab(0, 0, 1)).toBe(true);
    expect(g.grab(3, 3, 2)).toBe(true);

    g.dragBy(1, 1);
    g.dragBy(-1, 2);

    expect(g.ground[0].map((m) => m.id)).toEqual([col0[1], col0[0], col0[2], col0[3]].map((m) => m.id));
    expect(g.ground[3].map((m) => m.id)).toEqual([col3[0], col3[1], col3[3], col3[2]].map((m) => m.id));
  });

  it('別の指が掴んでいる列は掴めない', () => {
    const g = quiet();
    expect(g.grab(1, 0, 1)).toBe(true);
    expect(g.grab(1, 2, 2)).toBe(false);
    expect(g.drags.size).toBe(1);
  });

  it('片方の指を離しても、もう片方は掴んだまま', () => {
    const g = quiet();
    g.grab(0, 0, 1);
    g.grab(3, 0, 2);
    g.release(1);
    expect(g.drags.has(1)).toBe(false);
    expect(g.dragPosition(2)?.col).toBe(3);
  });

  it('片方の手で点火しても、関係のない列を運んでいる手は離さない', () => {
    const g = stillGame([
      [Kind.Circle, Kind.Square, Kind.Pentagon, Kind.Triangle],
      [Kind.Circle, Kind.Triangle, Kind.Square, Kind.Pentagon],
      [Kind.Square, Kind.Triangle, Kind.Pentagon, Kind.Circle],
      [],
      filler(4, 4),
    ]);
    g.tick();
    expect(g.grab(4, 1, 2)).toBe(true);
    const held = g.dragPosition(2)!.meteor;

    g.grab(0, 3, 1);
    g.dragBy(-2, 1);
    settle(g, 10);

    expect(g.score).toBeGreaterThan(0);
    expect(g.dragPosition(2)?.meteor).toBe(held);
    g.dragBy(1, 2);
    expect(g.ground[4][2]).toBe(held);
  });
});

describe('掴んでいるカタマリの形が変わっても指から離れない', () => {
  let nextId = 7000;
  const m = (kind: Kind) => meteor(kind, nextId++);
  /** 空の盤面 */
  function empty(): Game {
    const g = new Game({ seed: 4, rareMetal: false });
    g.ground = g.ground.map(() => []);
    g.fallings = [];
    return g;
  }
  /** 1 フレーム進める。降り始めた隕石は消して、組んだ盤面だけを動かす */
  function step(g: Game) {
    const ev = g.tick();
    g.fallings = [];
    return ev;
  }
  function lump(id: number, cells: [number, number, Kind][], y: number, vy: number) {
    return {
      id,
      cells: cells.map(([col, rel, kind]) => ({ col, rel, meteor: m(kind) })),
      y,
      vy,
      thrustFrames: 0,
      thrustAccel: 0,
      combo: 1,
    };
  }

  it('運んでいるカタマリが着地したら、地面の山で掴んだまま', () => {
    const g = empty();
    g.ground[0] = [m(Kind.Circle)];
    g.lumps = [lump(900, [[0, 0, Kind.Square], [0, 1, Kind.Drop], [1, 0, Kind.Hexagon]], 3, -0.05)];
    expect(g.grab(0, 4.5, 1)).toBe(true);
    const held = g.dragPosition(1)!.meteor;
    for (let i = 0; i < 200 && g.lumps.length > 0; i++) step(g);
    expect(g.lumps.length).toBe(0);

    expect(g.dragPosition(1)?.meteor).toBe(held);
    g.dragBy(-1, 1);
    expect(g.ground[0][1]).toBe(held);
  });

  it('一部の列だけが着地しても、着地した列の隕石を掴んだまま', () => {
    const g = empty();
    g.ground[0] = [m(Kind.Circle), m(Kind.Square)];
    g.lumps = [lump(900, [[0, 0, Kind.Drop], [0, 1, Kind.Hexagon], [1, 0, Kind.Pentagon]], 3, -0.05)];
    expect(g.grab(0, 4.5, 1)).toBe(true);
    const held = g.dragPosition(1)!.meteor;
    for (let i = 0; i < 200 && g.ground[0].length < 4; i++) step(g);
    expect(g.lumps.length).toBe(1);

    expect(g.dragPosition(1)?.meteor).toBe(held);
    g.dragBy(-1, 1);
    expect(g.ground[0][2]).toBe(held);
  });

  it('掴んでいるカタマリがドッキングしても掴んだまま', () => {
    const g = empty();
    g.lumps = [
      lump(900, [[0, 0, Kind.Square], [0, 1, Kind.Drop]], 5, 0),
      lump(901, [[0, 0, Kind.Hexagon], [0, 1, Kind.Circle], [1, 0, Kind.Pentagon]], 3, 0.3),
    ];
    expect(g.grab(0, 3.5, 1)).toBe(true);
    const held = g.dragPosition(1)!.meteor;
    let docked = 0;
    for (let i = 0; i < 30; i++) docked += step(g).airDock;
    expect(docked).toBe(1);

    expect(g.dragPosition(1)?.meteor).toBe(held);
  });

  it('掴んでいるカタマリの別の列で点火しても、掴んだまま', () => {
    const g = empty();
    g.lumps = [
      lump(
        900,
        [
          [0, 0, Kind.Square],
          [0, 1, Kind.Drop],
          [0, 2, Kind.Hexagon],
          [2, 0, Kind.Triangle],
          [2, 1, Kind.Triangle],
          [2, 2, Kind.Circle],
          [2, 3, Kind.Triangle],
        ],
        6,
        0,
      ),
    ];
    expect(g.grab(0, 6.5, 1)).toBe(true);
    const held = g.dragPosition(1)!.meteor;
    // もう片方の手で列 2 の Circle と Triangle を入れ替えて、縦に 3 つ揃える
    expect(g.grab(2, 8.5, 2)).toBe(true);
    g.dragBy(1, 2);
    for (let i = 0; i < IGNITION_GRACE_FRAMES + 1; i++) step(g);
    expect(g.score).toBeGreaterThan(0);

    expect(g.dragPosition(1)?.meteor).toBe(held);
  });
});
