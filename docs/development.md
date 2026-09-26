# 開発の手引き

## コマンド

```sh
pnpm install
pnpm dev          # http://localhost:5173（ランキングとオンライン対戦は動かない）
pnpm dev:api      # ランキングとオンライン対戦ごと手元で動かす（http://localhost:8788）
pnpm typecheck    # tsc --noEmit
pnpm test         # コアの単体テスト（vitest、数秒）
pnpm e2e          # Playwright。ビルドして preview を立てて回す（20 秒ほど）
pnpm e2e:api      # ランキングとオンライン対戦の e2e。wrangler dev とローカルの D1 を立てて回す
pnpm sim          # CPU に遊ばせてバランスを計測（`pnpm sim vs` で対戦、`pnpm sim tour` で惑星めぐり）
pnpm icons        # PWA のアイコンを描き直す（public/icons/）
pnpm check:names  # 原作の呼び名が紛れ込んでいないかを見る
pnpm ranking list # ランキングの見回り（hide / delete。本番は --remote --config で）
pnpm build        # dist/ に出力
pnpm deploy       # Cloudflare Workers へ手動デプロイ
```

初回の `pnpm e2e` には `pnpm exec playwright install chromium` が要る。
worktree を並べるときは `DEV_PORT` / `PREVIEW_PORT` でポートを変える。

## 中の作り

- `src/core/` はゲームロジック。DOM に依存しない 60fps 固定 tick の決定論的シミュレーションで、同じ seed と入力列なら同じ結果になる。単体テストも `pnpm sim` もブラウザなしで回る
- `src/render/` が Canvas の描画・タッチ・効果音。メニューや結果の画面は DOM と CSS（`index.html`）
- `src/online/` と `worker/arena.ts` がオンライン対戦。相手の操作は再現せず、攻撃の数と盤面の絵だけを送り合う。勝敗は互いの滅亡フレームだけで決めるので、どちらの端末でも同じになる
- `src/scores/` と `worker/scores.ts` がランキング。置き場は D1 で、スキーマは `migrations/`
- `tests/` が単体テスト、`e2e/` と `e2e-api/` が Playwright。e2e からは `window.__novaria` でゲームの中を触れる。`?seed=7` を付けると盤面を固定できる

配信は Cloudflare Workers。ゲーム本体は静的ファイルで、`/api/*` だけを Worker が受ける
（ランキングの読み書きは D1、オンライン対戦の待ち合わせと中継は Durable Object）。
ランキングやオンラインが落ちていても、1 人用と CPU 戦は遊べる。

仕様をどう決めたか（原作の資料に無かった値など）は [decisions.md](decisions.md) にある。数値を変えるときはここを見る。

## 変更の進め方

main には直接 push せず、PR を通す。main に入ると `.github/workflows/deploy.yml` が
本番（https://novaria.uphy.dev）へ即デプロイする。

1. ブランチを切って実装する。手元では `pnpm typecheck` と `pnpm test`、触った spec だけ回せばよい（例: `pnpm e2e e2e/play.spec.ts`）。e2e の全件は CI に任せる
2. push して PR を作る。`.github/workflows/ci.yml` が回る
   - `unit` … typecheck・名称の検査・単体テスト
   - `e2e` … Playwright（バージョンを固定した公式イメージの中で実行）。落ちたらスクリーンショットと trace が artifact に残る
   - `e2e-api` … ランキングとオンライン対戦の e2e。wrangler dev とローカルの D1 を立てて確かめる
   - `preview` … PR 専用の Worker `novaria-pr-<番号>` に公開し、URL を PR にコメントする。ランキングの置き場も PR ごとに別の D1 を作るので、本番の順位表は汚れない。fork からの PR では secrets が無いので走らない
   - `check` … 上の検証がすべて成功したときだけ成功する。ブランチ保護の必須 check にはこれを指定する
3. `src/render/`・`index.html`・CSS に触れた変更は、プレビュー URL をスマホで開いて確かめる。メニュー左下のビルド識別子（日付と commit）で、いま開いている版が分かる
4. squash merge する。PR を閉じると `preview-cleanup.yml` がプレビューの Worker と D1 を消す（プレビューを上げている途中なら終わるのを待ってから消す。閉じたあとに走り出したプレビューは何も上げない）

squash merge なので、main のコミットは 1 PR につき 1 つになる。PR タイトルにも「何をなぜ変えたか」を書く。

## ランキングの見回り

不適切な名前は `pnpm ranking hide <順位> <名前>` で「名無し」に差し替え、`delete` で行を消す。
本番は GitHub Actions の Ranking admin から押せる（スマホの GitHub アプリからも動かせる）。

## 自分の Cloudflare に置く

fork して動かすときは、`wrangler.jsonc` の `routes`（本番のカスタムドメイン `novaria.uphy.dev`）を自分のものに替えるか消す。
GitHub Actions のデプロイとプレビューには、リポジトリの secrets に次の 2 つが要る。

| secret | 中身 |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare のアカウント id |
| `CLOUDFLARE_API_TOKEN` | Workers のスクリプトと D1 を編集できる API トークン |

D1 の id は commit に置かない。`wrangler.jsonc` の id は全部 0 で、CI が `tools/prepare-score-database.mjs` で作るか探して埋める。

## 名称の扱い

下敷きにした作品の名称（作品名・惑星名・キャラクター名）は、このリポジトリのどこにも書かない。言及するときは「原作」と書く。
原作の呼び名や内部パラメータ名も、識別子・コメント・文書に使わない（公開する JS に識別子が残るため）。
原作の仕様書と調査記録は作者の手元の `.local/` にだけ置き、git では追跡しない。
コードと文書では値の出どころを「原作の値」「原作どおり」「原作の資料に無く、ここで決めた」のように書き分け、資料のファイルは指さない。
`pnpm check:names` が CI で見張る。
