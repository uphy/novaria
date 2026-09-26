/**
 * ランキングの見回り。ほかの人が不快に思う名前を「名無し」に差し替えたり、行ごと消したりする。
 * ふだんは GitHub Actions の「Ranking admin」から回す（スマホの GitHub アプリからも押せる）。
 *
 *   pnpm ranking list                     上位 50 人を順位・名前・スコアで出す
 *   pnpm ranking hide <順位> <名前>       その順位の名前を「名無し」に差し替え、以後も変えられないようにする
 *   pnpm ranking delete <順位> <名前>     その順位の行を消す（得点ごと）
 *
 * 名前は、順位を取り違えて別の人を消さないための確かめ。その順位の名前と一致しないと何もしない。
 * 置き場の指定は wrangler と同じ（`--remote --config .wrangler-deploy.json` で本番、`--local` で手元）。
 * 本番の設定は `node tools/prepare-score-database.mjs wrangler.jsonc .wrangler-deploy.json` が作る。
 */
import { execFileSync } from 'node:child_process';
import { SCORE_RULES, validUserId } from '../src/scores/model';
import { DELETE_OWN, HIDE_NAME } from '../worker/scores-sql';

/** `--remote` / `--local` / `--config 設定` は wrangler へそのまま渡し、残りを順に読む */
const where: string[] = [];
const positional: string[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config') where.push(args[i], args[++i]);
  else if (args[i].startsWith('--')) where.push(args[i]);
  else positional.push(args[i]);
}
const [action, rankText, name] = positional;

function run(sql: string): Record<string, unknown>[] {
  const out = execFileSync(
    'pnpm',
    ['exec', 'wrangler', 'd1', 'execute', 'SCORES_DB', ...where, '--json', '--command', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const parsed = JSON.parse(out) as { results: Record<string, unknown>[] }[];
  return parsed.flatMap((p) => p.results);
}

/** 表示と同じ並び（worker/scores.ts の ORDER）で、上から数える */
const ORDER = 'score DESC, created_at, user_id';

function list(): void {
  const rows = run(
    `SELECT name, score, name_locked FROM scores WHERE rules = '${SCORE_RULES}' ORDER BY ${ORDER} LIMIT 50`,
  );
  if (rows.length === 0) console.log('まだ誰も載っていない');
  rows.forEach((r, i) => {
    const locked = r.name_locked === 1 ? '（差し替え済み）' : '';
    console.log(`${String(i + 1).padStart(3)}  ${String(r.score).padStart(9)}  ${r.name}${locked}`);
  });
}

function target(): string {
  const rank = Number(rankText);
  if (!Number.isInteger(rank) || rank < 1 || !name) {
    throw new Error(`使い方: pnpm ranking ${action} <順位> <名前>`);
  }
  const [row] = run(
    `SELECT user_id, name FROM scores WHERE rules = '${SCORE_RULES}' ORDER BY ${ORDER} LIMIT 1 OFFSET ${rank - 1}`,
  );
  if (!row) throw new Error(`${rank} 位はいない`);
  if (row.name !== name) {
    throw new Error(`${rank} 位の名前は「${row.name}」で、「${name}」ではない。順位が動いたかもしれないので list で見直す`);
  }
  // SQL に埋め込むので、UUID の形であることを確かめてから使う
  if (!validUserId(row.user_id)) throw new Error('id の形がおかしい');
  return row.user_id;
}

/** `?1` を id に置き換える（wrangler d1 execute には値を別に渡す口が無い） */
const bind = (sql: string, userId: string): string => sql.replace('?1', `'${userId}'`);

function main(): void {
  if (action === 'list') {
    list();
  } else if (action === 'hide') {
    run(bind(HIDE_NAME, target()));
    console.log(`${rankText} 位「${name}」を差し替えた`);
  } else if (action === 'delete') {
    run(bind(DELETE_OWN, target()));
    console.log(`${rankText} 位「${name}」を消した`);
  } else {
    throw new Error('使い方: pnpm ranking <list|hide|delete> [順位] [名前] [--remote --config 設定 | --local]');
  }
}

try {
  main();
} catch (error) {
  // 見回りで打ち間違えたときに読むものなので、スタックではなく理由だけを出す
  console.error((error as Error).message);
  process.exit(1);
}
