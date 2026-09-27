/**
 * 練習のヒントを出すかどうか。一時停止の画面で切り替え、次のゲームにも持ち越す
 * （練習は何ゲームも続けるので、毎回つけ直させない）。
 * ヒントを 1 度でもつけたゲームは記録にもランキングにも残さない。その判定は main.ts が持つ
 */
const KEY = 'novaria.hint.v1';

export function loadHintOn(): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    return raw !== null && (JSON.parse(raw) as { on?: unknown }).on === true;
  } catch {
    return false;
  }
}

export function saveHintOn(on: boolean): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ on }));
  } catch {
    // 保存できなくても、このゲームのあいだは切り替わる
  }
}
