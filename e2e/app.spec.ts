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

test('account modal separates login, signup, and recovery choices', async ({ page }) => {
  await page.goto('/');

  const accountAccess = page.getByRole('button', { name: 'Log In / Sign Up' });
  const accountUnavailable = page
    .getByRole('navigation', { name: 'Account' })
    .getByText('Account features are not configured.');

  await expect(accountAccess.or(accountUnavailable)).toBeVisible();

  if (await accountUnavailable.isVisible()) {
    await page.getByRole('tab', { name: 'Account' }).click();
    await expect(page.getByRole('heading', { name: 'Account settings' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Privacy Notice' })).toBeVisible();
    return;
  }

  await accountAccess.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName('Log in to Crohn’s Buddy');
  await expect(dialog.getByRole('link', { name: 'Privacy Notice' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Log in to Crohn’s Buddy' })).toBeVisible();
  await expect(
    dialog.getByRole('textbox', { name: 'Email', exact: true }),
  ).toHaveAttribute('autocomplete', 'email');
  await expect(dialog.getByLabel('Password', { exact: true })).toHaveAttribute(
    'autocomplete',
    'current-password'
  );
  await expect(dialog.getByRole('button', { name: 'Log in' })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Sign up' })).toBeVisible();
  await expect(dialog.getByText(/cognito|amazon cognito/i)).toHaveCount(0);
  await expect(dialog.getByText('Private by design')).toHaveCount(0);

  const google = dialog.getByRole('button', { name: 'Sign in with Google' });
  await expect(google).toBeEnabled();
  await expect(
    dialog.getByRole('button', { name: 'Sign in with Facebook' }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole('button', { name: 'Sign in with Amazon' }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole('button', { name: 'Sign in with Apple' }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole('button', { name: /sign in with linkedin/i }),
  ).toHaveCount(0);

  await dialog.getByRole('button', { name: 'Sign up' }).click();
  await expect(
    dialog.getByRole('heading', { name: 'Sign up for Crohn’s Buddy' }),
  ).toBeVisible();
  await expect(dialog.getByText('Request an invitation')).toBeVisible();
  await expect(
    dialog.getByText(/self-service registration is temporarily unavailable/i),
  ).toBeVisible();

  await dialog.getByRole('button', { name: 'Back to login' }).click();
  await dialog.getByRole('button', { name: 'Forgot password?' }).click();
  await expect(dialog.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
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
