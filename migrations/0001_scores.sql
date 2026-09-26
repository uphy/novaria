-- ランキング。1 人（user_id）につき 1 行で、その人の自己最高だけを残す。
-- submitter は「日付 + 接続元」のハッシュ。生の IP は残さず、送りすぎを止めるためだけに使う
CREATE TABLE scores (
  user_id TEXT PRIMARY KEY,
  rules TEXT NOT NULL,
  name TEXT NOT NULL,
  score INTEGER NOT NULL,
  launched INTEGER NOT NULL,
  max_combo INTEGER NOT NULL,
  seconds INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  submitter TEXT NOT NULL
);
CREATE INDEX scores_ranking ON scores(rules, score DESC, created_at, user_id);
CREATE INDEX scores_rate ON scores(submitter, created_at);
