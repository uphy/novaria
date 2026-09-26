/** 端末に残す記録。原作のレコードにあたるが、いまは1 人用のぶんだけ */
export interface Records {
  score: number;
  launched: number;
  maxCombo: number;
  seconds: number;
}

const KEY = 'novaria.records.v1';

const EMPTY: Records = { score: 0, launched: 0, maxCombo: 0, seconds: 0 };

export function loadRecords(): Records {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<Records>;
    return {
      score: Number(parsed.score) || 0,
      launched: Number(parsed.launched) || 0,
      maxCombo: Number(parsed.maxCombo) || 0,
      seconds: Number(parsed.seconds) || 0,
    };
  } catch {
    return { ...EMPTY };
  }
}

/** 項目ごとに最大値を残す。更新した項目の名前を返す */
export function saveRecords(result: Records): (keyof Records)[] {
  const best = loadRecords();
  const updated: (keyof Records)[] = [];
  for (const key of ['score', 'launched', 'maxCombo', 'seconds'] as const) {
    if (result[key] > best[key]) {
      best[key] = result[key];
      updated.push(key);
    }
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(best));
  } catch {
    // 保存できない環境（プライベートモードなど）では記録を諦める
  }
  return updated;
}

/**
 * 惑星めぐりの記録。どこまで行けたかを残す。
 * 1 人用（終わりなく遊ぶほう）とは物差しが違うので、別の置き場にする
 */
export interface TourRecords {
  /** 到達した惑星の数（1 から） */
  reached: number;
  /** そのときまでの合計得点 */
  score: number;
  /** 最後の惑星まで抜けたことがあるか */
  completed: boolean;
}

const TOUR_KEY = 'novaria.tour.v1';

const TOUR_EMPTY: TourRecords = { reached: 0, score: 0, completed: false };

export function loadTourRecords(): TourRecords {
  try {
    const raw = localStorage.getItem(TOUR_KEY);
    if (!raw) return { ...TOUR_EMPTY };
    const parsed = JSON.parse(raw) as Partial<TourRecords>;
    return {
      reached: Number(parsed.reached) || 0,
      score: Number(parsed.score) || 0,
      completed: parsed.completed === true,
    };
  } catch {
    return { ...TOUR_EMPTY };
  }
}

/** 到達した惑星と得点はそれぞれの最大を残す。更新した項目の名前を返す */
export function saveTourRecords(result: TourRecords): (keyof TourRecords)[] {
  const best = loadTourRecords();
  const updated: (keyof TourRecords)[] = [];
  for (const key of ['reached', 'score'] as const) {
    if (result[key] > best[key]) {
      best[key] = result[key];
      updated.push(key);
    }
  }
  if (result.completed && !best.completed) {
    best.completed = true;
    updated.push('completed');
  }
  try {
    localStorage.setItem(TOUR_KEY, JSON.stringify(best));
  } catch {
    // 保存できない環境（プライベートモードなど）では記録を諦める
  }
  return updated;
}

/**
 * 対戦の戦績。相手ごとに何勝何敗かを数える。
 *
 * 得点は残さない（相手の攻撃で結果が変わるので、1 人用と同じ物差しにならない）が、
 * 勝ち負けは「誰と戦ったか」とセットなら比べられる。だから相手ごとに分けて数える。
 * オンラインの相手は名前でしか見分けられないので、同じ名前の別人は同じ欄に混ざる
 */
export type DuelKind = 'cpu' | 'online';

/** 戦績を数える相手。呼ぶ側（`main.ts`）が CPU の強さや相手の名前から作る */
export interface Opponent {
  kind: DuelKind;
  /** 相手を見分ける鍵 */
  key: string;
  /** 画面に出す呼び名 */
  label: string;
}

export interface Duel extends Opponent {
  wins: number;
  losses: number;
  draws: number;
  /**
   * いまの連勝（正）か連敗（負）の数。引き分けで 0 に戻る。
   * 結果の画面で「3 連勝」「連勝が止まった」を出すのに使う
   */
  streak: number;
  /** 最後に戦った時刻（ミリ秒）。新しい相手から並べ、あふれたら古いほうから捨てる */
  at: number;
}

const DUEL_KEY = 'novaria.duels.v1';

/** 覚えておくオンラインの相手の数。CPU は 3 つで増えないので、数えるのはオンラインだけ */
const ONLINE_MAX = 30;

export function cpuDuelKey(level: string): string {
  return `cpu:${level}`;
}

/** 同じ人だと分かるように、名前の前後の空白と大文字小文字の違いは吸収する */
export function onlineDuelKey(name: string): string {
  return `net:${name.trim().toLowerCase()}`;
}

const tallyOf = (value: unknown): number => Math.max(0, Math.floor(Number(value) || 0));

/** 置き場から読んだ 1 件。形が違うものは捨てる（手で書き換えられることもある） */
function toDuel(value: unknown): Duel | null {
  if (!value || typeof value !== 'object') return null;
  const d = value as Partial<Duel>;
  if (typeof d.key !== 'string' || typeof d.label !== 'string') return null;
  return {
    kind: d.kind === 'online' ? 'online' : 'cpu',
    key: d.key,
    label: d.label,
    wins: tallyOf(d.wins),
    losses: tallyOf(d.losses),
    draws: tallyOf(d.draws),
    // 連勝を数え始める前に残した記録には無い。0 から数える
    streak: Math.trunc(Number(d.streak) || 0),
    at: tallyOf(d.at),
  };
}

/** 最後に戦ったのが新しい相手から並べて返す */
export function loadDuels(): Duel[] {
  try {
    const raw = localStorage.getItem(DUEL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((v) => {
      const duel = toDuel(v);
      return duel ? [duel] : [];
    });
  } catch {
    return [];
  }
}

/** その相手との通算。まだ戦っていなければ null */
export function findDuel(key: string): Duel | null {
  return loadDuels().find((d) => d.key === key) ?? null;
}

/**
 * 1 戦ぶんを相手の欄に足す。戻り値はその相手との通算。
 * 中断（相手の接続が切れた）は勝ちにも負けにもしないので、呼ぶ側で除く
 */
export function recordDuel(who: Opponent, result: 'win' | 'lose' | 'draw'): Duel {
  const duels = loadDuels();
  const found = duels.find((d) => d.key === who.key);
  const duel: Duel = found ?? { ...who, wins: 0, losses: 0, draws: 0, streak: 0, at: 0 };
  // 名前の書き方が変わっていたら新しいほうに合わせる
  duel.label = who.label;
  duel.at = Date.now();
  if (result === 'win') {
    duel.wins++;
    duel.streak = Math.max(0, duel.streak) + 1;
  } else if (result === 'lose') {
    duel.losses++;
    duel.streak = Math.min(0, duel.streak) - 1;
  } else {
    duel.draws++;
    duel.streak = 0;
  }

  // いま戦った相手を先頭に置き直す。並び順がそのまま「新しい順」になる
  let online = 0;
  const kept = [duel, ...duels.filter((d) => d.key !== duel.key)].filter(
    // オンラインの相手は増え続けるので、古いほうから落として置き場が膨らまないようにする
    (d) => d.kind !== 'online' || ++online <= ONLINE_MAX,
  );
  try {
    localStorage.setItem(DUEL_KEY, JSON.stringify(kept));
  } catch {
    // 保存できない環境（プライベートモードなど）では記録を諦める
  }
  return duel;
}
