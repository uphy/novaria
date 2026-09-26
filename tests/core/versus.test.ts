import { describe, expect, it } from 'vitest';
import { Game, emptyEvents } from '../../src/core/game';
import { Versus } from '../../src/core/versus';
import { Kind } from '../../src/core/types';
import { ATTACK, IGNITION_GRACE_FRAMES, SCREEN_OUT_ROW } from '../../src/core/constants';

function meteor(kind: Kind, id = Math.floor(Math.random() * 1e6)) {
  return { id, kind, revert: 0, fromAttack: false, ignitedAt: -1 };
}

function stillGame(columns: Kind[][]): Game {
  const g = new Game({ seed: 3, rareMetal: false });
  for (let c = 0; c < g.cols; c++) g.ground[c] = [];
  columns.forEach((col, c) => col.forEach((k) => g.ground[c].push(meteor(k))));
  return g;
}

/** 揃いが起きない詰め物。列ごとにずらして縦にも横にも 3 つ続かないようにする */
function filler(count: number, col: number): Kind[] {
  return Array.from({ length: count }, (_, i) => ((i + col) % 2 === 0 ? Kind.Circle : Kind.Drop));
}

/** 高い位置で点火して、宇宙まで抜ける盤面 */
function boardThatLaunches(): Game {
  return stillGame([0, 1, 2].map((c) => [...filler(9, c), Kind.Triangle, ...filler(1, c + 1)]));
}

/** 打ち上げが起きるまで進める。起きた時点のフレーム数を返す */
function tickUntilLaunched(g: Game, limit = 600): number {
  for (let i = 0; i < limit; i++) {
    g.tick();
    if (g.launched.normal + g.launched.dust > 0) return i;
  }
  throw new Error('打ち上げが起きない');
}

describe('攻撃の隕石', () => {
  it('打ち上げたぶんが溜まり、打ち上げが途切れると送られる', () => {
    const g = boardThatLaunches();
    tickUntilLaunched(g);
    expect(g.pendingAttack).toBeGreaterThan(0);

    // 打ち上げが続いているあいだは溜めたまま
    let sent = 0;
    for (let i = 0; i < ATTACK.sendDelayFrames * 3; i++) {
      sent += g.tick().attackSent;
      if (sent > 0) {
        // 送った時点で、最後の打ち上げから 1 秒は空いている
        expect(i).toBeGreaterThanOrEqual(ATTACK.sendDelayFrames - 1);
        break;
      }
    }
    expect(sent).toBeGreaterThan(0);
    expect(g.pendingAttack).toBe(0);
  });

  it('通常の隕石 3 個の打ち上げで、相手に 3 個降る', () => {
    // 点火した 3 個の上に乗っていた通常の隕石が先に宇宙へ抜ける
    const g = boardThatLaunches();
    for (let i = 0; i < 900 && g.launched.normal < 3; i++) g.tick();
    expect(g.launched).toMatchObject({ normal: 3, dust: 0 });
    expect(g.pendingAttack).toBe(3);
  });

  it('燃えカス 3 個の打ち上げでは 1 個しか降らない（攻撃力が通常の 1/3）', () => {
    // 最上段だけで点火すると、上に乗るものが無いので燃えカスだけが上がる
    const g = stillGame([0, 1, 2].map((c) => [...filler(10, c), Kind.Triangle]));
    for (let i = 0; i < 900 && g.launched.dust < 3; i++) g.tick();
    expect(g.launched).toMatchObject({ normal: 0, dust: 3 });
    expect(g.pendingAttack).toBe(1);
  });

  it('受け取った攻撃は燃えカスとして降り、列がばらける', () => {
    const g = stillGame([]);
    g.receiveAttack(g.cols);
    expect(g.fallings.length).toBe(g.cols);
    expect(g.fallings.every((f) => f.meteor.kind === Kind.Dust && f.meteor.fromAttack)).toBe(true);
    // 9 個なら全部の列に 1 個ずつ入る
    expect(new Set(g.fallings.map((f) => f.col)).size).toBe(g.cols);
    // 画面の上から降ってくる
    expect(g.fallings.every((f) => f.y >= SCREEN_OUT_ROW)).toBe(true);
  });

  it('降った列を Events に書く（相手の盤面のどこに刺さったかを描くため）', () => {
    const g = stillGame([]);
    const ev = emptyEvents();
    g.receiveAttack(3, ev);
    expect(ev.attackColumns.length).toBe(3);
    expect(new Set(ev.attackColumns).size).toBe(3);
    // 列は 9 本ぶんしか無いので、それより多く降っても並ぶのは 9 本まで
    const many = emptyEvents();
    stillGame([]).receiveAttack(20, many);
    expect(many.attackColumns.length).toBe(g.cols);
  });

  it('降ってきた攻撃の隕石は着地して時間が経つと色付きに戻る', () => {
    const g = stillGame([]);
    g.receiveAttack(1);
    const attacked = g.fallings[0].meteor;
    for (let i = 0; i < 60 * 60; i++) {
      g.tick();
      if (attacked.kind !== Kind.Dust) break;
    }
    expect(attacked.kind).not.toBe(Kind.Dust);
    expect(attacked.fromAttack).toBe(false);
  });
});

describe('CPU との対戦', () => {
  it('打ち上げると相手の盤面に燃えカスが降る', () => {
    const v = new Versus({ seed: 5, level: 'easy' });
    // 自分だけ打ち上がる盤面にして、相手には何もさせない
    v.player.ground = boardThatLaunches().ground;
    v.rival.ground = v.rival.ground.map(() => []);

    let taken = 0;
    for (let i = 0; i < 900 && taken === 0; i++) taken += v.tick().rival.attackTaken;
    expect(taken).toBeGreaterThan(0);
    expect(v.rival.fallings.some((f) => f.meteor.fromAttack)).toBe(true);
  });

  it('積みきった側が負ける', () => {
    const win = new Versus({ seed: 5, level: 'easy' });
    expect(win.result).toBeNull();
    win.rival.over = true;
    win.tick();
    expect(win.result).toBe('win');

    const lose = new Versus({ seed: 5, level: 'easy' });
    lose.player.over = true;
    lose.tick();
    expect(lose.result).toBe('lose');
  });

  it('放っておくと、何もしない側が先に積みきって負ける', () => {
    // 相手は CPU が打ち上げ続けるので、指を動かさなければいずれこちらが潰れる。
    // seed は相手が自滅しないものを選ぶ（CPU は盤面しだいで自分から積みきることがある）
    const v = new Versus({ seed: 3, level: 'normal' });
    for (let i = 0; i < 60 * 60 * 5 && v.result === null; i++) v.tick();
    expect(v.result).toBe('lose');
  });

  it('CPU は相手の盤面を自分で動かす', () => {
    const v = new Versus({ seed: 9, level: 'hard' });
    for (let i = 0; i < IGNITION_GRACE_FRAMES + 60 * 30; i++) v.tick();
    expect(v.rival.score).toBeGreaterThan(0);
  });
});
