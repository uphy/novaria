import { describe, expect, it } from 'vitest';
import {
  NAME_MAX,
  SCORE_RULES,
  normalizeName,
  validName,
  validSubmission,
  validUserId,
} from '../../src/scores/model';

const ID = '11111111-1111-4111-8111-111111111111';

function submission(over: Partial<Record<string, unknown>> = {}): unknown {
  return {
    userId: ID,
    name: 'うちゅう',
    rules: SCORE_RULES,
    score: 12345,
    launched: 67,
    maxCombo: 8,
    seconds: 125,
    ...over,
  };
}

describe('遊び手の id', () => {
  it('UUID の形だけを通す', () => {
    expect(validUserId(ID)).toBe(true);
    expect(validUserId('11111111-1111-1111-1111-111111111111')).toBe(false);
    expect(validUserId('')).toBe(false);
    expect(validUserId(7)).toBe(false);
  });

  it('crypto.randomUUID が作る id を通す', () => {
    expect(validUserId(crypto.randomUUID())).toBe(true);
  });
});

describe('名前', () => {
  it('1 文字から 12 文字までを通す', () => {
    expect(validName('あ')).toBe(true);
    expect(validName('あ'.repeat(NAME_MAX))).toBe(true);
    expect(validName('あ'.repeat(NAME_MAX + 1))).toBe(false);
    expect(validName('')).toBe(false);
  });

  it('前後の空白と、見えない文字は通さない', () => {
    // 他の人の画面に出る文字なので、表を崩せる文字を弾く
    expect(validName(' uphy')).toBe(false);
    expect(validName('uphy ')).toBe(false);
    expect(validName('up\nhy')).toBe(false);
    expect(validName('up\u0000hy')).toBe(false);
  });

  it('入力された名前は、送れる形に直せる', () => {
    expect(normalizeName('  uphy  ')).toBe('uphy');
    expect(normalizeName('up\nhy')).toBe('up hy');
    expect(normalizeName('あ'.repeat(20))).toBe('あ'.repeat(NAME_MAX));
    expect(normalizeName('   ')).toBe('');
  });

  it('絵文字は 1 文字として数える', () => {
    // 文字の長さは code unit ではなく、見た目の文字数で見る
    expect(validName('🌠'.repeat(NAME_MAX))).toBe(true);
    expect(validName('🌠'.repeat(NAME_MAX + 1))).toBe(false);
  });
});

describe('送る中身', () => {
  it('正しい中身を通す', () => {
    expect(validSubmission(submission())).toBe(true);
  });

  it('足りない・型が違う・範囲外は通さない', () => {
    expect(validSubmission(null)).toBe(false);
    expect(validSubmission(submission({ userId: 'x' }))).toBe(false);
    expect(validSubmission(submission({ name: '' }))).toBe(false);
    expect(validSubmission(submission({ score: -1 }))).toBe(false);
    expect(validSubmission(submission({ score: 1.5 }))).toBe(false);
    expect(validSubmission(submission({ score: 10 ** 9 }))).toBe(false);
    expect(validSubmission(submission({ maxCombo: 100 }))).toBe(false);
    expect(validSubmission(submission({ seconds: '125' }))).toBe(false);
  });

  it('違う版の得点は通さない', () => {
    // 得点の付け方を変えたら SCORE_RULES を上げる。古い版の得点が同じ表に並ばない
    expect(validSubmission(submission({ rules: 'v0' }))).toBe(false);
  });
});
