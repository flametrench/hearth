import { test, expect } from '@playwright/test';
import { resetDb, teardown } from '../fixtures/db.js';
import { installSysadmin } from '../fixtures/api.js';

test.beforeAll(async () => {
  await resetDb();
  await installSysadmin();
});

test.afterAll(async () => {
  await teardown();
});

test('admin install screen shows already-installed branch on second visit', async ({ page }) => {
  await page.goto('/admin/install');
  await expect(page.getByTestId('install-already')).toBeVisible();
});

test('admin install POST is idempotent — second call returns 409', async () => {
  await expect(installSysadmin('again@e2e.test')).rejects.toThrow(/409/);
});

test('SPA splash has signin/signup CTAs', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('splash-signin')).toBeVisible();
  await expect(page.getByTestId('splash-signup')).toBeVisible();
});
