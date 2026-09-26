/**
 * ランキングの書き込み。migrations を当てた sqlite に、Worker と同じ SQL を流して確かめる。
 * 行は「遊び手 × 得点の付け方の版（rules）」につき 1 つ。版を上げた直後に、前の版に
 * 残っている自己最高のせいで新しい得点が入らない、ということが起きないようにする
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { DELETE_OWN, HIDE_NAME, HIDDEN_NAME, RENAME, UPSERT_SCORE } from '../../worker/scores-sql';

// node:sqlite は builtinModules に載っていないので、import と書くと vite が
// ただのパッケージとして探しに行って見つけられない。Node の require で直に読む
const { DatabaseSync: Sqlite } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite');

const MIGRATIONS = new URL('../../migrations/', import.meta.url);

/** 本番と同じ手順（migrations を順に当てる）で、空の置き場を作る */
function open(): DatabaseSync {
  const db = new Sqlite(':memory:');
  for (const file of readdirSync(MIGRATIONS).sort()) {
    db.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
  }
  return db;
}

/** 1 回ぶん送る。既定は「v2 の遊び手がふつうに送った」形 */
function submit(
  db: DatabaseSync,
  over: { rules?: string; score?: number; launched?: number; at?: number } = {},
): void {
  const { rules = 'v2', score = 1000, launched = 10, at = 2000 } = over;
  db.prepare(UPSERT_SCORE).run('u1', rules, 'ゆうひ', score, launched, 2, 60, at, 's1', 0);
}

/** 置き場に残っている行。版の順に並べる */
function rows(db: DatabaseSync): unknown[] {
  return db.prepare('SELECT rules, score, launched FROM scores ORDER BY rules').all();
}

describe('ランキングの書き込み', () => {
  it('版を上げた直後は、前の版の自己最高より低くても新しい版の行ができる', () => {
    const db = open();
    submit(db, { rules: 'v1', score: 5000, launched: 40 });
    submit(db, { rules: 'v2', score: 3000, launched: 12 });
    expect(rows(db)).toEqual([
      { rules: 'v1', score: 5000, launched: 40 },
      { rules: 'v2', score: 3000, launched: 12 },
    ]);
  });

  it('同じ版のあいだは、自己最高だけが残る', () => {
    const db = open();
    submit(db, { score: 1000, launched: 10 });
    submit(db, { score: 2500, launched: 25 });
    submit(db, { score: 1800, launched: 18 });
    expect(rows(db)).toEqual([{ rules: 'v2', score: 2500, launched: 25 }]);
  });

  it('同じ接続元から送りすぎると、それ以上は入らない', () => {
    const db = open();
    for (let i = 0; i < 70; i++) {
      db.prepare(UPSERT_SCORE).run(`u${i}`, 'v2', 'ゆうひ', 100 + i, 10, 2, 60, 3000, 's1', 0);
    }
    const total = db.prepare('SELECT COUNT(*) AS n FROM scores').get() as { n: number };
    expect(total.n).toBe(60);
  });
});

/** 名前を指定して送る。id と名前以外は「ふつうに送った」形 */
function send(db: DatabaseSync, userId: string, name: string, rules = 'v2', score = 1000): void {
  db.prepare(UPSERT_SCORE).run(userId, rules, name, score, 10, 2, 60, 2000, 's1', 0);
}

function names(db: DatabaseSync): unknown[] {
  return db.prepare('SELECT user_id, rules, name FROM scores ORDER BY user_id, rules').all();
}

describe('運営による名前の差し替え', () => {
  it('差し替えた名前は、本人が送り直しても名前を変えても戻らない', () => {
    const db = open();
    send(db, 'u1', 'ひどい名前');
    db.prepare(HIDE_NAME).run('u1');
    send(db, 'u1', 'ひどい名前', 'v2', 2000);
    db.prepare(RENAME).run('べつのひどい名前', 'u1');
    expect(names(db)).toEqual([{ user_id: 'u1', rules: 'v2', name: HIDDEN_NAME }]);
    // 得点は残す
    expect(db.prepare('SELECT score FROM scores').get()).toEqual({ score: 2000 });
  });

  it('版を上げて新しい行ができても、差し替えたまま', () => {
    const db = open();
    send(db, 'u1', 'ひどい名前', 'v1');
    db.prepare(HIDE_NAME).run('u1');
    send(db, 'u1', 'ひどい名前', 'v2');
    expect(names(db)).toEqual([
      { user_id: 'u1', rules: 'v1', name: HIDDEN_NAME },
      { user_id: 'u1', rules: 'v2', name: HIDDEN_NAME },
    ]);
  });

  it('差し替えていない人は、ほかの人が差し替えられても名前を変えられる', () => {
    const db = open();
    send(db, 'u1', 'ひどい名前');
    send(db, 'u2', 'ゆうひ');
    db.prepare(HIDE_NAME).run('u1');
    db.prepare(RENAME).run('ゆうひ2', 'u2');
    send(db, 'u3', 'あたらしい');
    expect(names(db)).toEqual([
      { user_id: 'u1', rules: 'v2', name: HIDDEN_NAME },
      { user_id: 'u2', rules: 'v2', name: 'ゆうひ2' },
      { user_id: 'u3', rules: 'v2', name: 'あたらしい' },
    ]);
  });
});

describe('本人による削除', () => {
  it('その人の行を版をまたいで全部消し、ほかの人の行は残す', () => {
    const db = open();
    send(db, 'u1', 'ゆうひ', 'v1');
    send(db, 'u1', 'ゆうひ', 'v2');
    send(db, 'u2', 'ほかの人');
    db.prepare(DELETE_OWN).run('u1');
    expect(names(db)).toEqual([{ user_id: 'u2', rules: 'v2', name: 'ほかの人' }]);
  });
});
