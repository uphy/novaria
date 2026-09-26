/**
 * 原作の呼び名がリポジトリに戻ってきていないかを見る。CI の unit で回す。
 *
 * 作品名・惑星名・キャラクター名は、このファイルにも書かない（README の「名称の扱い」）。
 * ここに並べるのは、書いてしまっても差し支えない一般的な綴りで、原作の呼び名を広く捕まえるものだけ。
 * 固有の名前は手元の `.local/banned-terms.txt`（1 行 1 語、git で追跡しない）に置けば、手元で回したときだけ一緒に見る。
 *
 * 引数にディレクトリを渡すと、そこも見る（`node tools/check-names.mjs dist` で配信物を見る）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PATTERNS = [
  // 隕石はコードでは meteor と書く。r の付かない綴りは原作の呼び名
  { re: /meteo(?!r)/i, hint: '隕石は meteor と書く' },
  { re: /メテオ/, hint: '隕石と書く' },
  // 加速の帯。コードでは boost
  { re: /speeder|スピーダー|タイムアクセル/i, hint: '加速（コードでは boost）と書く' },
  // 隕石の種類は形の名前で書く（Kind.Circle など）。元素の名前は原作のもの
  { re: /\bKind\.(Air|Fire|H2O|Soil|Iron|Zap|Herb|Zoo|Glow|Dark|Soul|Time)\b/, hint: '形の名前（Kind.Circle など）で書く' },
  // 原作の内部パラメータ名を写した綴り
  {
    re: /firstJet|tateJet|nJetBonus|jetTime|jetFrames|jetAccel|maxLevel(Frames|Time)|timeShift|\bbreak(Start|Max)\b/,
    hint: 'kick / thrust / columnThrustScale / reigniteScale / rampFrames / graceStart などで書く',
  },
  // 手元の原作の資料をファイル名で指さない。資料を写しながら作った道筋が外から読めるため
  { re: /\.local\/(original|research)\//, hint: '「原作の値」「原作どおり」のように書き、資料のファイルは指さない' },
];

const SELF = 'tools/check-names.mjs';
const SKIP = /(^|\/)(pnpm-lock\.yaml|package\.json)$|\.(png|ico|jpg|webp)$/;

const local = '.local/banned-terms.txt';
if (existsSync(local)) {
  for (const line of readFileSync(local, 'utf8').split('\n')) {
    const term = line.trim();
    if (!term || term.startsWith('#')) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    PATTERNS.push({ re: new RegExp(escaped, 'i'), hint: '.local/banned-terms.txt の語' });
  }
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const files = [...tracked, ...process.argv.slice(2).flatMap(walk)].filter(
  (f) => f !== SELF && !SKIP.test(f) && existsSync(f),
);

let found = 0;
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const { re, hint } of PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      found++;
      console.log(`${file}:${i + 1}: 「${m[0]}」— ${hint}`);
    }
  });
}

if (found > 0) {
  console.log(`\n原作の呼び名が ${found} か所にある。名前の対応は手元の .local/original-terms.md にある`);
  process.exit(1);
}
console.log(`原作の呼び名は無い（${files.length} ファイル）`);
