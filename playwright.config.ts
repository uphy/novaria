import { defineConfig } from '@playwright/test';

// worktree を並べて e2e を回せるよう、ポートは環境変数で変えられる（vite.config.ts と同じ PREVIEW_PORT）
const PORT = Number(process.env.PREVIEW_PORT) || 4173;
const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // CI では表示待ちのタイミングで稀に落ちるテストを1回だけやり直し、2回目は trace を残す
  retries: CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    viewport: { width: 420, height: 820 },
    trace: CI ? 'on-first-retry' : 'off',
  },
  webServer: {
    command: 'pnpm build && pnpm preview --host 127.0.0.1',
    url: `http://127.0.0.1:${PORT}`,
    // 手元では起動済みの preview を使い回す。CI と worktree（PREVIEW_PORT 指定時）では、隣のツリーの古いビルドを拾わないよう必ず立て直す
    reuseExistingServer: !CI && !process.env.PREVIEW_PORT,
    timeout: 120_000,
  },
});
