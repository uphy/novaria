/**
 * バランス調整用のシミュレーション。
 * CPU に何回も遊ばせて、生存時間・得点・打ち上げ数の分布を出す。
 * 数値を変えるときは前後で走らせて、変化を数字で確かめる。
 * 手を選ぶところは `src/core/cpu.ts`（対戦の相手と同じもの）を使う。
 *
 *   pnpm sim            10 回
 *   pnpm sim 50         50 回
 *   pnpm sim vs 12      CPU 同士の対戦を各組み合わせ 12 回
 *   pnpm sim atk 20     CPU の強さごとに、自分の盤面へ毎分何個降るかを 20 回
 *   pnpm sim atk 16 guard   同じことを、自分側も列を見張る CPU にして測る
 *   pnpm sim tour 12    惑星めぐりの各惑星を 12 回ずつ。脱出できるかと、そこまでの長さ
 *   pnpm sim hint 12    練習のヒントの手だけを人の速さで打たせて、守りの手本の出し方ごとに生存を比べる
 */
import { CPU_STYLES, Cpu, CpuLevel, CpuStyle } from '../src/core/cpu';
import { Game } from '../src/core/game';
import { HINT_TUNING, Hinter } from '../src/core/hint';
import { TOUR } from '../src/core/planets';
import { Tour } from '../src/core/tour';
import { Versus } from '../src/core/versus';

interface Result {
  seconds: number;
  score: number;
  launched: number;
  maxCombo: number;
  screenOutRate: number;
}

function play(seed: number, thinkFrames: number, chains: boolean): Result {
  const game = new Game({ seed });
  const cpu = new Cpu(game, { moveFrames: thinkFrames, chains, attackScale: 1, guard: false });
  let frames = 0;
  let spawned = 0;
  let lastLaunched = 0;

  while (!game.over && frames < 60 * 60 * 20) {
    cpu.think();
    const before = game.ground.reduce((a, c) => a + c.length, 0) + game.fallings.length;
    game.tick();
    const after = game.ground.reduce((a, c) => a + c.length, 0) + game.fallings.length;
    if (after > before) spawned += after - before;
    frames++;
  }
  lastLaunched = game.launched.normal + game.launched.dust + game.launched.rare;
  return {
    seconds: frames / 60,
    score: game.score,
    launched: lastLaunched,
    maxCombo: game.maxCombo,
    screenOutRate: spawned > 0 ? lastLaunched / spawned : 0,
  };
}

function stats(values: number[], digits = 0): string {
  const sorted = [...values].sort((a, b) => a - b);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const f = (n: number) => n.toFixed(digits);
  return `最小 ${f(sorted[0])} / 中央 ${f(sorted[Math.floor(sorted.length / 2)])} / 平均 ${f(avg)} / 最大 ${f(sorted[sorted.length - 1])}`;
}

/**
 * 対戦の釣り合いを測る。CPU 同士を当てて、勝敗と決着までの長さを出す。
 * 自分側の CPU は攻撃の補正を掛けない（人が操作するつもりで見る）
 */
function versus(runs: number): void {
  const levels: CpuLevel[] = ['easy', 'normal', 'hard'];
  for (const me of levels) {
    for (const foe of levels) {
      let win = 0;
      let lose = 0;
      const seconds: number[] = [];
      for (let seed = 1; seed <= runs; seed++) {
        const v = new Versus({ seed, level: foe });
        const mine = new Cpu(v.player, { ...CPU_STYLES[me], attackScale: 1 });
        let frames = 0;
        while (v.result === null && frames < 60 * 60 * 8) {
          mine.think();
          v.tick();
          frames++;
        }
        seconds.push(frames / 60);
        if (v.result === 'win') win++;
        else if (v.result === 'lose') lose++;
      }
      console.log(`  自分 ${me} × 相手 ${foe}: ${win} 勝 ${lose} 敗 / 決着 ${stats(seconds)} 秒`);
    }
  }
}

/**
 * CPU の強さを「自分の盤面に毎分何個降るか」で測る。
 * 勝敗は遅い CPU ほど自滅せず勝ち越すので強さの目安にならない（docs/decisions.md「CPU の強さ」）。
 * 遊ぶ側の手応えを決めているのは降ってくる量なので、そこを直接見る。
 * 自分側は人の代わりに中くらいの速さの CPU に操作させ、倍率は掛けない。
 * 横にしかそろえない自分側は 150 秒ほどで勝手に自滅するので、列を見張る相手（ふつう・つよい）は
 * `guard` を付けて、自分側も自滅しない CPU にして測る
 */
function attack(runs: number, guard: boolean): void {
  const me: CpuStyle = { moveFrames: 20, chains: false, attackScale: 1, guard };
  for (const level of ['easy', 'normal', 'hard'] as CpuLevel[]) {
    let win = 0;
    /** 6 分で決着がつかなかった回数 */
    let open = 0;
    const seconds: number[] = [];
    const rates: number[] = [];
    for (let seed = 1; seed <= runs; seed++) {
      const v = new Versus({ seed, level });
      const mine = new Cpu(v.player, me);
      let frames = 0;
      let taken = 0;
      while (v.result === null && frames < 60 * 60 * 6) {
        mine.think();
        taken += v.tick().player.attackTaken;
        frames++;
      }
      if (v.result === 'win') win++;
      if (v.result === null) open++;
      seconds.push(frames / 60);
      rates.push(taken / (frames / 60 / 60));
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    console.log(
      `  相手 ${level.padEnd(6)}: 毎分 ${avg(rates).toFixed(0)} 個降る / 自分が勝つ割合 ${((win / runs) * 100).toFixed(0)} %（決着なし ${open}） / 決着 ${stats(seconds)} 秒`,
    );
  }
}

/**
 * 惑星めぐりの釣り合いを測る。見るのは 2 つ。
 *
 * - 惑星ごと … その惑星だけを遊ばせて、脱出ゲージを満たせるか・何秒かかるか
 * - 通し … 母星から順に渡らせて、どこまで行けるか
 *
 * 操作は人の代わりに中くらいの速さの CPU（1 手 20 フレーム・空中では組み替えない）。
 * 人はこれより上手く連鎖を狙えるので、「この CPU が抜けられる ＝ 人なら抜けられる」の目安にする
 */
function tour(runs: number): void {
  const style: CpuStyle = { moveFrames: 20, chains: false, attackScale: 1, guard: false };
  const limit = 60 * 60 * 8;

  console.log('  -- 惑星ごと（その惑星だけを遊ばせる）');
  for (const [i, stage] of TOUR.entries()) {
    let escaped = 0;
    const seconds: number[] = [];
    const perMinute: number[] = [];
    for (let seed = 1; seed <= runs; seed++) {
      const game = new Game({ seed: seed * 977 + i, planet: stage.planet });
      const cpu = new Cpu(game, style);
      let frames = 0;
      const total = () => game.launched.normal + game.launched.dust + game.launched.rare;
      while (!game.over && total() < stage.goal && frames < limit) {
        cpu.think();
        game.tick();
        frames++;
      }
      if (total() >= stage.goal) {
        escaped++;
        seconds.push(frames / 60);
      }
      perMinute.push(total() / (frames / 60 / 60));
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const time = seconds.length > 0 ? `${stats(seconds)} 秒` : '（届かない）';
    console.log(
      `  ${stage.planet.label.padEnd(6)} 目標 ${String(stage.goal).padStart(3)} 個: ` +
        `脱出 ${((escaped / runs) * 100).toFixed(0)} % / 毎分 ${avg(perMinute).toFixed(0)} 個 / ${time}`,
    );
  }

  console.log('  -- 通し（母星から順に渡る）');
  let complete = 0;
  const reached: number[] = [];
  const totalSeconds: number[] = [];
  for (let seed = 1; seed <= runs; seed++) {
    const t = new Tour({ seed: seed * 7919 });
    const play = (): void => {
      const cpu = new Cpu(t.game, style);
      let frames = 0;
      while (!t.over && !t.escaped && frames < limit) {
        cpu.think();
        t.tick();
        frames++;
      }
    };
    play();
    while (t.escaped && !t.completed) {
      t.advance();
      play();
    }
    if (t.completed) complete++;
    reached.push(t.index + 1);
    totalSeconds.push(t.frames / 60);
  }
  console.log(
    `  完走 ${((complete / runs) * 100).toFixed(0)} % / 到達 ${stats(reached, 1)} 個目 / 通しで ${stats(totalSeconds)} 秒`,
  );
}

/**
 * 人の代わりに、ヒントの手だけを打つ。矢印が出てから react フレーム見てから運び、運んだあとは move フレーム休む。
 * 指は 1 度で運び切る（なぞる途中で揃えばそこで止まるのは人と同じ）
 */
function followHints(
  seed: number,
  react: number,
  move: number,
): { seconds: number; score: number; launched: number; guard: number; shoot: number } {
  const game = new Game({ seed });
  const hinter = new Hinter();
  let seen = '';
  let seenAt = 0;
  let rest = 0;
  let frames = 0;
  let guard = 0;
  let shoot = 0;
  let shown = 0;
  while (!game.over && frames < 60 * 60 * 10) {
    hinter.update(game);
    const a = hinter.arrow(game);
    if (a) {
      shown++;
      if (a.tier !== 'attack') guard++;
      if (a.aim.kind === 'shoot') shoot++;
    }
    const key = a ? `${a.col}:${Math.round(a.from)}:${Math.round(a.to)}` : '';
    if (key !== seen) {
      seen = key;
      seenAt = frames;
    }
    if (rest > 0) rest--;
    else if (a && frames - seenAt >= react) {
      if (game.grab(a.col, a.from + 0.5)) {
        game.dragBy(a.aim.kind === 'shoot' ? 3 : a.to - a.from);
        game.release();
      }
      rest = move;
    }
    game.tick();
    frames++;
  }
  return {
    seconds: frames / 60,
    score: game.score,
    launched: game.launched.normal + game.launched.dust + game.launched.rare,
    guard: shown > 0 ? guard / shown : 0,
    shoot: shown > 0 ? shoot / shown : 0,
  };
}

function hints(runs: number): void {
  const base = { ...HINT_TUNING };
  const variants: [string, Partial<typeof HINT_TUNING>][] = [
    ['守りなし（攻めの手本だけ）', { guardSpare: -1e9, urgentSpare: -1e9 }],
    ['崩す手の時間 + 2 秒で守り', { guardSpare: 120 }],
    ['崩す手の時間 + 4 秒で守り', { guardSpare: 240 }],
    ['崩す手の時間 + 6 秒で守り', { guardSpare: 360 }],
    ['崩す手の時間 + 9 秒で守り', { guardSpare: 540 }],
  ];
  for (const [react, move] of [
    [60, 40],
    [90, 60],
  ]) {
    console.log(`\n-- 人の速さ: 気づくまで ${react} フレーム・1 手 ${move} フレーム`);
    for (const [label, tuning] of variants) {
      Object.assign(HINT_TUNING, base, tuning);
      const results = [];
      for (let seed = 1; seed <= runs; seed++) results.push(followHints(seed, react, move));
      console.log(`  ${label}`);
      console.log(`    生存秒 ${stats(results.map((r) => r.seconds))}`);
      console.log(`    得点   ${stats(results.map((r) => r.score))}`);
      console.log(`    守りの矢印の割合 ${stats(results.map((r) => r.guard * 100))} % / うち払う ${stats(results.map((r) => r.shoot * 100), 1)} %`);
    }
  }
  Object.assign(HINT_TUNING, base);
}

const runs = Number(process.argv[3] ?? process.argv[2]) || 10;
if (process.argv[2] === 'hint') {
  console.log(`\n== ヒントどおりに打つ人  各 ${runs} 回（10 分で打ち切り）`);
  hints(runs);
  process.exit(0);
}
if (process.argv[2] === 'tour') {
  console.log(`\n== 惑星めぐり  各 ${runs} 回`);
  tour(runs);
  process.exit(0);
}
if (process.argv[2] === 'atk') {
  const guard = process.argv[4] === 'guard';
  console.log(`\n== 受ける攻撃  各 ${runs} 回${guard ? '（自分側も列を見張る）' : ''}`);
  attack(runs, guard);
  process.exit(0);
}
if (process.argv[2] === 'vs') {
  console.log(`\n== 対戦  各組み合わせ ${runs} 回`);
  versus(runs);
  process.exit(0);
}

for (const [label, think, chains] of [
  ['初心者（1 手 30 フレーム・連鎖なし）', 30, false],
  ['ふつう（1 手 12 フレーム・連鎖なし）', 12, false],
  ['上級（1 手 5 フレーム・連鎖する）', 5, true],
  ['達人（1 手 3 フレーム・連鎖する）', 3, true],
] as const) {
  const results: Result[] = [];
  for (let seed = 1; seed <= runs; seed++) results.push(play(seed, think, chains));
  console.log(`\n== ${label}  ${runs} 回`);
  console.log(`  生存秒   ${stats(results.map((r) => r.seconds))}`);
  console.log(`  得点     ${stats(results.map((r) => r.score))}`);
  console.log(`  打ち上げ ${stats(results.map((r) => r.launched))}`);
  console.log(`  最大連続 ${stats(results.map((r) => r.maxCombo))}`);
  console.log(`  降った数に対する打ち上げの割合 ${stats(results.map((r) => r.screenOutRate * 100), 1)} %`);
}
