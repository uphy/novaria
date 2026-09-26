import { describe, expect, it } from 'vitest';
import { NOVARIA } from '../../src/core/constants';
import { Game } from '../../src/core/game';
import { DUUN, MIRKA, TERMINA, TOUR, type Stage } from '../../src/core/planets';
import { Tour } from '../../src/core/tour';
import { Kind, type Lump } from '../../src/core/types';

function meteor(kind: Kind, id = Math.floor(Math.random() * 1e6)) {
  return { id, kind, revert: 0, fromAttack: false, ignitedAt: -1 };
}

/** 揃いが起きない詰め物。列ごとにずらして縦にも横にも 3 つ続かないようにする */
function filler(count: number, col: number): Kind[] {
  return Array.from({ length: count }, (_, i) => ((i + col) % 2 === 0 ? Kind.Circle : Kind.Drop));
}

/** 高い位置で点火して、宇宙まで抜ける盤面を盤面に置く */
function loadLaunchingBoard(game: Game): void {
  for (let c = 0; c < game.cols; c++) game.ground[c] = [];
  [0, 1, 2].forEach((c) => {
    for (const k of [...filler(9, c), Kind.Triangle, ...filler(1, c + 1)]) {
      game.ground[c].push(meteor(k));
    }
  });
}

/** 打ち上げて惑星を抜けるまで進める */
function escape(t: Tour, limit = 1200): void {
  loadLaunchingBoard(t.game);
  for (let i = 0; i < limit && !t.escaped; i++) t.tick();
  if (!t.escaped) throw new Error('脱出できない');
}

/** 目標 1 個だけの短い道のり。脱出と乗り継ぎだけを見る */
const SHORT: Stage[] = [
  { planet: NOVARIA, goal: 1, note: '' },
  { planet: MIRKA, goal: 1, note: '' },
];

describe('惑星めぐり', () => {
  it('母星から始まり、打ち上げが目標に届くと惑星を抜ける', () => {
    const t = new Tour({ seed: 4, stages: SHORT, rareMetal: false });
    expect(t.index).toBe(0);
    expect(t.stage.planet).toBe(NOVARIA);
    expect(t.escaped).toBe(false);

    escape(t);
    expect(t.launched).toBeGreaterThanOrEqual(t.stage.goal);
    expect(t.progress).toBe(1);
    expect(t.completed).toBe(false);
  });

  it('次の惑星へ進むと盤面は組み直され、得点と打ち上げ数は持ち越す', () => {
    const t = new Tour({ seed: 4, stages: SHORT, rareMetal: false });
    escape(t);
    const score = t.score;
    const launched = t.totalLaunched;
    const frames = t.frames;
    expect(score).toBeGreaterThan(0);

    t.advance();
    expect(t.index).toBe(1);
    expect(t.stage.planet).toBe(MIRKA);
    expect(t.game.planet).toBe(MIRKA);
    // 新しい惑星の盤面は最初から
    expect(t.game.frame).toBe(0);
    expect(t.game.score).toBe(0);
    expect(t.escaped).toBe(false);
    // 道のり全体の合計は引き継ぐ
    expect(t.score).toBe(score);
    expect(t.totalLaunched).toBe(launched);
    expect(t.frames).toBe(frames);
  });

  it('最後の惑星を抜けると完走になり、それ以上は進まない', () => {
    const t = new Tour({ seed: 4, stages: SHORT, rareMetal: false });
    escape(t);
    t.advance();
    escape(t);
    expect(t.completed).toBe(true);

    t.advance();
    expect(t.index).toBe(1);
    expect(t.stage.planet).toBe(MIRKA);
  });

  it('脱出したあとに積みきっても、抜けたほうを取る', () => {
    const t = new Tour({ seed: 4, stages: SHORT, rareMetal: false });
    escape(t);
    // 脱出から画面を出すまでのあいだも盤面は動く。そこで潰れても道のりは続く
    t.game.over = true;
    expect(t.over).toBe(false);

    t.advance();
    t.game.over = true;
    expect(t.over).toBe(true);
  });

  it('道のりは母星から始まり、脱出に要る数は先へ行くほど増える', () => {
    expect(TOUR[0].planet).toBe(NOVARIA);
    expect(TOUR.length).toBeGreaterThan(1);
    // 惑星の id は色（PLANET_LOOKS）を引く鍵なので、重複させない
    expect(new Set(TOUR.map((s) => s.planet.name)).size).toBe(TOUR.length);
    expect(TOUR.every((s) => s.goal > 0)).toBe(true);
    expect(TOUR[TOUR.length - 1].goal).toBeGreaterThan(TOUR[0].goal);
  });
});

describe('惑星ごとの違い', () => {
  /** 空から何も降ってこない盤面で、浮いているカタマリを 1 つだけ置く */
  function floating(planet: typeof NOVARIA): { game: Game; lump: Lump } {
    const game = new Game({
      seed: 1,
      rareMetal: false,
      planet: { ...planet, spawnStart: 1e9, spawnMax: 1e9 },
    });
    for (let c = 0; c < game.cols; c++) game.ground[c] = [];
    const lump: Lump = {
      id: 1,
      cells: [{ col: 0, rel: 0, meteor: meteor(Kind.Circle) }],
      y: 8,
      vy: 0,
      thrustFrames: 0,
      thrustAccel: 0,
      combo: 0,
    };
    game.lumps.push(lump);
    return { game, lump };
  }

  it('重力の強い惑星では、浮いたカタマリが速く落ちてくる', () => {
    const light = floating(MIRKA);
    const home = floating(NOVARIA);
    const heavy = floating(DUUN);
    for (let i = 0; i < 60; i++) {
      light.game.tick();
      home.game.tick();
      heavy.game.tick();
    }
    expect(heavy.lump.y).toBeLessThan(home.lump.y);
    expect(home.lump.y).toBeLessThan(light.lump.y);
  });

  it('惑星ごとに降るレアメタルが変わる', () => {
    // 降る間隔を長くしておくと、最初の 1 個がレアメタルになる
    const fall = (planet: typeof NOVARIA): Kind => {
      const g = new Game({ seed: 1, planet: { ...planet, spawnStart: 1e9, spawnMax: 1e9 } });
      const ev = g.tick();
      expect(ev.rareMetal).not.toBeNull();
      return g.ground[ev.rareMetal as number][0].kind;
    };
    expect(fall(NOVARIA)).toBe(Kind.Spark);
    expect(fall(TERMINA)).toBe(Kind.Ring);
  });
});
