import { expect, test } from '@playwright/test';

test('homepage has title and get started link', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle(/Playwright/);
  await expect(page.getByRole('link', { name: /get started/i })).toBeVisible();
});
