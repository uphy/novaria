import { describe, expect, it } from 'vitest';
import { Game } from '../../src/core/game';
import { Kind } from '../../src/core/types';
import { decodeBoard, encodeBoard, normalizeCode, parseMessage, validCode } from '../../src/online/protocol';

function meteor(kind: Kind, id = Math.floor(Math.random() * 1e6)) {
  return { id, kind, revert: 0, fromAttack: false, ignitedAt: -1 };
}

describe('盤面の詰め方', () => {
  it('地面と空中を詰めて戻すと、同じ場所に同じ種類が並ぶ', () => {
    const game = new Game({ seed: 3, rareMetal: false });
    game.ground = game.ground.map(() => []);
    game.ground[0] = [meteor(Kind.Triangle), meteor(Kind.Drop)];
    game.ground[8] = [meteor(Kind.Spark)];
    game.lumps = [
      { id: 1, cells: [{ col: 4, rel: 0, meteor: meteor(Kind.Bolt) }], y: 6.25, vy: 0, thrustFrames: 0, thrustAccel: 0, combo: 1 },
    ];

    const board = decodeBoard(encodeBoard(game));
    const cells = [...board.allCells()];
    expect(board.cols).toBe(game.cols);
    expect(cells).toContainEqual({ col: 0, row: 0, meteor: { kind: Kind.Triangle } });
    expect(cells).toContainEqual({ col: 0, row: 1, meteor: { kind: Kind.Drop } });
    expect(cells).toContainEqual({ col: 8, row: 0, meteor: { kind: Kind.Spark } });
    // 空中は 1/4 マスまで丸めて送る
    expect(cells).toContainEqual({ col: 4, row: 6.25, meteor: { kind: Kind.Bolt } });
    // 地面のいちばん高い列の段数。空中のカタマリは数えない（結果の画面の「あと何段」に使う）
    expect(board.peak()).toBe(2);
    expect(game.peak()).toBe(2);
  });

  it('滅亡の近さも送る。相手の枠を赤く点滅させるのに使う', () => {
    const game = new Game({ seed: 3, rareMetal: false });
    const board = decodeBoard(encodeBoard(game));
    expect(board.dangerRatio()).toBe(0);
    expect(board.frame).toBe(game.frame);
  });

  it('盤面 1 枚は 1KB に収まる。1 秒に 10 枚送っても細い電波で足りる', () => {
    const game = new Game({ seed: 3 });
    for (let i = 0; i < 60 * 60; i++) game.tick();
    expect(JSON.stringify(encodeBoard(game)).length).toBeLessThan(1024);
  });
});

describe('届いた中身の読み直し', () => {
  it('知っている形だけを通す', () => {
    expect(parseMessage('{"t":"attack","n":3}')).toEqual({ t: 'attack', n: 3 });
    expect(parseMessage('{"t":"over","f":120}')).toEqual({ t: 'over', f: 120 });
    expect(parseMessage('{"t":"start","seed":7,"name":"あいて"}')).toEqual({
      t: 'start',
      seed: 7,
      name: 'あいて',
    });
  });

  it('壊れた中身は捨てる', () => {
    expect(parseMessage('これは JSON ではない')).toBeNull();
    expect(parseMessage('{"t":"attack"}')).toBeNull();
    // 攻撃の数は上限を超えられない
    expect(parseMessage('{"t":"attack","n":99999}')).toBeNull();
    expect(parseMessage('{"t":"attack","n":-3}')).toBeNull();
    expect(parseMessage('{"t":"しらない"}')).toBeNull();
    // 知らない種類の隕石や、桁の合わない空中のマスも通さない
    expect(parseMessage('{"t":"board","g":["zzz"],"a":[],"d":0,"f":0}')).toBeNull();
    expect(parseMessage('{"t":"board","g":[],"a":[1,2],"d":0,"f":0}')).toBeNull();
  });
});

describe('あいことば', () => {
  it('前後の空白と大文字小文字の違いを吸収する', () => {
    expect(normalizeCode('  ABC でんわ ')).toBe('abc でんわ');
    expect(validCode('abc')).toBe(true);
    expect(validCode('ABC')).toBe(false);
    expect(validCode('')).toBe(false);
    expect(validCode(' a')).toBe(false);
  });

  it('長すぎるぶんは切る', () => {
    expect(normalizeCode('あ'.repeat(30))).toHaveLength(16);
  });
});
