/**
 * 決定論的な乱数。同じ seed と入力列なら必ず同じ結果になる（xorshift32）。
 * ゲームロジックは全てこれを使い、Math.random は使わない。
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // 0 は xorshift の不動点なので避ける
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** 0 以上 1 未満 */
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.state = x;
    return x / 0x100000000;
  }

  /** 0 以上 n 未満の整数 */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** 重み付きの抽選。weights の添字を返す */
  weighted(weights: ReadonlyArray<number>): number {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  clone(): Rng {
    const r = new Rng(1);
    r.state = this.state;
    return r;
  }
}
