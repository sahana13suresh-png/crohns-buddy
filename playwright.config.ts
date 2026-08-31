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
          'NEXT_PUBLIC_AUTH_ENABLED=true NEXT_PUBLIC_AUTH_SELF_REGISTRATION_ENABLED=false NEXT_PUBLIC_AUTH_PROVIDERS=google COGNITO_AWS_REGION=us-east-1 COGNITO_USER_POOL_ID=us-east-1_test COGNITO_CLIENT_ID=test-client COGNITO_DOMAIN=https://test.auth.us-east-1.amazoncognito.com AUTH_ALLOWED_ORIGINS=http://127.0.0.1:3000 AUTH_SOCIAL_PROVIDERS=Google AUTH_SELF_REGISTRATION_ENABLED=false npm run dev -- --hostname 127.0.0.1',
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
