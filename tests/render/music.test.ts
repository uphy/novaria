/**
 * 盤面の曲の繰り返し（`src/render/audio/music.ts`）。
 * 一時停止から戻るときの位置が繰り返しの区間の中へ正しく畳まれるかを見る
 */
import { describe, expect, it } from 'vitest';
import { CALM, loopPosition } from '../../src/render/audio/music';

const BAR = 240 / 130;

describe('loopPosition', () => {
  const { loopStart, loopEnd } = CALM;

  it('1 周目の終わりまでは経った時間がそのまま位置になる', () => {
    expect(loopPosition(10, loopStart, loopEnd)).toBe(10);
    expect(loopPosition(loopEnd - 0.001, loopStart, loopEnd)).toBeCloseTo(loopEnd - 0.001);
  });

  it('区間の終わりを越えたら頭（導入の後ろ）へ戻る', () => {
    expect(loopPosition(loopEnd, loopStart, loopEnd)).toBeCloseTo(loopStart);
    expect(loopPosition(loopEnd + 5, loopStart, loopEnd)).toBeCloseTo(loopStart + 5);
  });

  it('何周しても区間の中に収まる', () => {
    const span = loopEnd - loopStart;
    expect(loopPosition(loopEnd + span * 3 + 2, loopStart, loopEnd)).toBeCloseTo(loopStart + 2);
  });
});

describe('繰り返しの区間', () => {
  it('ふだんの曲は 17 小節目の頭から 72 小節目の頭まで（56 小節）', () => {
    expect(CALM.loopStart).toBeCloseTo(29.754, 2);
    expect(CALM.loopEnd).toBeCloseTo(133.139, 2);
  });

  it('区間は小節の頭で始まって終わるので、繰り返しても拍がずれない', () => {
    expect(((CALM.loopStart - CALM.firstBar) / BAR) % 1).toBeCloseTo(0, 6);
    expect(((CALM.loopEnd - CALM.loopStart) / BAR) % 1).toBeCloseTo(0, 6);
  });
});
