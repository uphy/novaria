// ランキングの置き場（Cloudflare D1）を用意して、その id を入れた設定を書き出す。
// 本番と PR のプレビューで別々のデータベースを使う。無ければ作り、あれば使い回す。
// 走らせるのはデプロイの workflow だけ。commit に本物の id を残さないため、
// wrangler.jsonc には置き換え前の id（全部 0）を置いてある。
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const input = process.argv[2];
const output = process.argv[3];
if (!input || !output) throw new Error('使い方: prepare-score-database.mjs 入力の設定 出力の設定');

const config = JSON.parse(readFileSync(input, 'utf8'));
// 想定しない Worker 名のときは、別のデータベースを触らないようにここで止める
if (!/^novaria(?:-pr-\d+)?$/.test(config.name)) throw new Error(`Worker 名が想定外: ${config.name}`);

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error('CLOUDFLARE_ACCOUNT_ID と CLOUDFLARE_API_TOKEN（D1 の読み書き）が要る');

const name = `${config.name}-scores`;
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database`;

async function api(path, method = 'GET', body) {
  const response = await fetch(endpoint + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const value = await response.json();
  if (!response.ok || !value.success) {
    throw new Error(`D1 の ${method} に失敗 (${response.status}): ${JSON.stringify(value.errors)}`);
  }
  return value;
}

let database;
for (let page = 1; ; page++) {
  const result = await api(`?per_page=100&page=${page}`);
  database = result.result.find((db) => db.name === name);
  if (database || result.result.length < 100) break;
}
database ??= (await api('', 'POST', { name })).result;

config.d1_databases = [
  { binding: 'SCORES_DB', database_name: name, database_id: database.uuid, migrations_dir: 'migrations' },
];
writeFileSync(output, JSON.stringify(config, null, 2) + '\n');

execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'SCORES_DB', '--remote', '--config', output], {
  stdio: 'inherit',
});
console.log(`ランキングの置き場を用意した: ${name}`);
