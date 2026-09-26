/**
 * 効果音の共通の決めごと。
 * 音ごとに音律も音色もばらばらだと、重なったときに濁って「別の場所の音」に聞こえる。
 * 音程を 1 本の音階から取り、音色を役割で分けることで、全部が同じ世界の音になる。
 */

/**
 * F メジャーペンタトニック。半音で数えた段で、0 が F4。
 * 短 2 度とトライトーンを持たないので、どの 2 段を同時に鳴らしても濁らない。
 * 連続点火で音が重なっても和音になるのはこのため
 */
const SCALE_STEPS = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31, 33];

/**
 * 0 段目の周波数（F4）。盤面の曲（`music.ts`）が F メジャーなので、そこに合わせて A4 から 4 半音下げた。
 * 曲を差し替えて調が変わったら、ここも合わせる
 */
const ROOT = 440 * Math.pow(2, -4 / 12);

/** 音階の i 段目の周波数。範囲の外は端で止める */
export function note(i: number): number {
  const step = SCALE_STEPS[Math.max(0, Math.min(SCALE_STEPS.length - 1, Math.round(i)))];
  return ROOT * Math.pow(2, step / 12);
}

/** 連続点火の回数から音程を出す。11 回目からは上がらない（耳に痛いだけになる） */
export function comboNote(combo: number): number {
  return note(Math.min(combo - 1, 10));
}

/**
 * 金属の非整数倍音。整数倍だと「弦」に、非整数倍だと「叩いた金属」に聞こえる。
 * PeriodicWave では非整数倍音を作れないので、sine を重ねて出す
 */
export const METAL_RATIOS = [1, 2.0, 2.76, 5.04, 7.1];

/** マスターの音量。この後ろの limiter で潰れるので、ここは頭を残す程度に取る */
export const MASTER_GAIN = 0.6;

/**
 * バスごとの音量。爆発（impact）を基準に、ずっと鳴っているもの（burn）と
 * 指の操作（move）は意識しないと聞こえない大きさまで下げる
 */
export const BUS_TRIM = {
  impact: 0.9,
  burn: 0.7,
  move: 0.5,
  reward: 0.8,
  ui: 0.6,
} as const;

/**
 * 共通の「部屋」への送り量。
 * ConvolverNode は畳み込みが重くスマホのフレームに響くので、
 * 短いディレイの櫛を 4 本並べた小さな残響（`ROOM`）を全部の音で共有して「同じ場所で鳴っている」ことにする
 */
export const ROOM_SEND = {
  impact: 0.22,
  burn: 0,
  move: 0,
  reward: 0.4,
  ui: 0.18,
} as const;

/**
 * 残響。長さの違うディレイの帰還を 4 本並べ、左右に 2 本ずつ振る（Schroeder の櫛の簡略版）。
 * 帰還 0.72 で残りは 0.8 秒ほど。帰還の中の lowpass で、高い音から先に消える
 */
export const ROOM = {
  combs: [0.0297, 0.0371, 0.0411, 0.0437],
  feedback: 0.72,
  lowpass: 3200,
  /** 残響の戻りの音量 */
  wet: 0.2,
} as const;

/**
 * 打ち上げの笛と大気圏突破のきらめきにだけ付ける、左右を行き来するこだま。
 * 飛んでいった音が空に跳ね返って遠ざかるように聞こえる
 */
export const ECHO = {
  left: 0.19,
  right: 0.28,
  feedback: 0.3,
  lowpass: 2600,
  send: 0.28,
} as const;

/** マスターの音の味付け。スマホのスピーカーでも腹に来るよう低い中域を、きらめきのために高域を少し持ち上げる */
export const MASTER_EQ = {
  punch: { f: 160, gain: 3 },
  air: { f: 7000, gain: 2.5 },
} as const;
