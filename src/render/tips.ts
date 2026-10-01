/**
 * 遊びの中で 1 度だけ教える札を、もう教えたかどうか。端末の localStorage（`novaria.tips.v1`）に残す。
 * いまはレアメタルの取り方だけ。打ち上げたことがあれば、取り方は分かっているとみなす
 */
const KEY = 'novaria.tips.v1';

interface Tips {
  rareMetal?: boolean;
}

function read(): Tips {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Tips | null;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/** レアメタルを宇宙へ出したことがあるか */
export function knowsRareMetal(): boolean {
  return read().rareMetal === true;
}

/** レアメタルを宇宙へ出した。次からは取り方を出さない */
export function learnRareMetal(): void {
  if (knowsRareMetal()) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...read(), rareMetal: true }));
  } catch {
    /* 残せなくても遊びは止めない。次も取り方を出すだけ */
  }
}
