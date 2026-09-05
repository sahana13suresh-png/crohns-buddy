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

test('account modal separates social, email, signup, and recovery choices', async ({ page }, testInfo) => {
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
  await expect(dialog.getByLabel('Password', { exact: true })).toHaveCount(0);
  await expect(
    dialog.getByRole('button', { name: 'Continue with email' }),
  ).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Sign up' })).toBeVisible();
  await expect(dialog.getByText(/cognito|amazon cognito/i)).toHaveCount(0);
  await expect(dialog.getByText('Private by design')).toHaveCount(0);

  const google = dialog.getByRole('button', { name: 'Sign in with Google' });
  await expect(google).toBeEnabled();
  await expect(
    dialog.getByRole('button', { name: 'Sign in with Facebook' }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole('button', { name: 'Sign in with Amazon' }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole('button', { name: 'Sign in with Apple' }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole('button', { name: /sign in with linkedin/i }),
  ).toHaveCount(0);

  const socialPanel = dialog.locator('aside');
  const emailPanel = dialog.locator('aside + div');
  const socialBox = await socialPanel.boundingBox();
  const emailBox = await emailPanel.boundingBox();
  expect(socialBox).not.toBeNull();
  expect(emailBox).not.toBeNull();
  if (testInfo.project.name === 'mobile-chromium') {
    expect(socialBox!.y).toBeLessThan(emailBox!.y);
  } else {
    expect(socialBox!.x).toBeLessThan(emailBox!.x);
  }

  await dialog.getByRole('button', { name: 'Forgot password?' }).click();
  await expect(dialog.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Sign up' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Back to login' }).click();
  await dialog.getByRole('button', { name: 'Sign up' }).click();
  await expect(
    dialog.getByRole('heading', { name: 'Create your account' }),
  ).toBeVisible();
  await expect(dialog.getByLabel('Password', { exact: true })).toHaveCount(0);
  await expect(
    dialog.getByRole('button', { name: 'Continue with email' }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole('button', { name: 'Sign up with Google' }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole('button', { name: 'Already have an account? Log in' }),
  ).toBeVisible();
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
