import { expect, test } from '@playwright/test';

test('core navigation exposes saved plans and account settings', async ({ page }) => {
  await page.goto('/');

  await expect(
    page.getByRole('heading', {
      level: 1,
      name: /your companion for\s*living with crohn's\./i,
    })
  ).toBeVisible();

  await page.getByRole('tab', { name: 'AI Meal Planner' }).click();
  await expect(page.getByRole('heading', { name: 'Saved Meal Plans' })).toBeVisible();
  await expect(
    page.getByText('Viewing saved meal plans requires signing in.')
  ).toBeVisible();

  await page.getByRole('tab', { name: 'Account' }).click();
  await expect(page.getByRole('heading', { name: 'Account settings' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Privacy Notice' })).toBeVisible();
});

test('account modal keeps credentials on Cognito and exposes secure signup controls', async ({ page }) => {
  await page.goto('/');

  const signUp = page.getByRole('button', { name: 'Sign Up' });
  const accountUnavailable = page
    .getByRole('navigation', { name: 'Account' })
    .getByText('Account features are not configured.');

  await expect(signUp.or(accountUnavailable)).toBeVisible();

  if (await accountUnavailable.isVisible()) {
    await page.getByRole('tab', { name: 'Account' }).click();
    await expect(page.getByRole('heading', { name: 'Account settings' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Privacy Notice' })).toBeVisible();
    return;
  }

  await signUp.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Privacy Notice' })).toBeVisible();
  await expect(page.getByLabel(/password/i)).toHaveCount(0);
  await expect(
    page.getByText(/Crohn's Buddy never receives or stores it/i)
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Continue to create account' })
  ).toHaveAttribute('href', '/api/auth/start?intent=signup&returnTo=%2F');

  const google = page.getByRole('button', { name: 'Sign up with Google' });
  if ((await google.count()) > 0) {
    await expect(google).toBeEnabled();
  }
});

test('tab navigation supports keyboard focus and activation', async ({ page }) => {
  await page.goto('/');

  const welcome = page.getByRole('tab', { name: 'Welcome' });
  await welcome.focus();
  await page.keyboard.press('End');

  const account = page.getByRole('tab', { name: 'Account' });
  await expect(account).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Account settings' })).toBeVisible();
});
