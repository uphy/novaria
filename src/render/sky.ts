import { Rng } from '../core/rng';

/**
 * メニューの背景の星空。
 *
 * 星は 2 種類に分けて作る。
 * 小さく数の多い星は、1 枚の要素にまとめた `radial-gradient` の層にする。1 度描かれたら
 * 以後は層ごと合成に回るだけなので、点ひとつずつを要素にするより安い。層を分けるのは、
 * 層ごとに違う速さで明るさを揺らして、空全体が一斉に明滅しないようにするため。
 * 目立つ星だけは要素にして、1 つずつ違う周期で瞬かせ、大きいものには光の筋を足す。
 *
 * 位置も色も固定の種から回した乱数で決めるので、開き直しても同じ空になる。
 */

/** 細かい星の層の数。層ごとに揺らぎの速さと位相が違う */
export const STAR_LAYERS = 3;
/** 層 1 枚あたりの細かい星の数 */
const DIM_PER_LAYER = 46;
/** 1 つずつ瞬かせる明るい星の数 */
export const BRIGHT_STARS = 24;
/** そのうち光の筋を持つ星の数 */
const SPIKED = 7;

/**
 * 星の色。ほとんどは白で、青白・淡い黄・淡い橙を少しだけ混ぜる。
 * 実際の星も色温度で青から橙まで分かれるので、全部を同じ白にすると作り物に見える
 */
const COLORS = [
  '#ffffff',
  '#ffffff',
  '#ffffff',
  '#f4f8ff',
  '#cfe0ff',
  '#bcd4ff',
  '#fff4d6',
  '#ffdfb0',
  '#ffc9bd',
];

function pick(rng: Rng, list: readonly string[]): string {
  return list[rng.int(list.length)];
}

/** 上ほど数を多く、地平線に近いほど少なく散らす（下は大気が厚くて見えにくい） */
function scatterY(rng: Rng): number {
  const r = rng.next();
  return +(Math.pow(r, 1.45) * 92).toFixed(2);
}

/** メニューの背景に敷く星空と流れ星。`#menu` の先頭に置く */
export function skyHtml(): string {
  const rng = new Rng(0x6e6f7661);
  const parts: string[] = [];

  for (let layer = 0; layer < STAR_LAYERS; layer++) {
    const dots: string[] = [];
    for (let i = 0; i < DIM_PER_LAYER; i++) {
      const size = +(0.7 + rng.next() * 1.2).toFixed(2);
      const x = +(rng.next() * 100).toFixed(2);
      const y = scatterY(rng);
      const color = pick(rng, COLORS);
      // 縁を 1% だけぼかす。くっきり切ると小さい点がぎざぎざに見える
      dots.push(
        `radial-gradient(${size}px ${size}px at ${x}% ${y}%, ${color} 45%, transparent 100%)`,
      );
    }
    parts.push(`<div class="stars s${layer}" style="background-image:${dots.join(',')}"></div>`);
  }

  const stars: string[] = [];
  for (let i = 0; i < BRIGHT_STARS; i++) {
    const size = +(1.8 + rng.next() * 2).toFixed(2);
    const x = +(rng.next() * 100).toFixed(2);
    const y = scatterY(rng);
    const color = pick(rng, COLORS);
    // 瞬きの速さと位相を 1 つずつ変える。負の delay で、開いた時点から途中の姿を見せる
    const period = +(2.4 + rng.next() * 3.4).toFixed(2);
    const offset = +(rng.next() * period).toFixed(2);
    const spike = i < SPIKED ? ' spike' : '';
    stars.push(
      `<i class="star${spike}" style="left:${x}%;top:${y}%;--s:${size}px;--c:${color};` +
        `animation-duration:${period}s;animation-delay:-${offset}s"></i>`,
    );
  }

  parts.push(`<div class="bright">${stars.join('')}</div>`);
  // 明るい星の写し。画面 1 枚ぶん上に置き、星空が下へ流れても継ぎ目が出ないようにする。
  // 細かい星の層は背景を縦に繰り返すので写しが要らない
  parts.push(`<div class="bright echo" aria-hidden="true">${stars.join('')}</div>`);
  // 層をまとめて包む。オープニングでは外側の .sky ごとフェードインさせて下へ流し、
  // そのあとも内側の .drift がゆっくり下へ流れ続ける（カタマリが上がり続けている見立て）。
  // 層を 1 つずつ動かすと、層ごとの明るさの差が演出のあいだだけ消えるうえ、
  // 画面ぜんぶの大きさの面が層の数だけ作られる。
  // 流れ星は空に対して止まっていてよいので、流れる包みの外に置く
  return `<div class="sky"><div class="drift">${parts.join('')}</div><div class="meteor"></div></div>`;
}

/**
 * ゲーム画面の背景に敷く星空と星雲。`#backdrop` に入れる。
 *
 * メニューの空と違い、要素を 1 つも瞬かせない。遊んでいるあいだは canvas が毎フレーム
 * 描き直されるので、その後ろで動くものを増やさない。星はすべて 1 枚の要素の
 * `radial-gradient` にまとめ、1 度描いたら以後は合成に回るだけにする。
 * 種はメニューと別にして、地上から見上げた別の空にする
 */
export function backdropHtml(): string {
  const rng = new Rng(0x67726f75);
  const dots: string[] = [];
  // 明るい星。少しだけ大きく、縁を広くぼかして光って見せる
  for (let i = 0; i < 18; i++) {
    const size = +(2.2 + rng.next() * 2.2).toFixed(2);
    const x = +(rng.next() * 100).toFixed(2);
    const y = scatterY(rng);
    dots.push(
      `radial-gradient(${size}px ${size}px at ${x}% ${y}%, ${pick(rng, COLORS)} 30%, transparent 100%)`,
    );
  }
  for (let i = 0; i < 120; i++) {
    const size = +(0.6 + rng.next() * 1.1).toFixed(2);
    const x = +(rng.next() * 100).toFixed(2);
    const y = scatterY(rng);
    const alpha = +(0.35 + rng.next() * 0.5).toFixed(2);
    dots.push(
      `radial-gradient(${size}px ${size}px at ${x}% ${y}%, rgba(255,255,255,${alpha}) 45%, transparent 100%)`,
    );
  }
  // 星雲。薄い色の霞を 3 つ置いて、黒一色の空に奥行きを出す
  dots.push(
    'radial-gradient(60% 34% at 18% 22%, rgba(90,120,255,0.1), transparent 70%)',
    'radial-gradient(52% 30% at 86% 46%, rgba(200,80,220,0.08), transparent 70%)',
    'radial-gradient(80% 22% at 50% 4%, rgba(80,200,255,0.06), transparent 70%)',
  );
  // 最後の幕（.veil）は、負けて惑星の明かりが落ちるときにだけ濃くなる（`View.lightsOut`）
  return `<div class="field-stars" style="background-image:${dots.join(',')}"></div><div class="horizon"></div><div class="veil"></div>`;
}
