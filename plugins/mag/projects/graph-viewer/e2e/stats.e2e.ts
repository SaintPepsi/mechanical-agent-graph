import { expect, test } from '@playwright/test';

test('the stats page reports on the graph root it read', async ({ page }) => {
	await page.goto('/stats');
	await expect(page.getByRole('heading', { name: 'run stats' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Totals' })).toBeVisible();
});

test('the home page links to the stats page', async ({ page }) => {
	await page.goto('/');
	await page.getByRole('link', { name: 'run stats' }).click();
	await expect(page).toHaveURL(/\/stats$/);
});
