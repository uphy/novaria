/**
 * 対戦の戦績（`src/render/records.ts`）。
 * localStorage は node には無いので、置き場だけを偽物に差し替えて回す
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cpuDuelKey,
  findDuel,
  loadDuels,
  onlineDuelKey,
  recordDuel,
  type Opponent,
} from '../../src/render/records';

const store = new Map<string, string>();

globalThis.localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

const cpu = (level: string): Opponent => ({
  kind: 'cpu',
  key: cpuDuelKey(level),
  label: `CPU（${level}）`,
});

const net = (name: string): Opponent => ({
  kind: 'online',
  key: onlineDuelKey(name),
  label: name,
});

beforeEach(() => store.clear());

describe('相手ごとの勝ち負け', () => {
  it('勝ち・負け・引き分けをそれぞれ数える', () => {
    recordDuel(cpu('normal'), 'win');
    recordDuel(cpu('normal'), 'win');
    recordDuel(cpu('normal'), 'lose');
    const duel = recordDuel(cpu('normal'), 'draw');
    expect([duel.wins, duel.losses, duel.draws]).toEqual([2, 1, 1]);
  });

  it('CPU の強さが違えば別の相手として数える', () => {
    recordDuel(cpu('easy'), 'win');
    recordDuel(cpu('hard'), 'lose');
    expect(findDuel(cpuDuelKey('easy'))!.wins).toBe(1);
    expect(findDuel(cpuDuelKey('easy'))!.losses).toBe(0);
    expect(findDuel(cpuDuelKey('hard'))!.losses).toBe(1);
    expect(findDuel(cpuDuelKey('normal'))).toBe(null);
  });

  it('オンラインの相手は名前で見分ける。大文字小文字と前後の空白は同じ人にする', () => {
    recordDuel(net('Nova'), 'win');
    recordDuel(net(' nova '), 'win');
    recordDuel(net('べつのひと'), 'lose');
    expect(findDuel(onlineDuelKey('NOVA'))!.wins).toBe(2);
    expect(findDuel(onlineDuelKey('べつのひと'))!.losses).toBe(1);
  });

  it('呼び名は最後に戦ったときの書き方に合わせる', () => {
    recordDuel(net('Nova'), 'win');
    recordDuel(net('NOVA'), 'win');
    expect(findDuel(onlineDuelKey('nova'))!.label).toBe('NOVA');
  });

  it('最後に戦った相手から順に並ぶ', () => {
    recordDuel(net('あ'), 'win');
    recordDuel(net('い'), 'win');
    recordDuel(net('あ'), 'lose');
    expect(loadDuels().map((d) => d.label)).toEqual(['あ', 'い']);
  });

  it('オンラインの相手は 30 人まで。古いほうから落とし、CPU は落とさない', () => {
    recordDuel(cpu('easy'), 'win');
    for (let i = 0; i < 31; i++) recordDuel(net(`ひと${i}`), 'win');
    const duels = loadDuels();
    expect(duels.filter((d) => d.kind === 'online')).toHaveLength(30);
    expect(findDuel(onlineDuelKey('ひと0'))).toBe(null);
    expect(findDuel(onlineDuelKey('ひと30'))!.wins).toBe(1);
    expect(findDuel(cpuDuelKey('easy'))!.wins).toBe(1);
  });

  it('続けて勝つと連勝、負けると連敗を数え、引き分けで 0 に戻る', () => {
    recordDuel(cpu('easy'), 'win');
    expect(recordDuel(cpu('easy'), 'win').streak).toBe(2);
    expect(recordDuel(cpu('easy'), 'lose').streak).toBe(-1);
    expect(recordDuel(cpu('easy'), 'lose').streak).toBe(-2);
    expect(recordDuel(cpu('easy'), 'win').streak).toBe(1);
    expect(recordDuel(cpu('easy'), 'draw').streak).toBe(0);
  });

  it('連勝を数える前に残した記録は 0 から数える', () => {
    store.set(
      'novaria.duels.v1',
      '[{"kind":"cpu","key":"cpu:easy","label":"弱い","wins":3,"losses":1,"draws":0,"at":1}]',
    );
    expect(findDuel(cpuDuelKey('easy'))!.streak).toBe(0);
    expect(recordDuel(cpu('easy'), 'lose').streak).toBe(-1);
  });

  it('置き場が壊れていても落ちない', () => {
    store.set('novaria.duels.v1', '{"key":"cpu:easy"}');
    expect(loadDuels()).toEqual([]);
    store.set('novaria.duels.v1', '[null,{"key":123},{"key":"cpu:easy","label":"弱い","wins":"x"}]');
    expect(loadDuels()).toEqual([
      { kind: 'cpu', key: 'cpu:easy', label: '弱い', wins: 0, losses: 0, draws: 0, streak: 0, at: 0 },
    ]);
  });
});
