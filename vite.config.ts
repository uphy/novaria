/// <reference types="vitest/config" />
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * ビルド識別子。メニューの隅に出して、スマホで「今どの版を触っているか」を確かめられるようにする。
 * CI のプレビューでは checkout が PR のマージコミットになるので、head の SHA を BUILD_COMMIT で渡す。
 */
function buildId(): string {
  const day = new Date().toISOString().slice(0, 10);
  try {
    const hash =
      process.env.BUILD_COMMIT?.slice(0, 7) ||
      execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return `${day} ${hash}`;
  } catch {
    return `${day} dev`;
  }
}

// worktree を並べて開いてもポートがぶつからないよう、環境変数で変えられるようにする（既定は 5173 / 4173）
const DEV_PORT = Number(process.env.DEV_PORT) || 5173;
const PREVIEW_PORT = Number(process.env.PREVIEW_PORT) || 4173;

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
  server: { host: true, port: DEV_PORT, strictPort: true },
  preview: { host: true, port: PREVIEW_PORT, strictPort: true },
  build: { target: 'es2022' },
  plugins: [
    // 配信物に入る他人のコードは workbox だけ（画面側の workbox-window と、Service Worker の workbox-*）。
    // MIT は写しに著作権表示を付ける決まりなので、ライセンス文を licenses.txt として一緒に出す
    {
      name: 'licenses',
      apply: 'build',
      generateBundle() {
        const text = readFileSync('node_modules/workbox-window/LICENSE', 'utf8');
        this.emitFile({
          type: 'asset',
          fileName: 'licenses.txt',
          source: `workbox (workbox-window, workbox-core, workbox-precaching, workbox-routing)\n\n${text}`,
        });
      },
    },
    // ホーム画面に置いて全画面で遊べるようにし、一度開けばオフラインでも動くようにする。
    // autoUpdate だと新版を取り終えた瞬間に再読み込みが走り、遊んでいる途中で盤面が消える。
    // prompt にして、入れ替える場所は src/render/update.ts が決める（メニューに戻ったとき）
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['icons/*.png'],
      manifest: {
        name: 'NOVARIA',
        short_name: 'NOVARIA',
        description: '降ってくる隕石を打ち上げて惑星を守るアクションパズル',
        lang: 'ja',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#05030f',
        theme_color: '#05030f',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // mp3 は盤面の曲。workbox は 2MiB を超えるファイルを黙って外すので、曲は 2MiB 未満に収める
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest,mp3}'],
        // SKIP_WAITING のあと、開いているページをすぐ新版の管理下に置く
        clientsClaim: true,
        // ランキングの API は Service Worker に握らせない。
        // 画面の代わりに index.html を返されると、届いていないのに届いたように見える
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  // e2e/ の .spec.ts は Playwright のものなので、vitest には拾わせない
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
