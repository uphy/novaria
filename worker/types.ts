/// <reference types="@cloudflare/workers-types" />

export interface Env {
  /** `dist/` の静的ファイル。`/api/` 以外は全部これが返す */
  ASSETS: Fetcher;
  /** ランキングの置き場。用意できていないときは undefined（ランキングだけが止まる） */
  SCORES_DB?: D1Database;
  /** オンライン対戦の待ち合わせと中継（`worker/arena.ts`） */
  ARENA?: DurableObjectNamespace;
}
