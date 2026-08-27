import { expect, test } from '@playwright/test';

test('home page shows the Graphs and Runs sections', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Graphs' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
});
