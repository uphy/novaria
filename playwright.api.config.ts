import { defineConfig } from '@playwright/test';

// ランキングは Worker と D1 が要るので、vite preview では回せない。
// こちらは wrangler dev をローカルで立て、D1 もローカルのファイルで動かす。
// 置き場は毎回新しくして、前の回の中身が残らないようにする
const PORT = Number(process.env.API_PORT) || 8788;
const CI = Boolean(process.env.CI);
const persist = `.wrangler/api-tests/${Date.now()}`;

export default defineConfig({
  testDir: './e2e-api',
  outputDir: './test-results-api',
  timeout: 60_000,
  // 同じランキングを見るので、直列に回す
  workers: 1,
  retries: CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    viewport: { width: 420, height: 820 },
    trace: CI ? 'on-first-retry' : 'off',
    // Worker は呼び出し元の違う書き込みを断る。ブラウザは POST に Origin を付けるが、
    // テストから直に叩くときは付かないので、ここで同じものを足しておく
    extraHTTPHeaders: { Origin: `http://127.0.0.1:${PORT}` },
    // オンライン対戦のテストは 2 つの端末を同時に開く。
    // 手前に出ていない画面の requestAnimationFrame は止められてしまうので、その仕組みを切る
    launchOptions: {
      args: [
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    },
  },
  webServer: {
    command: `pnpm build && pnpm exec wrangler d1 migrations apply SCORES_DB --local --persist-to ${persist} && pnpm exec wrangler dev --port ${PORT} --persist-to ${persist} --local`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
