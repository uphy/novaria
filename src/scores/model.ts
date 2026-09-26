/**
 * ランキングに送る中身と、その検証。
 * ブラウザ側（`src/scores/client.ts`）と Worker 側（`worker/scores.ts`）の両方から使う。
 * 送られてくる値は全部疑ってかかるので、判定はここ 1 か所に置く。
 */

/**
 * 得点の付け方や難易度を変えたら上げる。
 * 古い版で出した得点と新しい版の得点が同じ表に並ばないようにするための目印
 */
export const SCORE_RULES = 'v2';

/** 名前の長さ（文字数）。ランキングの表に収まる長さにしてある */
export const NAME_MAX = 12;

/** ランキングへ送る 1 プレイぶん。1 人用の結果だけを送る */
export interface Submission {
  /** 端末で作った遊び手の id（UUID）。同じ id は 1 行にまとまる */
  userId: string;
  name: string;
  rules: string;
  score: number;
  /** 打ち上げた総数 */
  launched: number;
  maxCombo: number;
  /** 生き延びた秒数 */
  seconds: number;
}

/**
 * ランキングの 1 行。遊び手の id は入れない（id は本人が名前を変えたり行を消したりする合い鍵なので、
 * 他の人に見せない）。自分の行は順位で見分ける
 */
export interface RankedScore {
  name: string;
  score: number;
  launched: number;
  maxCombo: number;
  seconds: number;
  rank: number;
}

/** ランキングの取得結果。self は自分の行（まだ送っていなければ null） */
export interface Ranking {
  total: number;
  scores: RankedScore[];
  self: RankedScore | null;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function validUserId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * 表示できる名前かどうか。前後の空白が無く、改行や制御文字を含まない 1〜12 文字。
 * 名前は他の人の画面に出るので、見えない文字で表を崩せないようにする
 */
export function validName(value: unknown): value is string {
  if (typeof value !== 'string' || value !== value.trim()) return false;
  const length = Array.from(value).length;
  return length >= 1 && length <= NAME_MAX && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value);
}

/** 入力された名前を、送れる形に整える。長すぎるぶんは切る */
export function normalizeName(value: string): string {
  const trimmed = value.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ').trim();
  return Array.from(trimmed).slice(0, NAME_MAX).join('').trim();
}

const integer = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

export function validSubmission(value: unknown): value is Submission {
  if (!value || typeof value !== 'object') return false;
  const s = value as Submission;
  return (
    validUserId(s.userId) &&
    validName(s.name) &&
    s.rules === SCORE_RULES &&
    // 得点と打ち上げ数の上限は src/core/constants.ts の SCORE.max と表示の上限に合わせる
    integer(s.score, 0, 9999995) &&
    integer(s.launched, 0, 999999) &&
    integer(s.maxCombo, 0, 99) &&
    integer(s.seconds, 0, 359999)
  );
}
