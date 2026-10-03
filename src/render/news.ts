/**
 * 遊ぶ人向けのお知らせ（何が変わったか）。
 *
 * commit から作らず、ここに手で書く。commit のメッセージは開発の言葉で長く、
 * 遊ぶ人に関係のない入れ替え（CI や文書だけの変更）も多い。
 * 遊ぶ人が気づく変更を入れた PR で 1 件足す。新しいものを先頭に置く。
 *
 * 知らせるのは、この端末が最後に読んだものより新しい項目があるときだけ（`novaria.news.v1`）。
 * デプロイのたびではなく、項目を足したときだけ知らせたいので、ビルドの id ではなく項目の id で見る
 */
export interface NewsItem {
  /** 既読の目印。日付に、同じ日の 2 件目からは -2 などを付ける。一度出したら変えない */
  readonly id: string;
  /** 画面に出す日付 */
  readonly date: string;
  readonly title: string;
  /** 1〜3 行。遊ぶ人の言葉で書く */
  readonly lines: readonly string[];
}

export const NEWS: readonly NewsItem[] = [
  {
    id: '2026-10-03',
    date: '2026.10.03',
    title: '隕石を運ぶ手ざわりを滑らかにした',
    lines: [
      '入れ替わる境目に指を置いても、隣と行ったり来たりしなくなった。',
      '入れ替わった隣の隕石は、元の位置から滑って来る。',
    ],
  },
  {
    id: '2026-10-01-2',
    date: '2026.10.01',
    title: 'レアメタルを見分けやすくした',
    lines: [
      'レアメタルは磨いた金属の板に見え、ときどき光が横切る。同じ色の隕石と見分けがつく。',
      'まだ打ち上げたことがないうちは、降ってきたときに取り方を山のすぐ上の帯に出す。',
      'ヒントをつけていると、レアメタルごと宇宙へ出せる点火を先に教える。',
    ],
  },
  {
    id: '2026-10-01',
    date: '2026.10.01',
    title: '遊んでいる最中の帯の見出しが盤面を隠さないようにした',
    lines: [
      '「MAX CHAIN」「LEVEL UP」「ALL CLEAR」の帯は、盤面の真ん中ではなく、いちばん高い列のすぐ上に細く出る。連鎖をつないでいるあいだも積もった隕石が見える。',
    ],
  },
  {
    id: '2026-09-27-4',
    date: '2026.09.27',
    title: '空中のカタマリを運んでいる途中で外れないようにした',
    lines: [
      '掴んでいるカタマリが着地したとき、別のカタマリとドッキングしたとき、同じカタマリの別の列で点火したときに、指を離していないのに隕石が外れていた。',
      'いまは掴んだまま運び続けられる。',
    ],
  },
  {
    id: '2026-09-27-3',
    date: '2026.09.27',
    title: '高くなった列を足もとで知らせるようにした',
    lines: [
      '9 段を越えた列は、盤面の下の発射台が橙に光る。高くなるほど強く光り、あと 1 段で脈打ち、危なくなると赤く点滅する。',
      'あと 1 段になった瞬間に、短く振動する（対応している端末だけ）。',
    ],
  },
  {
    id: '2026-09-27-2',
    date: '2026.09.27',
    title: '両手で 2 列を同時に動かせるようにした',
    lines: [
      '指ごとに別の列の隕石を掴める。横持ちで左右の親指を使うと、2 か所を同時に組み替えられる。',
      'これまでは 2 本目の指を置くと、1 本目で運んでいた隕石が外れていた。',
    ],
  },
  {
    id: '2026-09-27',
    date: '2026.09.27',
    title: '練習用のヒントを出せるようにした',
    lines: [
      '一時停止の「ヒント」をつけると、次に動かすとよい隕石と運び先を矢印で出す。',
      '攻めの手は緑、危ない列を守る手は橙と赤。いまの方針（連鎖をつなぐ・守る など）も上に出る。',
      '「速さ」でゆっくりにもできる。つけたゲームは記録にもランキングにも残らない。',
    ],
  },
  {
    id: '2026-09-26',
    date: '2026.09.26',
    title: 'CPU の「つよい」が手ごわくなった',
    lines: [
      '高く積もった列を、縦にそろえて崩しにくるようになった。',
      '1 本だけ高くなって自滅することが減り、攻め勝たないと倒せない。',
      '「ふつう」も少しだけ粘る。',
    ],
  },
  {
    id: '2026-09-24',
    date: '2026.09.24',
    title: '対戦の決着を見せるようにした',
    lines: [
      '決着の瞬間に止まって、勝てば花火、負ければ暗転。',
      '相手ごとの連勝と、「あと何段だった」が結果に出る。',
      '「記録」は自己ベスト・対戦・ランキングをタブで見る画面にした。',
    ],
  },
];

/**
 * 検証のあいだだけ、既読かどうかに関係なく毎回知らせる（見た目をプレビューで確かめるため）。
 * 本番へ出す前に false に戻す
 */
const ALWAYS_ANNOUNCE = false;

const KEY = 'novaria.news.v1';

function readSeen(): string | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { seen?: unknown } | null;
    return typeof raw?.seen === 'string' ? raw.seen : null;
  } catch {
    return null;
  }
}

function writeSeen(id: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ seen: id }));
  } catch {
    /* 残せなくても遊びは止めない。次に開いたときにまた知らせるだけ */
  }
}

/** 検証で毎回知らせるとき、この起動のあいだに読んだか */
let readThisSession = false;

/**
 * まだ読んでいない項目の数。
 * 目印の無い端末は、初めて開いた人ならいま出ているものを全部読んだことにする（昔の変更を新しいとは言わない）。
 * 前から遊んでいる人（`returning`）には、いちばん新しい 1 件を知らせる
 */
export function unreadNews(returning: boolean): number {
  if (NEWS.length === 0) return 0;
  if (ALWAYS_ANNOUNCE) return readThisSession ? 0 : 1;
  let seen = readSeen();
  if (seen === null) {
    seen = returning ? (NEWS[1]?.id ?? '') : NEWS[0].id;
    writeSeen(seen);
  }
  return countAfter(seen);
}

/** 読んだ目印より新しい項目の数。id は日付から始まるので、文字列の大小で比べられる */
export function countAfter(seen: string): number {
  return NEWS.filter((n) => n.id > seen).length;
}

/** お知らせを開いたら、いま出ているものを全部読んだことにする */
export function markNewsRead(): void {
  readThisSession = true;
  if (NEWS.length > 0) writeSeen(NEWS[0].id);
}

/** 読む前に未読だった項目か（開いた画面で印を付けるため、開く前に数えておく） */
export function isUnread(item: NewsItem, unreadBefore: number): boolean {
  return NEWS.indexOf(item) < unreadBefore;
}
