import { describe, expect, it } from 'vitest';
import { Game } from '../../src/core/game';
import { Kind } from '../../src/core/types';
import { SHOOT_CHARGE_ROWS } from '../../src/core/constants';

function meteor(kind: Kind, id = Math.floor(Math.random() * 1e6)) {
  return { id, kind, revert: 0, fromAttack: false, ignitedAt: -1 };
}

/** 揃いの起きない静かな盤面。列ごとにずらして縦にも横にも 3 つ続かないようにする */
function quietGame(rows: number): Game {
  const g = new Game({ seed: 5, rareMetal: false });
  for (let c = 0; c < g.cols; c++) {
    g.ground[c] = Array.from({ length: rows }, (_, i) =>
      meteor((i + c) % 2 === 0 ? Kind.Circle : Kind.Drop),
    );
  }
  return g;
}

/**
 * 指の操作は tick と tick のあいだに来る。
 * `Events` を tick の頭で作り直していたころ、その操作はもう読み終わった前のフレームの
 * `Events` に入り、呼び出し側には 0 のまま届いていた
 */
describe('tick と tick のあいだの操作が次の tick で届く', () => {
  it('列の一番上を上へ払ったシュートが shot に入る', () => {
    const g = quietGame(3);
    g.tick();
    expect(g.grab(0, 2)).toBe(true);
    g.dragBy(0.5 + SHOOT_CHARGE_ROWS);
    expect(g.tick().shot).toBe(1);
  });

  it('1 マス動かすごとに moves に入る（動かしたあとの添字と向き）', () => {
    const g = quietGame(4);
    g.tick();
    expect(g.grab(0, 1)).toBe(true);
    g.dragBy(1);
    g.dragBy(-1);
    const ev = g.tick();
    expect(ev.moves).toEqual([
      { kind: 'ground', row: 2, up: true, finger: 0 },
      { kind: 'ground', row: 1, up: false, finger: 0 },
    ]);
  });

  it('なぞる途中で揃って指から離れたら locked が立つ', () => {
    const g = new Game({ seed: 5, rareMetal: false });
    for (let c = 0; c < g.cols; c++) g.ground[c] = [];
    // 一番下に Triangle が 3 つ並ぶ。列 0 の Triangle を 1 マス下ろすと揃う
    g.ground[0] = [meteor(Kind.Circle), meteor(Kind.Triangle)];
    g.ground[1] = [meteor(Kind.Triangle), meteor(Kind.Circle)];
    g.ground[2] = [meteor(Kind.Triangle), meteor(Kind.Circle)];
    g.tick();
    expect(g.grab(0, 1)).toBe(true);
    g.dragBy(-1);
    const ev = g.tick();
    expect(ev.locked).toBe(true);
    expect(g.drag).toBeNull();
  });
});
