import { defineConfig, devices } from '@playwright/test';

const FT_API_URL = process.env.FT_API_URL ?? 'http://localhost:5001';
const WEB_URL = process.env.WEB_URL ?? 'http://localhost:3000';
const REUSE_SERVERS = process.env.REUSE_SERVERS === '1';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: REUSE_SERVERS
    ? undefined
    : [
        {
          command:
            'cd ../backends/node && DATABASE_URL=postgres://hearth:hearth@localhost:5501/hearth PORT=5001 SMTP_HOST=localhost SMTP_PORT=1025 SMTP_FROM=hearth@localhost HEARTH_PUBLIC_BASE_URL=' +
            WEB_URL +
            ' pnpm dev',
          url: `${FT_API_URL}/healthz`,
          reuseExistingServer: true,
          timeout: 60_000,
          stdout: 'pipe',
          stderr: 'pipe',
        },
        {
          command: 'cd ../web && VITE_FT_API_URL=' + FT_API_URL + ' pnpm dev',
          url: WEB_URL,
          reuseExistingServer: true,
          timeout: 60_000,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      ],
});
