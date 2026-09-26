/**
 * ランキングの書き込みの SQL。`worker/scores.ts` から使う。
 * 文字列だけここに置いてあるのは、単体テスト（`tests/worker/scores.test.ts`）が
 * migrations を当てた sqlite に同じものを流して確かめるため
 */

/** 1 時間に同じ接続元から受け付ける数。荒らしの書き込みで表が埋まらないようにする */
export const PER_HOUR = 60;

/** 運営が不適切な名前を差し替えるときの名前 */
export const HIDDEN_NAME = '名無し';

/**
 * 自己最高だけを残して書き込む。
 * 運営が名前を差し替えた人（name_locked）は、送ってきた名前を使わない。版を上げて新しい行ができるときも差し替えたまま。
 * 行は「遊び手 × 得点の付け方の版」で 1 つなので、版を上げた直後は、前の版の行を
 * 残したまま新しい行ができる（前の版の自己最高は、新しい表の邪魔をしない）。
 *
 * ?1 user_id / ?2 rules / ?3 name / ?4 score / ?5 launched / ?6 max_combo /
 * ?7 seconds / ?8 created_at / ?9 submitter / ?10 送りすぎを数え始める時刻
 */
export const UPSERT_SCORE = `INSERT INTO scores (user_id, rules, name, score, launched, max_combo, seconds, created_at, submitter, name_locked)
   SELECT ?1, ?2, CASE WHEN locked = 1 THEN '${HIDDEN_NAME}' ELSE ?3 END, ?4, ?5, ?6, ?7, ?8, ?9, locked
   FROM (SELECT COALESCE(MAX(name_locked), 0) AS locked FROM scores WHERE user_id = ?1)
   WHERE (SELECT COUNT(*) FROM scores WHERE submitter = ?9 AND created_at >= ?10) < ${PER_HOUR}
   ON CONFLICT(user_id, rules) DO UPDATE SET
     name = CASE WHEN scores.name_locked = 1 THEN scores.name ELSE excluded.name END,
     launched = CASE WHEN excluded.score > scores.score THEN excluded.launched ELSE scores.launched END,
     max_combo = CASE WHEN excluded.score > scores.score THEN excluded.max_combo ELSE scores.max_combo END,
     seconds = CASE WHEN excluded.score > scores.score THEN excluded.seconds ELSE scores.seconds END,
     created_at = CASE WHEN excluded.score > scores.score THEN excluded.created_at ELSE scores.created_at END,
     score = MAX(scores.score, excluded.score)`;

/**
 * 名前だけを付け替える。運営が差し替えた名前（name_locked）はそのまま残す。
 * ?1 新しい名前 / ?2 user_id
 */
export const RENAME = 'UPDATE scores SET name = ?1 WHERE user_id = ?2 AND name_locked = 0';

/** 遊び手が自分の行を消す。得点の付け方の版をまたいで、その人の行を全部消す。?1 user_id */
export const DELETE_OWN = 'DELETE FROM scores WHERE user_id = ?1';

/**
 * 運営が名前を差し替えて固定する（`tools/ranking-admin.mjs`）。得点は残す。?1 user_id
 */
export const HIDE_NAME = `UPDATE scores SET name = '${HIDDEN_NAME}', name_locked = 1 WHERE user_id = ?1`;
