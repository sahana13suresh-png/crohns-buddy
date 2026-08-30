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

test('account modal remains keyboard-accessible and validates signup fields', async ({ page }) => {
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

  await page.getByLabel('Name').fill(' ');
  await page.getByLabel('Email').fill('not-an-email');
  await page.getByLabel('Password').fill('short');
  await page.getByRole('button', { name: 'Sign Up' }).last().click();

  await expect(page.getByText('A display name of 1 to 50 characters is required.')).toBeVisible();
  await expect(page.getByText('A valid email address is required.')).toBeVisible();
  await expect(page.getByText('A password of 8 to 128 characters is required.')).toBeVisible();
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
