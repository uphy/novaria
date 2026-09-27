# novaria

降ってくる隕石を打ち上げて惑星を守るアクションパズル。ブラウザで動く。
遊び方と全体像は README.md（遊ぶ人向け）、コマンドと変更の進め方は docs/development.md、仕様の決めごとは docs/decisions.md にある。README に開発の手順を書き足さない。

## コマンド

```sh
pnpm typecheck        # tsc --noEmit
pnpm test             # コアの単体テスト（vitest、数秒）
pnpm e2e              # Playwright。ビルドして preview を立てて回す（20秒ほど）
pnpm e2e:api          # ランキングの e2e。wrangler dev とローカルの D1 で回す（e2e-api/）
pnpm sim              # CPU に遊ばせてバランスを計測（`pnpm sim vs` は対戦の釣り合い、`pnpm sim atk` は受ける攻撃の量、`pnpm sim tour` は惑星めぐりの脱出、`pnpm sim hint` はヒントの守りの効き目）
pnpm icons            # PWA のアイコンを描き直す（public/icons/）
pnpm check:names      # 原作の呼び名が紛れ込んでいないかを見る（CI の unit でも回る）
pnpm ranking list     # ランキングの見回り（hide / delete で名前の差し替え・行の削除。本番は GitHub Actions の Ranking admin）
```

初回の e2e には `pnpm exec playwright install chromium` が要る。
worktree を並べるときは `DEV_PORT` / `PREVIEW_PORT` でポートを変える。

## 構造

- `src/core/` はゲームロジック。DOM に依存しない純粋な TypeScript で、60fps 固定 tick の決定論的シミュレーション。同じ seed と入力列なら同じ結果になるので、単体テストもシミュレーションもブラウザなしで回せる
- 惑星めぐりは `src/core/planets.ts`（渡っていく 6 惑星と、脱出に要る打ち上げ数）と `src/core/tour.ts`（惑星の乗り継ぎと合計の集計）。惑星ごとの色は `src/render/theme.ts` の `PLANET_LOOKS`（空の 3 色は CSS 変数として body に渡す）。惑星の値を変えたら `pnpm sim tour` で脱出できるかを測り直す。決め方の理由は docs/decisions.md の「惑星めぐり」にある
- CPU との対戦は `src/core/versus.ts`（2 つの `Game` を同じ tick で進め、打ち上げたぶんを互いに降らせる）。CPU の思考は `src/core/cpu.ts` にあり、`pnpm sim` もこれを使う
- オンライン対戦は `src/online/`（端末側）と `worker/arena.ts`（Durable Object の待ち合わせと中継）。相手の盤面はこちらでは動かさず、攻撃の数と盤面の絵だけを送り合う。やり取りの形は `src/online/protocol.ts` に置いて両方から使う。決め方の理由は docs/decisions.md の「オンライン対戦」にある
- 練習のヒントは `src/core/hint.ts`（`cpu.ts` の `groundPlans` / `planLump` から手本を選び、揃うまでの手順ごと覚えて据え置く。方針（守る・空中で組み替える・ドッキングを狙う・連鎖をつなぐ・大きく揃える）を先に決めてから手を選ぶ。ドッキングは `src/core/dock.ts` の軽い見積もりで探し、見積もりが本物と合うかは `Game.fork`（先読みの写し。まだ降っていない隕石は降らせない）でテストする。守りの要否は列の残り時間から決める）と `View.drawHint`（矢印と狙いの札。文言は `view.ts` の `hintText`、色は攻め・守り・急ぎで分ける）・`View.drawHintPolicy`（大気圏の帯の左上に出す方針）。切り替えは一時停止の画面で、ゲームを始めるたびに消す。1 度でもつけたゲームは `main.ts` の `hintUsed` が立ち、記録にもランキングにも残さない。対戦では出さない。人の速さや守りに替える余裕を変えたら `pnpm sim hint` で測り直す。決め方の理由は docs/decisions.md の「練習のヒント」
- `src/render/` が Canvas の描画・タッチ・効果音。見た目の決まりは `src/render/theme.ts`
- ゲーム画面の背景（星空・星雲・惑星の地平線）は canvas の後ろの `#backdrop`（`sky.ts` の `backdropHtml`）で、何も動かさない。地平線の頂は `View.resize` が渡す `--ground-y`（盤面の下辺）に合わせ、色は `View.setPlanet` が `--ground` / `--ground-edge` で渡す。滅亡が迫っているときの赤い縁は canvas の上の `#alarm`（`View.applySky` が `on` を付け外しし、明るさは CSS が揺らす）
- 光って見えるもの（閃き・光の柱・攻撃の弾・装填の弾・発射台の灯）は `src/render/glow.ts` の焼いた光の玉と柱を `lighter` で貼る
- 対戦の決着の演出は `main.ts` の `beginFinale`（止める → スロー → 帯 → 結果の画面）。勝ちの花火と負けの暗転は `effects.ts` の `STARMINE` / `DUSK_STEPS` を音（`audio.ts` の `playVictory` / `playDefeat`）と絵が一緒に見て時刻をそろえる。決め方の理由は docs/decisions.md の「決着は「止める → 帯 → 結果」の間で見せる」
- 効果音は音声ファイルを持たず、`src/render/audio.ts` と `src/render/audio/`（音律とバスの `palette.ts`、バスと音源の `mixer.ts`、噴射の持続音の `burner.ts`）で合成する。盤面の出来事はその場で鳴らさず溜めておき、rAF ごとに 1 度 `audio.update()` で流す。決め方の理由は docs/decisions.md の「効果音」にある。音の中心は点火 → 打ち上げの「ぴゅーん」→ 大気圏突破のつながり（`playExplode` / `playRise` / `playScreenOut`）。音を変えたら、`OfflineAudioContext` で書き出して最大値（割れていないか）と音程の動きを確かめる
- ランキングは `worker/`（Cloudflare Workers の `/api/scores`）と `src/scores/`（端末側）。送る中身の検証は `src/scores/model.ts` に置いて両方から使う。置き場は D1 で、スキーマは `migrations/`。本番と PR のプレビューで別のデータベースを使い、id は CI が `tools/prepare-score-database.mjs` で埋める（commit には本物の id を置かない）
- 遊び手の id（UUID）と名前は端末の localStorage（`novaria.player.v1`）。id は初めて開いたときに 1 度だけ発行し、名前は空のまま。名前を聞くのは、ランキングに載せるとき（1 人用の結果画面）とオンライン対戦を始めるときで、「記録」→「名前と公開」からはいつでも決められる
- 遊び手の id はランキングの名前の付け替えと行の削除の合い鍵なので、API の返す表に載せない（自分の行は `self` の順位で見分ける）。「ランキングから消す」を選んだ端末は `novaria.player.v1` に `ranked: false` を持ち、結果を送らない
- 「記録」はタブで自己ベスト・対戦・ランキングを見るだけの画面（`recordsHtml`）。名前・扱う情報・ランキングへの掲載は、見出しの下の名前の札から開く「名前と公開」（`settingsHtml`）に分けてある。取り消せない「ランキングから消す」をふだん開く画面に置かないため
- 「記録」→「名前と公開」→「扱う情報」（`main.ts` の `privacyHtml`）が、端末に残すもの・送るもの・残さないものの告知。送るもの・残すものを足したとき（解析や広告を入れるときも）はここを直す。運営による名前の差し替えは `tools/ranking-admin.ts`。決め方の理由は docs/decisions.md の「告知と見回り」
- 端末に残す記録は `src/render/records.ts`。1 人用の自己ベスト（`novaria.records.v1`）、惑星めぐりの到達（`novaria.tour.v1`）、対戦の戦績（`novaria.duels.v1`）の 3 つ。対戦は得点を残さず、相手ごとの勝ち負けだけを数える（CPU は強さごと、オンラインは相手の名前ごと）。決め方の理由は docs/decisions.md の「戦績（何勝何敗）」にある
- 画面は canvas ではなく DOM。トップメニューは `#menu`（canvas と入れ替わる別の画面）、一時停止と結果は `#overlay`（止まった盤面の上に重ねる）。CSS は `index.html` にある
- メニューと一時停止・結果の箱（`.panel`）はゲーム画面の盤面と同じ意匠（暗いガラス・差し色の細い縁・四隅の括弧・見出しの上の英字の札 `.eyebrow`）。項目の番号と英字は `data-no` / `data-en` を CSS の生成文字で出す。ボタンの文字列（e2e が見る textContent）は日本語のままにしておくため、英字を中に書き足さない
- メニューに見える星空・惑星の地平線・打ち上がったカタマリは、すべて `#menu` の中の DOM と CSS。メニューのあいだ canvas は隠れたままで、ここで canvas を描き始めない。隕石の色は `index.html` の `:root` に `theme.ts` の `LOOKS` / `UI` と同じ値を写してあるので、片方を変えたらもう片方も直す
- 星空は `src/render/sky.ts` が組み立てる。細かい星は `radial-gradient` を並べた層 3 枚にまとめ、目立つ星だけ要素にして 1 つずつ違う周期で瞬かせる。位置も色も固定の種から回した乱数なので、開き直しても同じ空になる。層は画面ぜんぶの大きさなので、明るさを揺らすのは 1 枚だけにする（3 枚とも animation を付けると、合成用の面が画面 3 枚ぶん作られる）。星空はトップのカタマリが上がり続けている見立てで、包みの `.drift` だけがゆっくり下へ流れ続ける（細かい星の層は画面 2 枚ぶんの高さで絵を縦に繰り返し、明るい星は画面 1 枚上に写し `.bright.echo` を置いて継ぎ目を隠す）
- トップメニューのオープニングは CSS の animation だけで組んである（`#menu.intro` が 2.4 秒）。流すのは起動して最初にトップを出したときだけで（ゲームから戻ったときは流さない）、触るかキーを押せば `settleIntro()` が `intro` クラスを外して完成形に飛ぶ。どの要素も「animation を外した状態 = 演出の終了状態」になるよう書く。星空はカタマリの打ち上げに合わせて下へ流れる（カタマリを追うカメラの見立て）。星の層は包みの `.sky` と `.bright` の 2 枚だけを動かす。流れは「地平線の夜明け → 飛行機雲を引いて打ち上げ → 大気圏で閃光と揺れ → 題字が叩きつけられて光が弾ける → 項目が差し込まれる」。演出のあとも、背景の `.volley` が数秒おきに地平線から打ち上がる（transform と opacity だけ。動きを減らす設定では見えない終わりの状態で止まる）
- 遊ぶ人向けのお知らせ（何が変わったか）は `src/render/news.ts` の `NEWS` に手で書く。遊ぶ人が気づく変更を入れた PR で 1 件足す（CI や文書だけの変更では足さない）。項目を足したときだけ、トップの上の帯と隅の「お知らせ」の点で知らせる。決め方の理由は docs/decisions.md の「お知らせ」
- 画面左下の `#build` は、いま動いている版の日付と commit（`vite.config.ts` の define が埋める `__BUILD_ID__`）。メニューを出しているあいだだけ見せる
- タイミングは `src/core/constants.ts` にフレーム数でまとまっている
- `tests/core/` が単体テスト、`e2e/` が Playwright
- リポジトリは公開している。コードは MIT（`LICENSE`）で、`public/audio/` の曲は対象外。fork の PR には secrets が渡らないので、`ci.yml` の preview と `preview-cleanup.yml` はこのリポジトリのブランチの PR だけで走る。脆弱性の窓口は `SECURITY.md`
- PWA は `vite-plugin-pwa`（`vite.config.ts`）。アイコンは `pnpm icons` が `tools/make-icons.mjs` で描いて `public/icons/` に出す（出来上がった PNG は git に入れる）。新版の確認は `src/render/update.ts`、入れ替える時の決めごとは `main.ts` の `onUpdateDownloading` / `onUpdateReady`。見に行くのは起動したときと、裏に回っていた画面が表に戻ったとき（ホーム画面の PWA は閉じずに裏へ回っているだけのことが多い）。メニューにいるときに見つかったら取り終えるまで待たせてすぐ入れ替え、遊んでいる途中なら裏に回ったときかトップメニューに戻ったときまで待たせる（盤面が消えるため）。決め方の理由は docs/decisions.md の「新しい版への入れ替え」

## 描画の速さ（触るときは測ってから）

スマホは「全画面を塗り直す量」と「別々に描くものの個数」で決まる。
次の決まりで 1 フレーム 84.7ms から 5.6ms になった（Pixel 7 相当・CPU 4 倍遅。5.6ms は最初の 7 項目の時点で測った値）。どれも壊さないこと。

- **空は CSS が塗る**（`index.html` の `body`、色は CSS 変数 `--sky-mid`）。canvas は透明のまま盤面だけを描く。全画面のグラデーションを canvas に毎フレーム塗ると、それだけで 42ms かかった
- **隕石の絵は種類ごとに焼いて貼る**（`src/render/tile.ts` の `bakedTile`）。マスの大きさが変わったときだけ焼き直す。1 マスずつ塗ると 33ms かかった
- **canvas の解像度は 2 倍まで**（`View.resize`）。3 倍だと塗る画素が 2.25 倍になる
- **見せる必要がないときは描かない**。メニュー・一時停止・結果のあいだは `main.ts` の `frame()` が早く返る
- **マスの大きさと盤面の左上は整数**（`View.resize`）。焼いた絵をそのまま貼れて拡大縮小が要らない。ここを小数に戻すと 100 マスの描画が 3 倍になる
- **粒は 420 個まで**（`src/render/effects.ts` の `MAX_PARTICLES`）。粒は 1 個ずつ別の描画になるので、数がそのままフレーム時間になる。上限が無いと連鎖で 4,000 個を超え、粒だけで 57ms 使う。噴射の火は 1 フレームおき
- **`shadowBlur` を使わない**。マスごとにぼかしを作り直すので、5 マスのカタマリだけで 11ms かかる。光りは太い薄線 + 細い濃線、影は下に敷く角丸で出す
- **盤面の動かない部分は焼いて 1 枚貼る**（`View.bakeChrome`）。ガラス・格子の十字・目盛り・大気圏の網・発射台は線が数百本になる。配置か惑星が変わったときだけ焼き直す。星も canvas に描かない（`#backdrop` の DOM）。この 2 つで盤面の静かなフレームが 10.2ms → 7.6ms
- **閃きは 8 個まで**（`effects.ts` の `MAX_FLARES`）。光の玉は粒より広い面を塗るので、上限 40・半径も大きかったころは 9 列の連鎖で閃きだけに 60ms 使った。輪も太線を重ねて光らせない（同じ場面で +60ms）
- 噴射の炎（`View.drawFlame`）と点火直後の燃え方（`tile.ts` の `bakedBurn`）も焼いて貼る。炎は列ごとにグラデーションを 2 つ作っていたころ、9 列いっぱいのカタマリで +1.7ms かかった。いまは焼いた 1 枚を幅と長さを変えて 2 回貼るだけ。ここを派手にするときも、毎フレームのグラデーション生成には戻さないこと
- **画面の揺れは整数の px でずらす**（`Effects.applyShake`）。小数でずらすと焼いた絵が画素に揃わず、揺れているあいだだけ 1 フレームが 17ms 重くなっていた（花火の大玉の瞬間で 35ms → 15ms）
- メニューの演出（`index.html` の `#menu.intro-*`）で動かすのは transform と opacity だけ。この 2 つは塗り直しを起こさず合成だけで済む。`box-shadow` は動かない地平線にだけ許し、動く文字に `text-shadow` は付けない（毎フレームぼかしを描き直す）

測り方は「`view.draw` を呼んで `ctx.getImageData(0,0,1,1)` で GPU を待たせる」。
canvas 2D は API から戻っても実際の描画は後なので、読み戻さないと時間が出ない。

## テストの書き方

- e2e からは `window.__novaria` でゲームの中を触れる（`game` / `running` / `menu` / `start` / `startVersus` / `versus` / `startOnline` / `online` / `finale` / `view` / `fx` / `audio` / `setColumns` / `updateChecks` / `fakeUpdate`）。共通の入口は `e2e/helpers.ts`
- 盤面に重ねる字は `fx.bannerTitle`（いま出ている帯の見出し）と `fx.popupSpans`（吹き出しの真ん中と幅の半分）で見る（`e2e/effects.spec.ts`）
- 音は `audio.played`（直近に鳴らした音の名前）と `audio.sources`（いま鳴っている音源の数）で見る。headless でも音は出ないが、どちらも記録される（`e2e/audio.spec.ts`）
- 盤面は `setColumns([[列0の下から], [列1], ...])` で組む。揃いのない静かな盤面は `e2e/play.spec.ts` の `QUIET` にある
- `?seed=7` を付けると盤面が固定される。待ちは `waitForTimeout` より `waitForFunction` を使う（固定時間の待ちは flaky の元）
- 点火した隕石は燃えカスになって上がるので、打ち上げ数は `launched.dust` に入る
- `e2e/` は preview（静的配信）で回すので `/api/*` が無い。ランキングとオンライン対戦が絡むものは `e2e-api/` に置き、`pnpm e2e:api` で wrangler dev ごと立てて回す。オンラインは端末 2 つぶんの context を開いてつなぐ（`e2e-api/online.spec.ts`）
- `e2e/helpers.ts` の `openTitle` は名前を決めた状態で開く。初めて開いたときの流れを見るテストだけ `openFirstTime` を使う
- バグを直したときは、修正前のコードで新しいテストが落ちることを確認してからコミットする

## git と PR

- main には直接 push しない。main に入ると即 Cloudflare Workers の本番にデプロイされる（`deploy.yml`）。本番に出す前の確認は PR のプレビューで済ませ、CI の完了は待たない。順序は次のとおり
  1. 実装が終わったら、typecheck・unit・触った spec（例: `pnpm e2e e2e/play.spec.ts`）だけ手元で回す。e2e の全件は CI に任せる
  2. push して PR を作る。CI がプレビュー URL をコメントする（PR ごとに別 Worker。push から 1 分弱）
  3. `src/render/`・`index.html`・CSS に触れた変更は、プレビュー URL をスマホで開いて確かめる。これはユーザーが行うので、URL を伝えて確認を待つ
  4. 確認できたら（3 が要らない変更なら PR 作成の直後に）`gh pr merge --squash --delete-branch` を打つ
- squash merge なので、main のコミットは 1 PR につき 1 つになる。PR のコミットが 1 つならそのコミットメッセージがそのまま main に入るので、PR タイトルにも「何をなぜ変えたか」を書く
- コミットメッセージは日本語で、何をなぜ変えたかを 1 つの文にまとめる（既存のログに合わせる）
- コミットは `git add -A` ではなく、自分が変えたファイルを名指しで add する

## 名称の扱い

下敷きにした作品の名称（作品名・惑星名・キャラクター名）は、このリポジトリのどこにも書かない。
言及するときは「原作」と書く。調査資料は手元の `.local/` にだけ置き、git では追跡しない。
ルールの模倣は問題にならないが、名称と見た目は商標や表現として保護されうる。

原作の呼び名や内部パラメータ名も、識別子・コメント・文書に使わない。公開する JS には識別子やプロパティ名がそのまま残るため。
隕石は `meteor`（日本語は「隕石」）、加速の帯は `boost`（「加速」）、隕石の種類は形の名前（`Kind.Circle` など）で書く。
原作の資料と見比べるための対応表は手元の `.local/original-terms.md` にある。
コードと文書から手元の `.local/` の資料をファイル名で指さない。値の出どころは「原作の値」「原作どおり」「原作の資料に無く、ここで決めた」のように書き分ける。
`pnpm check:names` が一般的な綴りと資料への参照を見張り、手元に `.local/banned-terms.txt`（1 行 1 語）を置けば固有名も一緒に見る。
