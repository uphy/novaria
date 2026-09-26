-- 行は「遊び手（user_id）× 得点の付け方の版（rules）」につき 1 つにする。
--
-- 主キーが user_id だけだと、rules を上げたときに前の版の行とぶつかる。
-- 衝突したときの更新は rules を書き換えないので、行は古い版のまま得点だけが
-- 動き、新しい版の表（どの問い合わせも rules で絞る）には二度と出られなかった。
-- SQLite は主キーを後から変えられないので、作り直して移し替える
ALTER TABLE scores RENAME TO scores_before_rules_key;
-- 索引は名前ごと表に付いてくる。同じ名前で作り直すので、先に落とす
DROP INDEX scores_ranking;
DROP INDEX scores_rate;

CREATE TABLE scores (
  user_id TEXT NOT NULL,
  rules TEXT NOT NULL,
  name TEXT NOT NULL,
  score INTEGER NOT NULL,
  launched INTEGER NOT NULL,
  max_combo INTEGER NOT NULL,
  seconds INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  submitter TEXT NOT NULL,
  PRIMARY KEY (user_id, rules)
);

INSERT INTO scores
  SELECT user_id, rules, name, score, launched, max_combo, seconds, created_at, submitter
  FROM scores_before_rules_key;

DROP TABLE scores_before_rules_key;

CREATE INDEX scores_ranking ON scores(rules, score DESC, created_at, user_id);
CREATE INDEX scores_rate ON scores(submitter, created_at);
