import { describe, expect, it } from 'vitest';
import { Game } from '../../src/core/game';
import { Kind } from '../../src/core/types';
import {
  IGNITION_GRACE_FRAMES,
  LAUNCH_COMBO_GRACE_FRAMES,
  NOVARIA,
  SCORE,
  PHYSICS,
  SCREEN_OUT_ROW,
  VISIBLE_ROWS,
  WARN_ROWS,
} from '../../src/core/constants';

function meteor(kind: Kind, id = Math.floor(Math.random() * 1e6)) {
  return { id, kind, revert: 0, fromAttack: false, ignitedAt: -1 };
}

function stillGame(columns: Kind[][]): Game {
  const g = new Game({ seed: 3, rareMetal: false });
  for (let c = 0; c < g.cols; c++) g.ground[c] = [];
  columns.forEach((col, c) => col.forEach((k) => g.ground[c].push(meteor(k))));
  return g;
}

/** 揃いから点火までの猶予ぶんだけ進める */
function settle(g: Game, extra = 0): void {
  for (let i = 0; i < IGNITION_GRACE_FRAMES + 1 + extra; i++) g.tick();
}

/** カタマリの中で、同じ列の 2 マスを入れ替える（空中で組み替えたのと同じ状態を作る） */
function swapInLump(lump: { cells: { col: number; rel: number; meteor: unknown }[] }, col: number, a: number, b: number): void {
  const cells = lump.cells.filter((c) => c.col === col);
  const from = cells.find((c) => c.rel === a)!;
  const to = cells.find((c) => c.rel === b)!;
  const tmp = from.meteor;
  from.meteor = to.meteor;
  to.meteor = tmp;
}

describe('第二次点火', () => {
  it('空中のカタマリの中でそろえると再点火してコンボが上がる', () => {
    // 3個そろいの上に、あと1手でそろう並びを乗せる
    const g = stillGame([
      [Kind.Triangle, Kind.Drop, Kind.Circle],
      [Kind.Triangle, Kind.Drop, Kind.Circle],
      [Kind.Triangle, Kind.Circle, Kind.Drop],
    ]);
    settle(g);
    expect(g.lumps.length).toBe(1);
    const lump = g.lumps[0];
    // カタマリの中で列2の上2つを入れ替えると、Drop が横にそろう
    const col2 = lump.cells.filter((c) => c.col === 2).sort((a, b) => a.rel - b.rel);
    const tmp = col2[1].meteor;
    col2[1].meteor = col2[2].meteor;
    col2[2].meteor = tmp;
    settle(g);
    expect(g.maxCombo).toBeGreaterThanOrEqual(2);
    expect(g.lumps.length).toBe(2); // 点火位置より上が分離する
  });

  it('残る隕石とすれ違うなら、カタマリ全体が打ち上がる', () => {
    // 原作の分離条件: 点火で上に動く燃えカス以外の隕石が、カタマリに残る隕石と
    // こすれて上がるなら全体が上がる（原作の分離条件）
    const g = stillGame([
      [Kind.Triangle, Kind.Drop, Kind.Circle],
      [Kind.Triangle, Kind.Drop, Kind.Drop],
      [Kind.Triangle, Kind.Circle, Kind.Drop],
      [Kind.Triangle, Kind.Circle, Kind.Circle],
    ]);
    settle(g);
    expect(g.lumps.length).toBe(1);
    expect(g.lumps[0].cells.length).toBe(12);

    // 列2 の上2つを入れ替えると、列0〜2 の rel1 に Drop がそろう。
    // 列3 は点火に加わらないが、rel2 が動く列（列2 の rel2）の真横に残る
    swapInLump(g.lumps[0], 2, 1, 2);
    settle(g);

    expect(g.maxCombo).toBeGreaterThanOrEqual(2);
    expect(g.lumps.length).toBe(1);
    expect(g.lumps[0].cells.length).toBe(12);
    // 点火に加わらなかった列3 も連れて上がる
    expect(g.lumps[0].cells.some((c) => c.col === 3)).toBe(true);
  });

  it('すれ違わないなら、点火位置より上だけが分かれて上がる', () => {
    const g = stillGame([
      [Kind.Triangle, Kind.Drop, Kind.Circle],
      [Kind.Triangle, Kind.Drop, Kind.Drop],
      [Kind.Triangle, Kind.Circle, Kind.Drop],
    ]);
    settle(g);
    expect(g.lumps.length).toBe(1);

    // カタマリの幅いっぱいで点火する。上がる部分の横には何も残らないので、こすれない
    swapInLump(g.lumps[0], 2, 1, 2);
    settle(g);

    expect(g.lumps.length).toBe(2);
    const sizes = g.lumps.map((l) => l.cells.length).sort((a, b) => a - b);
    expect(sizes).toEqual([3, 6]); // 下に残る燃えカス3個と、上がる6個
  });

  it('連続点火の得点は回数倍になる', () => {
    const g = stillGame([
      [Kind.Triangle, Kind.Drop],
      [Kind.Triangle, Kind.Drop],
      [Kind.Triangle, Kind.Drop],
    ]);
    settle(g); // 1回目: Triangle と Drop が同時にそろう = 同時点火6個 x1
    expect(g.score).toBe(100 * 6 * 1);
  });
});

describe('燃えカス', () => {
  it('着地している燃えカスは時間で通常の隕石に戻る', () => {
    const g = stillGame([[Kind.Dust]]);
    g.ground[0][0].revert = 3;
    g.tick();
    g.tick();
    g.tick();
    expect(g.ground[0][0].kind).not.toBe(Kind.Dust);
  });

  it('空中の燃えカスは還元しない', () => {
    const g = stillGame([[Kind.Triangle], [Kind.Triangle], [Kind.Triangle]]);
    settle(g);
    const dust = g.lumps[0].cells[0].meteor;
    const before = dust.revert;
    for (let i = 0; i < 10; i++) g.tick();
    expect(dust.kind).toBe(Kind.Dust);
    expect(dust.revert).toBe(before);
  });
});

describe('滅亡', () => {
  it('積みきった列は猶予のあとゲームオーバーになる', () => {
    const cols: Kind[][] = [];
    // 点火しないように2種を交互に積む
    const tall: Kind[] = [];
    for (let i = 0; i < VISIBLE_ROWS; i++) tall.push(i % 2 === 0 ? Kind.Triangle : Kind.Circle);
    cols.push(tall);
    const g = stillGame(cols);
    let frames = 0;
    while (!g.over && frames < 60 * 10) {
      g.tick();
      frames++;
    }
    expect(g.over).toBe(true);
    // 猶予はレベル0で約3.3秒
    expect(frames).toBeGreaterThan(60 * 2);
    expect(frames).toBeLessThan(60 * 5);
  });

  it('燃えカスを含む列は滅亡しない', () => {
    const tall: Kind[] = [Kind.Dust];
    for (let i = 0; i < VISIBLE_ROWS; i++) tall.push(i % 2 === 0 ? Kind.Triangle : Kind.Circle);
    const g = stillGame([tall]);
    g.ground[0][0].revert = 99999;
    for (let i = 0; i < 60 * 6; i++) g.tick();
    expect(g.over).toBe(false);
  });
});

/**
 * 滅亡の 1 段手前で出す知らせ。滅亡の決まりは変えず、気づくまでの時間だけを延ばす
 *（docs/decisions.md「ピンチの知らせ方」）
 */
describe('予兆', () => {
  /** 縦に 3 つ続かないよう 2 種を交互に積んだ、n 段の列 */
  const tallOf = (n: number): Kind[] =>
    Array.from({ length: n }, (_, i) => (i % 2 === 0 ? Kind.Triangle : Kind.Circle));

  it('あと 1 段で滅亡する高さになると予兆が立つ。猶予の数え上げはまだ始まらない', () => {
    const g = stillGame([tallOf(WARN_ROWS)]);
    const ev = g.tick();
    expect(g.warnings[0]).toBe(true);
    expect(g.hasWarning()).toBe(true);
    expect(ev.warn).toBe(true);
    expect(ev.danger).toBe(false);
    expect(g.breakTimers[0]).toBe(null);
  });

  it('判定の高さに届くと予兆は消え、猶予の数え上げに変わる', () => {
    const g = stillGame([tallOf(VISIBLE_ROWS)]);
    const ev = g.tick();
    expect(g.warnings[0]).toBe(false);
    expect(ev.warn).toBe(false);
    expect(ev.danger).toBe(true);
    expect(g.breakTimers[0]).toBe(g.breakFrames);
  });

  it('崩せば予兆は消える', () => {
    const g = stillGame([tallOf(WARN_ROWS)]);
    g.tick();
    expect(g.hasWarning()).toBe(true);
    g.ground[0].pop();
    g.tick();
    expect(g.hasWarning()).toBe(false);
  });

  it('燃えカスを含む列には予兆を出さない（その列はいま滅亡しないので）', () => {
    const g = stillGame([[Kind.Dust, ...tallOf(WARN_ROWS - 1)]]);
    g.ground[0][0].revert = 99999;
    g.tick();
    expect(g.ground[0].length).toBe(WARN_ROWS);
    expect(g.warnings[0]).toBe(false);
    expect(g.hasWarning()).toBe(false);
  });
});

/**
 * 連鎖（連続点火）の倍率。得点の 8 割がここで決まるのに、
 * これまで盤面のどこにも出ていなかった（docs/decisions.md「連鎖を見せる」）
 */
describe('連鎖', () => {
  /** 縦に 3 つ続かない詰め物。点火させずに山の高さだけを作る */
  const pad = (n: number): Kind[] =>
    Array.from({ length: n }, (_, i) => (i % 2 === 0 ? Kind.Circle : Kind.Pentagon));

  /** 何も降ってこない盤面。連鎖が切れるまでを、降ってくる隕石に邪魔されずに見る */
  function quietGame(columns: Kind[][]): Game {
    const planet = { ...NOVARIA, spawnStart: 60 * 60 * 10, spawnMax: 60 * 60 * 10 };
    const g = new Game({ seed: 3, rareMetal: false, planet });
    for (let c = 0; c < g.cols; c++) g.ground[c] = [];
    columns.forEach((col, c) => col.forEach((k) => g.ground[c].push(meteor(k))));
    return g;
  }

  /** 開幕に 1 個だけ降るぶんを捨てながら進める */
  function run(g: Game, frames: number, until?: () => boolean): void {
    for (let i = 0; i < frames; i++) {
      g.fallings = [];
      g.tick();
      if (until?.()) return;
    }
  }

  it('点火すると 1 から数え始め、カタマリが浮いているあいだは切れない', () => {
    const g = quietGame([[Kind.Triangle], [Kind.Triangle], [Kind.Triangle]]);
    run(g, IGNITION_GRACE_FRAMES + 2);
    expect(g.combo).toBe(1);
    // 空中にカタマリがあるあいだは連鎖が切れないので、残りは数えない
    expect(g.comboLeft()).toBe(null);
  });

  it('続けて点火すると倍率が上がり、その倍率で得点が入る', () => {
    const g = quietGame([[Kind.Triangle], [Kind.Triangle], [Kind.Triangle]]);
    run(g, IGNITION_GRACE_FRAMES + 2);
    expect(g.score).toBe(300); // 100 × 3 マス × 1
    for (const c of [4, 5, 6]) g.ground[c].push(meteor(Kind.Drop));
    run(g, IGNITION_GRACE_FRAMES + 2);
    expect(g.combo).toBe(2);
    expect(g.score).toBe(300 + 600); // 100 × 3 マス × 2
  });

  it('カタマリが降りたあとは、燃えカスの還元までが連鎖の残りになる', () => {
    const g = quietGame([[Kind.Triangle], [Kind.Triangle], [Kind.Triangle]]);
    run(g, IGNITION_GRACE_FRAMES + 2);
    run(g, 60 * 20, () => g.lumps.length === 0);
    expect(g.lumps.length).toBe(0);
    const left = g.comboLeft();
    expect(left).not.toBe(null);
    expect(left!).toBeGreaterThan(0);
    expect(left!).toBeLessThanOrEqual(g.revertDustFrames);
  });

  it('燃えカスが全部還元されると連鎖は切れる', () => {
    const g = quietGame([[Kind.Triangle], [Kind.Triangle], [Kind.Triangle]]);
    run(g, IGNITION_GRACE_FRAMES + 2);
    run(g, 60 * 30, () => g.combo === 0);
    expect(g.combo).toBe(0);
    expect(g.comboLeft()).toBe(0);
  });

  /**
   * 高いところで横 3 個点火すると、乗っているものごと宇宙へ抜ける。
   * 縦に 3 つ続かず、列をまたいでも 3 つ並ばないよう 1 段ずつずらして積む
   */
  const launcher = (c: number): Kind[] => [
    ...Array.from({ length: 9 }, (_, i) => ((i + c) % 2 === 0 ? Kind.Circle : Kind.Pentagon)),
    Kind.Triangle,
  ];

  it('一気に打ち上げて盤面から燃えカスが消えても、還元ぶんのあいだは連鎖が続く', () => {
    const g = quietGame([launcher(0), launcher(1), launcher(2)]);
    run(g, 60 * 5, () => g.launched.dust > 0 && g.lumps.length === 0);
    // 宇宙へ抜けきって、盤面にも空中にも燃えカスが無い
    expect(g.launched.dust).toBeGreaterThan(0);
    expect(g.lumps.length).toBe(0);
    expect(g.ground.flat().some((m) => m.kind === Kind.Dust)).toBe(false);
    // それでも連鎖は続いている。届かずに落ちてきたときより損をしないように
    expect(g.combo).toBe(1);
    expect(g.comboLeft()!).toBeGreaterThan(0);
  });

  it('打ち上げたあとに点火すると、連鎖が続きとして数えられる', () => {
    const g = quietGame([
      launcher(0),
      launcher(1),
      launcher(2),
      [],
      [Kind.Circle],
      [Kind.Drop],
      [Kind.Square],
    ]);
    run(g, 60 * 5, () => g.launched.dust > 0 && g.lumps.length === 0);
    expect(g.combo).toBe(1);
    for (const c of [4, 5, 6]) g.ground[c].push(meteor(Kind.Triangle));
    run(g, IGNITION_GRACE_FRAMES + 2);
    expect(g.combo).toBe(2);
  });

  it('レベルが最大でも打ち上げの猶予は縮まない（人の手に合わせた固定の長さ）', () => {
    const g = quietGame([launcher(0), launcher(1), launcher(2)]);
    // ゲームレベル最大。地面の燃えカスの還元は 0.63 秒まで縮む
    g.frame = 60 * 150;
    expect(g.revertDustFrames).toBeLessThan(LAUNCH_COMBO_GRACE_FRAMES);
    run(g, 60 * 5, () => g.launched.dust > 0 && g.lumps.length === 0);
    expect(g.comboLeft()!).toBeGreaterThan(g.revertDustFrames);
    expect(g.comboRatio()).toBeGreaterThan(0.9);
  });

  it('打ち上げても、猶予を過ぎれば連鎖は切れる', () => {
    const g = quietGame([launcher(0), launcher(1), launcher(2)]);
    run(g, 60 * 5, () => g.launched.dust > 0 && g.lumps.length === 0);
    run(g, 60 * 10, () => g.combo === 0);
    expect(g.combo).toBe(0);
  });

  /**
   * レアメタルは最下段に居座るので、上まで運んでから下で点火する。
   * 山の高いところで点火するほど持ち上げる隕石が少なく、大気圏まで届く
   */
  describe('レアメタル', () => {
    it('高いところで点火すると、乗せたレアメタルごと宇宙へ出て 10,000 点', () => {
      const g = quietGame([[...pad(7), Kind.Triangle, Kind.Triangle, Kind.Triangle, Kind.Spark]]);
      run(g, 60 * 15, () => g.launched.rare > 0);
      expect(g.launched.rare).toBe(1);
      expect(g.score).toBeGreaterThanOrEqual(SCORE.launchRare);
    });

    it('低いところで点火しても、重くて大気圏まで届かない', () => {
      const g = quietGame([[Kind.Triangle, Kind.Triangle, Kind.Triangle, Kind.Spark]]);
      run(g, 60 * 15);
      expect(g.launched.rare).toBe(0);
      expect(g.ground[0].some((m) => m.kind === Kind.Spark)).toBe(true);
    });
  });
});

describe('操作', () => {
  it('掴んで動かすと同じ列の中で入れ替わる', () => {
    const g = stillGame([[Kind.Triangle, Kind.Circle, Kind.Drop]]);
    expect(g.grab(0, 0)).toBe(true);
    g.dragBy(1);
    expect(g.ground[0].map((m) => m.kind)).toEqual([Kind.Circle, Kind.Triangle, Kind.Drop]);
    g.dragBy(1);
    expect(g.ground[0].map((m) => m.kind)).toEqual([Kind.Circle, Kind.Drop, Kind.Triangle]);
  });

  it('一番下より下へは出せない', () => {
    const g = stillGame([[Kind.Triangle, Kind.Circle]]);
    g.grab(0, 0);
    g.dragBy(-5);
    expect(g.ground[0].map((m) => m.kind)).toEqual([Kind.Triangle, Kind.Circle]);
  });

  it('列の一番上をさらに上へ払うとシュートになる', () => {
    const g = stillGame([[Kind.Triangle, Kind.Circle]]);
    g.grab(0, 1);
    g.dragBy(2);
    expect(g.ground[0].map((m) => m.kind)).toEqual([Kind.Triangle]);
    expect(g.fallings.some((f) => f.shot && f.meteor.kind === Kind.Circle)).toBe(true);
  });

  it('シュートは画面の外へは出ない', () => {
    const g = stillGame([[Kind.Triangle, Kind.Circle]]);
    g.grab(0, 1);
    g.dragBy(2);
    for (let i = 0; i < 300; i++) g.tick();
    expect(g.launched.normal).toBe(0);
  });

  it('シュートが上昇中のカタマリに当たると合体して押し上げる', () => {
    const setup = () => {
      const g = stillGame([[Kind.Triangle], [Kind.Triangle], [Kind.Triangle]]);
      settle(g);
      g.lumps[0].y = 4;
      g.lumps[0].vy = 0.05;
      g.lumps[0].thrustFrames = 0;
      g.ground[0] = [meteor(Kind.Bolt, 701)];
      return g;
    };

    const shot = setup();
    const n = shot.lumps[0].cells.length;
    expect(shot.grab(0, 0)).toBe(true);
    shot.dragBy(2);
    expect(shot.fallings.some((f) => f.shot)).toBe(true);
    let frames = 0;
    while (frames < 40 && shot.lumps.length > 0 && shot.lumps[0].cells.length === n) {
      shot.tick();
      frames++;
    }
    expect(shot.lumps[0].cells.length).toBe(n + 1);

    // 撃たなかった場合と同じフレーム数だけ進め、上向きの速さを比べる
    const control = setup();
    for (let i = 0; i < frames; i++) control.tick();
    expect(shot.lumps[0].vy).toBeGreaterThan(control.lumps[0].vy);
  });

});

describe('通しで動かす', () => {
  it('何も操作しなければいずれ滅亡する', () => {
    const g = new Game({ seed: 11 });
    let frames = 0;
    while (!g.over && frames < 60 * 60 * 5) {
      g.tick();
      frames++;
    }
    expect(g.over).toBe(true);
  });

  it('長く回しても盤面が壊れない', () => {
    const g = new Game({ seed: 5 });
    for (let i = 0; i < 60 * 60 && !g.over; i++) {
      g.tick();
      for (let c = 0; c < g.cols; c++) {
        expect(g.ground[c].length).toBeLessThanOrEqual(SCREEN_OUT_ROW + 4);
        for (const m of g.ground[c]) expect(m).toBeTruthy();
      }
      for (const l of g.lumps) {
        expect(Number.isFinite(l.y)).toBe(true);
        expect(l.vy).toBeLessThanOrEqual(PHYSICS.maxRiseSpeed + 1e-9);
      }
    }
  });

  it('同じ seed なら同じ結果になる', () => {
    const run = () => {
      const g = new Game({ seed: 42 });
      for (let i = 0; i < 2000; i++) g.tick();
      return { score: g.score, launched: g.launched.normal, heights: g.ground.map((c) => c.length) };
    };
    expect(run()).toEqual(run());
  });
});

describe('空中と地面をつなぐ点火', () => {
  it('浮いているカタマリと地面の列が横にそろうと点火する', () => {
    const g = stillGame([
      [Kind.Triangle, Kind.Triangle, Kind.Triangle], // ここが点火して 0 列が浮く
      [Kind.Circle, Kind.Circle, Kind.Drop],
      [Kind.Square, Kind.Pentagon, Kind.Drop],
    ]);
    settle(g);
    expect(g.lumps.length).toBe(1);
    // 浮いた燃えカスの上に残っている隕石は無いので、地面側で Drop を横にそろえる
    const before = g.maxCombo;
    g.ground[1] = [
      { id: 501, kind: Kind.Drop, revert: 0, fromAttack: false, ignitedAt: -1 },
    ];
    g.ground[2] = [
      { id: 502, kind: Kind.Drop, revert: 0, fromAttack: false, ignitedAt: -1 },
    ];
    // 浮いているカタマリを止めて row 0 に合わせる
    g.lumps[0].y = 0;
    g.lumps[0].vy = 0;
    g.lumps[0].thrustFrames = 0;
    g.lumps[0].cells[0].meteor.kind = Kind.Drop;
    settle(g);
    expect(g.maxCombo).toBeGreaterThan(before);
  });
});

describe('連続点火の続き方', () => {
  it('燃えカスが残っているあいだは次の点火が連鎖として数えられる', () => {
    const g = stillGame([
      [Kind.Triangle, Kind.Drop],
      [Kind.Triangle, Kind.Drop],
      [Kind.Triangle, Kind.Circle],
    ]);
    settle(g);
    expect(g.maxCombo).toBe(1);
    // 着地を待ってから、残った燃えカスの隣で Drop をそろえる。
    // カタマリは上がりきったところで留まってから徐々に落ちるので、着地まで 3 秒ほどかかる
    for (let i = 0; i < 400 && g.lumps.length > 0; i++) g.tick();
    const col = g.ground.findIndex((c) => c.some((m) => m.kind === Kind.Dust));
    expect(col).toBeGreaterThanOrEqual(0);
    g.ground[0] = [{ id: 601, kind: Kind.Dust, revert: 9999, fromAttack: false, ignitedAt: -1 }, { id: 602, kind: Kind.Bolt, revert: 0, fromAttack: false, ignitedAt: -1 }];
    g.ground[1] = [{ id: 603, kind: Kind.Dust, revert: 9999, fromAttack: false, ignitedAt: -1 }, { id: 604, kind: Kind.Bolt, revert: 0, fromAttack: false, ignitedAt: -1 }];
    g.ground[2] = [{ id: 605, kind: Kind.Dust, revert: 9999, fromAttack: false, ignitedAt: -1 }, { id: 606, kind: Kind.Bolt, revert: 0, fromAttack: false, ignitedAt: -1 }];
    settle(g);
    expect(g.maxCombo).toBeGreaterThanOrEqual(2);
  });
});

describe('シュートの相殺', () => {
  it('降ってくる同じ柄に当たると両方消えて300点', () => {
    const g = stillGame([[Kind.Triangle, Kind.Circle]]);
    g.fallings.length = 0;
    // 上から Circle が降ってくる状態を作る
    g.fallings.push({ meteor: meteor(Kind.Circle, 801), col: 0, y: 4, vy: 0, shot: false });
    const before = g.score;
    g.grab(0, 1);
    g.dragBy(2); // Circle をシュート
    for (let i = 0; i < 120 && g.score === before; i++) g.tick();
    expect(g.score).toBe(before + 300);
    expect(g.fallings.filter((f) => f.meteor.id === 801).length).toBe(0);
  });
});
