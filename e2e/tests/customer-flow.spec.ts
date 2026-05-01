import { test, expect } from '@playwright/test';
import { resetDb, clearMailpit, listMailpitMessages, teardown } from '../fixtures/db.js';
import { api, installSysadmin, signin, createOrgWithSlug } from '../fixtures/api.js';

test.describe.configure({ mode: 'serial' });

interface SubmitResponse {
  ticket: { id: string; status: string };
  share: { id: string; expires_at: string };
  share_url: string;
}

let TOKEN_FROM_URL: string;

test.beforeAll(async () => {
  await resetDb();
  await clearMailpit();
  await installSysadmin();
  const { token } = await signin('sysadmin@e2e.test', 'correcthorsebatterystaple');
  await createOrgWithSlug(token, 'Acme', 'acme');
});

test.afterAll(async () => {
  await teardown();
});

test('public submit creates a ticket and emails a share link', async () => {
  const submit = await api<SubmitResponse>('/app/tickets/submit', {
    method: 'POST',
    body: {
      org_slug: 'acme',
      customer_email: 'cx@example.com',
      subject: 'Cannot login',
      body: 'Stuck at the login screen.',
    },
  });
  expect(submit.ticket.id).toMatch(/^ticket_[0-9a-f]{32}$/);
  expect(submit.share_url).toContain('/share/');

  TOKEN_FROM_URL = submit.share_url.split('/share/')[1]!;

  const messages = await listMailpitMessages();
  const last = messages[0]!;
  expect(last.Subject).toContain('Your support request');
  expect(last.To[0]!.Address).toBe('cx@example.com');
});

test('customer can view ticket via share-bearer auth on the SPA', async ({ page }) => {
  await page.goto(`/share/${TOKEN_FROM_URL}`);
  await expect(page.getByTestId('share-view')).toBeVisible();
  await expect(page.getByTestId('share-status')).toHaveText('open');
});

test('customer reply via SPA appends a comment and notifies admins', async ({ page }) => {
  await page.goto(`/share/${TOKEN_FROM_URL}`);
  await page.getByTestId('share-reply-body').fill('Any update?');
  await page.getByTestId('share-reply-submit').click();
  await expect(page.getByText('Any update?')).toBeVisible();

  const messages = await listMailpitMessages();
  const found = messages.some((m) => m.Subject.includes('New customer reply'));
  expect(found).toBe(true);
});
