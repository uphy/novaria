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
      tier: 'attack',
      policy: 'build',
      seconds: null,
      combo: 0,
      comboLeft: 0,
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
    // 11 段の列。三角のほかはどの柄も 2 つまで。下の三角（row 7）を 1 つ上げれば、上の 2 つと縦に三角が 3 つ並ぶ
    const tall = [
      Kind.Circle, Kind.Drop, Kind.Square, Kind.Hexagon, Kind.Circle, Kind.Drop,
      Kind.Square, Kind.Triangle, Kind.Hexagon, Kind.Triangle, Kind.Triangle,
    ];
    const g = board([[], [], [], [], tall]);
    const hinter = new Hinter();
    hinter.update(g);
    expect(hinter.arrow(g)?.aim).toEqual({ kind: 'ignite', vertical: true, count: 3, breaks: true });
  });

  it('2 手の仕込みは、1 手目を打つと同じ手順の 2 手目を出す', () => {
    const g = board([[Kind.Circle], [Kind.Drop, Kind.Circle], [Kind.Drop, Kind.Circle]]);
    const hinter = new Hinter();
    hinter.update(g);
    const first = hinter.arrow(g)!;
    g.grab(first.col, first.from);
    g.dragBy(first.to - first.from);
    g.release();
    for (let i = 0; i < 12; i++) hinter.update(g);
    const second = hinter.arrow(g)!;
    expect(second.col).not.toBe(first.col);
    expect([1, 2]).toContain(second.col);
    expect(second).toMatchObject({ from: 1, to: 0 });
  });

  it('ほかの列に隕石が積もって別の手が良くなっても、揃うあいだは手本を替えない', () => {
    const g = oneMoveAway();
    const hinter = new Hinter();
    hinter.update(g);
    const before = hinter.arrow(g);
    // 右の 3 列に、1 手で 4 つ揃う形を後から置く
    g.ground[5] = [{ id: nextId++, kind: Kind.Square, revert: 0, fromAttack: false, ignitedAt: -1 }];
    g.ground[6] = [{ id: nextId++, kind: Kind.Square, revert: 0, fromAttack: false, ignitedAt: -1 }];
    g.ground[7] = [{ id: nextId++, kind: Kind.Square, revert: 0, fromAttack: false, ignitedAt: -1 }];
    g.ground[8] = [
      { id: nextId++, kind: Kind.Drop, revert: 0, fromAttack: false, ignitedAt: -1 },
      { id: nextId++, kind: Kind.Square, revert: 0, fromAttack: false, ignitedAt: -1 },
    ];
    for (let i = 0; i < 120; i++) hinter.update(g);
    expect(hinter.arrow(g)).toEqual(before);
  });

  it('揃える相手が動かされて揃わなくなったら、手本を替える', () => {
    const g = oneMoveAway();
    const hinter = new Hinter();
    hinter.update(g);
    // 2 列目の丸を水滴に替える。3 列目の丸を下ろしても揃わない
    g.ground[1][0].kind = Kind.Drop;
    expect(hinter.arrow(g)).toBeNull();
  });

  it('レベルが上がって高い列が間に合わなくなると、攻めの手本を守りに替える', () => {
    // 左の 3 列には攻めの手。5 列目は 10 段で、下の三角を 1 つ上げれば縦に揃って崩れる。
    // 開始直後なら 1 列に 1 個降るのは 12 秒に 1 度なので、まだ攻めでいい
    const tall = [
      Kind.Circle, Kind.Drop, Kind.Square, Kind.Hexagon, Kind.Circle,
      Kind.Drop, Kind.Triangle, Kind.Square, Kind.Triangle, Kind.Triangle,
    ];
    const g = board([[Kind.Circle], [Kind.Circle], [Kind.Drop, Kind.Circle], [], tall]);
    const hinter = new Hinter();
    hinter.update(g);
    expect(hinter.arrow(g)?.tier).toBe('attack');
    // レベルを最大にすると、1 列に 1 個降る間隔が 4 分の 1 になる
    g.frame = 60 * 60 * 30;
    for (let i = 0; i < 12; i++) hinter.update(g);
    const arrow = hinter.arrow(g)!;
    expect(arrow.col).toBe(4);
    expect(['guard', 'urgent']).toContain(arrow.tier);
    expect(arrow.seconds).toBeGreaterThan(0);
  });

  it('まだ間に合う守りでは、一番上を上へ払う手を出さない', () => {
    // 10 段で、どの柄も 2 つまで。崩す手が無い
    const kinds = [Kind.Circle, Kind.Drop, Kind.Square, Kind.Hexagon, Kind.Pentagon];
    const g = board([[], [], [], [], [...kinds, ...kinds]]);
    g.frame = 60 * 60 * 30;
    const hinter = new Hinter();
    for (let i = 0; i < 12; i++) hinter.update(g);
    expect(hinter.arrow(g)?.aim.kind).not.toBe('shoot');
  });

  it('守っている列より早く滅亡しそうな列が出たら、赤くなるのを待たずにそちらへ乗り換える', () => {
    // 2 列目は 10 段、7 列目は 8 段。どちらも三角を 1 つ上げれば縦に揃って崩れる
    const column = (filler: Kind[]) => [...filler, Kind.Triangle, Kind.Square, Kind.Triangle, Kind.Triangle];
    const g = board([
      [],
      column([Kind.Circle, Kind.Drop, Kind.Hexagon, Kind.Circle, Kind.Drop, Kind.Hexagon]),
      [],
      [],
      [],
      [],
      column([Kind.Circle, Kind.Drop, Kind.Hexagon, Kind.Pentagon]),
    ]);
    g.frame = 60 * 60 * 30;
    const hinter = new Hinter();
    for (let i = 0; i < 12; i++) hinter.update(g);
    expect(hinter.arrow(g)).toMatchObject({ col: 1, tier: 'guard' });
    // 7 列目の上に 3 つ積もって 11 段になる。2 列目より 1 段高い
    for (const kind of [Kind.Pentagon, Kind.Hexagon, Kind.Circle]) {
      g.ground[6].push({ id: nextId++, kind, revert: 0, fromAttack: false, ignitedAt: -1 });
    }
    for (let i = 0; i < 12; i++) hinter.update(g);
    expect(hinter.arrow(g)).toMatchObject({ col: 6, tier: 'guard' });
  });

  it('滅亡まで数えている列を崩す手が無ければ、一番上を上へ払う手を出す', () => {
    // 12 段で、どの柄も 2 つまで。揃える手が無い
    const kinds = [Kind.Circle, Kind.Drop, Kind.Square, Kind.Hexagon, Kind.Pentagon, Kind.Triangle];
    const g = board([[], [], [], [], [...kinds, ...kinds]]);
    g.breakTimers[4] = 90;
    const hinter = new Hinter();
    hinter.update(g);
    expect(hinter.arrow(g)).toMatchObject({ col: 4, from: 11, aim: { kind: 'shoot' }, tier: 'urgent' });
  });

  it('連鎖が続いていて、切れるまでに打ち切れる手があれば「連鎖をつなぐ」方針にする', () => {
    const g = oneMoveAway();
    // 連鎖の途中にする。打ち上げたあと 200 フレームは切れない
    const inner = g as unknown as { chainCombo: number; comboGrace: number };
    inner.chainCombo = 3;
    inner.comboGrace = 200;
    const hinter = new Hinter();
    hinter.update(g);
    expect(hinter.arrow(g)).toMatchObject({ col: 2, policy: 'chain', combo: 3 });
    expect(hinter.arrow(g)!.comboLeft).toBeCloseTo(200 / 60, 1);
  });

  it('連鎖が切れるまでに人の手では打ち切れないなら、連鎖はあきらめて大きく揃える方針にする', () => {
    const g = oneMoveAway();
    const inner = g as unknown as { chainCombo: number; comboGrace: number };
    inner.chainCombo = 3;
    // 気づいて 1 手運ぶだけで 100 フレームかかる
    inner.comboGrace = 60;
    const hinter = new Hinter();
    hinter.update(g);
    expect(hinter.arrow(g)?.policy).toBe('build');
  });

  it('浮いているカタマリに、人の手で打っても下から当てられるなら「ドッキングを狙う」方針にする', () => {
    const g = oneMoveAway();
    g.lumps = [
      {
        id: 777,
        cells: [
          { col: 1, rel: 0, meteor: { id: nextId++, kind: Kind.Triangle, revert: 0, fromAttack: false, ignitedAt: -1 } },
          { col: 1, rel: 1, meteor: { id: nextId++, kind: Kind.Pentagon, revert: 0, fromAttack: false, ignitedAt: -1 } },
        ],
        y: 6,
        vy: 0,
        thrustFrames: 0,
        thrustAccel: 0,
        combo: 1,
      },
    ];
    const hinter = new Hinter();
    hinter.update(g);
    expect(hinter.arrow(g)).toMatchObject({ col: 2, policy: 'dock' });
  });

  it('カタマリが高すぎて下から届かないなら、ドッキングは狙わない', () => {
    const g = oneMoveAway();
    g.lumps = [
      {
        id: 778,
        cells: [{ col: 1, rel: 0, meteor: { id: nextId++, kind: Kind.Triangle, revert: 0, fromAttack: false, ignitedAt: -1 } }],
        y: 13,
        vy: 0,
        thrustFrames: 0,
        thrustAccel: 0,
        combo: 1,
      },
    ];
    const hinter = new Hinter();
    hinter.update(g);
    expect(hinter.arrow(g)?.policy).not.toBe('dock');
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
