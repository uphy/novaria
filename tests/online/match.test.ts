/**
 * オンライン対戦を 2 人ぶん、1 つのプロセスの中で回す。
 * 回線は偽物（`Wire`）で、片方が送った文字列をその場で相手に渡す。
 * Worker がやるのも中身を見ずに流すことだけなので、これで本番と同じ道筋になる。
 */
import { describe, expect, it } from 'vitest';
import { Game } from '../../src/core/game';
import { Kind } from '../../src/core/types';
import { DRAW_WINDOW_FRAMES, OnlineMatch, RESOLVE_GRACE_FRAMES, type MatchSocket } from '../../src/online/match';

/** 偽の回線。相手が切れたときは Worker と同じように `left` を流してから閉じる */
class Wire implements MatchSocket {
  onMessage: ((text: string) => void) | null = null;
  onClose: (() => void) | null = null;
  peer: Wire | null = null;
  closed = false;
  /** 送ったものを溜めておく。何を送ったかを見るテストで使う */
  readonly sent: string[] = [];

  send(text: string): void {
    if (this.closed) return;
    this.sent.push(text);
    this.peer?.deliver(text);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.peer?.deliver('{"t":"left"}');
  }

  deliver(text: string): void {
    if (!this.closed) this.onMessage?.(text);
  }
}

function meteor(kind: Kind, id = Math.floor(Math.random() * 1e6)) {
  return { id, kind, revert: 0, fromAttack: false, ignitedAt: -1 };
}

/** 揃いが起きない詰め物。列ごとにずらして縦にも横にも 3 つ続かないようにする */
function filler(count: number, col: number): Kind[] {
  return Array.from({ length: count }, (_, i) => ((i + col) % 2 === 0 ? Kind.Circle : Kind.Drop));
}

/** 高い位置で点火して、宇宙まで抜ける盤面に置き換える */
function loadLaunchingBoard(game: Game): void {
  game.ground = game.ground.map((_, col) =>
    col < 3 ? [...filler(9, col), Kind.Triangle, ...filler(1, col + 1)].map((k) => meteor(k)) : [],
  );
  game.lumps = [];
  game.fallings = [];
}

/** 2 人つないで、Worker と同じように同じ seed の start を配る */
function connect(): { a: OnlineMatch; b: OnlineMatch; wa: Wire; wb: Wire } {
  const wa = new Wire();
  const wb = new Wire();
  wa.peer = wb;
  wb.peer = wa;
  const a = new OnlineMatch(wa, () => {});
  const b = new OnlineMatch(wb, () => {});
  wa.deliver(JSON.stringify({ t: 'start', seed: 12345, name: 'びー' }));
  wb.deliver(JSON.stringify({ t: 'start', seed: 12345, name: 'えー' }));
  return { a, b, wa, wb };
}

/** 2 人ぶんを同じフレーム数だけ進める */
function tick(a: OnlineMatch, b: OnlineMatch, count: number): void {
  for (let i = 0; i < count; i++) {
    a.tick();
    b.tick();
  }
}

describe('オンライン対戦', () => {
  it('相手が見つかると、両方に同じ盤面と相手の名前が入る', () => {
    const { a, b } = connect();
    expect(a.phase).toBe('playing');
    expect(a.rivalName).toBe('びー');
    expect(b.rivalName).toBe('えー');
    // 同じ seed なので、降ってくる隕石の順番も初期配置も同じになる
    const kinds = (m: OnlineMatch) => m.game!.ground.map((col) => col.map((x) => x.kind));
    expect(kinds(a)).toEqual(kinds(b));
    tick(a, b, 300);
    expect(kinds(a)).toEqual(kinds(b));
  });

  it('打ち上げると、相手の惑星に燃えカスが降る', () => {
    const { a, b } = connect();
    loadLaunchingBoard(a.game!);
    b.game!.ground = b.game!.ground.map(() => []);

    let taken = 0;
    for (let i = 0; i < 900 && !b.game!.fallings.some((f) => f.meteor.fromAttack); i++) {
      a.tick();
      taken += b.tick().attackTaken;
    }
    const dropped = b.game!.fallings.filter((f) => f.meteor.fromAttack).length;
    expect(dropped).toBeGreaterThan(0);
    // 降った数と、演出に渡す数が食い違わない（二重に数えていない）
    expect(taken).toBe(dropped);
  });

  it('相手の盤面が届いて、ミニ盤面に描ける形になる', () => {
    const { a, b } = connect();
    b.game!.ground = b.game!.ground.map(() => []);
    b.game!.ground[2] = [meteor(Kind.Hexagon)];
    tick(a, b, 12);

    expect(a.rival).not.toBeNull();
    expect(a.rival!.cols).toBe(b.game!.cols);
    expect([...a.rival!.allCells()]).toContainEqual({
      col: 2,
      row: 0,
      meteor: { kind: Kind.Hexagon },
    });
  });

  it('先に滅亡したほうが負け、もう片方が勝ち', () => {
    const { a, b } = connect();
    tick(a, b, 10);
    a.game!.over = true;
    tick(a, b, RESOLVE_GRACE_FRAMES + 1);
    expect(a.result).toBe('lose');
    expect(b.result).toBe('win');
  });

  it('ほぼ同時に滅亡したら相打ち', () => {
    const { a, b } = connect();
    tick(a, b, 10);
    a.game!.over = true;
    b.game!.over = true;
    tick(a, b, RESOLVE_GRACE_FRAMES + 1);
    expect(a.result).toBe('draw');
    expect(b.result).toBe('draw');
  });

  it('相打ちの幅を過ぎてから潰れたら、勝ち負けが付く', () => {
    const { a, b } = connect();
    tick(a, b, 10);
    a.game!.over = true;
    tick(a, b, DRAW_WINDOW_FRAMES + 5);
    b.game!.over = true;
    tick(a, b, RESOLVE_GRACE_FRAMES + 1);
    expect(a.result).toBe('lose');
    expect(b.result).toBe('win');
  });

  it('やめると負けになり、相手には勝ちが出る', () => {
    const { a, b } = connect();
    tick(a, b, 10);
    a.resign();
    tick(a, b, RESOLVE_GRACE_FRAMES + 1);
    expect(a.result).toBe('lose');
    expect(b.result).toBe('win');
  });

  it('相手の接続が切れたら中断になる', () => {
    const { a, b, wb } = connect();
    tick(a, b, 10);
    wb.close();
    expect(a.result).toBe('left');
    expect(a.phase).toBe('ended');
  });

  it('決着したあとは、相手が抜けても結果が書き換わらない', () => {
    const { a, b, wb } = connect();
    tick(a, b, 10);
    b.game!.over = true;
    tick(a, b, DRAW_WINDOW_FRAMES + 2);
    expect(a.result).toBe('win');
    wb.close();
    expect(a.result).toBe('win');
  });

  it('壊れた中身を送りつけられても、盤面は壊れない', () => {
    const { a, b, wa } = connect();
    tick(a, b, 10);
    const before = a.game!.frame;
    wa.deliver('{"t":"attack","n":"たくさん"}');
    wa.deliver('こわれている');
    a.tick();
    expect(a.game!.frame).toBe(before + 1);
    expect(a.game!.fallings.some((f) => f.meteor.fromAttack)).toBe(false);
  });
});
