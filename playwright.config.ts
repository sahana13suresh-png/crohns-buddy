import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
      command:
          'NEXT_PUBLIC_AUTH_ENABLED=true NEXT_PUBLIC_AUTH_FLOW=redirect NEXT_PUBLIC_AUTH_SELF_REGISTRATION_ENABLED=true NEXT_PUBLIC_AUTH_PROVIDERS=google,facebook AUTH_PROVIDER=logto LOGTO_ENDPOINT=https://auth.crohns-buddy.com LOGTO_APP_ID=test-client LOGTO_APP_SECRET=test-secret AUTH_ALLOWED_ORIGINS=http://127.0.0.1:3000 AUTH_SOCIAL_PROVIDERS=google,facebook npm run dev -- --hostname 127.0.0.1',
        url: 'http://127.0.0.1:3000',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] },
    },
  ],
});
