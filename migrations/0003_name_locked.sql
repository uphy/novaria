-- 運営が名前を差し替えた行の印。1 の行は、遊び手が名前を変えても送り直しても名前が戻らない。
-- 不適切な名前を「名無し」にしたあと、同じ人が次に遊んだときに元の名前で上書きされないようにする
ALTER TABLE scores ADD COLUMN name_locked INTEGER NOT NULL DEFAULT 0;
