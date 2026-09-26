import { describe, expect, it } from 'vitest';
import { NEWS, countAfter } from '../../src/render/news';

describe('お知らせ', () => {
  it('新しいものが先頭で、id は重ならない（既読は id の大小で見る）', () => {
    const ids = NEWS.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort().reverse()).toEqual(ids);
    for (const id of ids) expect(id).toMatch(/^\d{4}-\d{2}-\d{2}(-\d+)?$/);
  });

  it('読んだ目印より新しい項目だけを数える', () => {
    expect(countAfter(NEWS[0].id)).toBe(0);
    expect(countAfter('')).toBe(NEWS.length);
    if (NEWS.length > 1) expect(countAfter(NEWS[1].id)).toBe(1);
  });
});
