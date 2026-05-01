import { test, expect, type Page } from '@playwright/test';
import { resetDb, clearMailpit, teardown } from '../fixtures/db.js';
import { api, installSysadmin } from '../fixtures/api.js';

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  await resetDb();
  await clearMailpit();
  // Install establishes the inst.installed_by attribution that customer
  // submit uses as createdBy on minted share tokens.
  await installSysadmin();
  const context = await browser.newContext();
  page = await context.newPage();
});

test.afterAll(async () => {
  await page.close();
  await teardown();
});

test('signup form onboards and lands at empty /inbox', async () => {
  await page.goto('/signup');
  await page.getByTestId('signup-display-name').fill('Eve Founder');
  await page.getByTestId('signup-email').fill('eve@spa.test');
  await page.getByTestId('signup-password').fill('correcthorsebatterystaple');
  await page.getByTestId('signup-org-name').fill('Eve Support');
  await page.getByTestId('signup-org-slug').fill('eve');
  await page.getByTestId('signup-submit').click();

  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByTestId('inbox-list')).toBeVisible();
});

test('inbox surfaces a newly submitted ticket and click opens detail', async () => {
  await api('/app/tickets/submit', {
    method: 'POST',
    body: {
      org_slug: 'eve',
      customer_email: 'cx@spa.test',
      subject: 'SPA help please',
      body: 'Stuck on signin.',
    },
  });

  await page.goto('/inbox');
  await expect(page.getByText('SPA help please').first()).toBeVisible();
  await page.getByText('SPA help please').first().click();

  await expect(page).toHaveURL(/\/tickets\/ticket_[0-9a-f]{32}$/);
  await expect(page.getByTestId('ticket-detail')).toBeVisible();
  await expect(page.getByTestId('ticket-status')).toHaveText('open');
});

test('agent reply via SPA inserts the comment and moves status open → pending', async () => {
  await page.getByTestId('ticket-reply-body').fill('Looking into this now.');
  await page.getByTestId('ticket-reply-submit').click();

  await expect(page.getByText('Looking into this now.')).toBeVisible();
  await expect(page.getByTestId('ticket-status')).toHaveText('pending');
});

test('resolve flips status to resolved; reopen flips back to open', async () => {
  await page.getByTestId('ticket-resolve').click();
  await expect(page.getByTestId('ticket-status')).toHaveText('resolved');

  await page.getByTestId('ticket-reopen').click();
  await expect(page.getByTestId('ticket-status')).toHaveText('open');
});

test('Resend customer link mints a fresh share row in the SPA list', async () => {
  const before = await page.getByTestId(/^ticket-share-shr_/).count();
  await page.getByTestId('ticket-mint-share').click();
  await expect(page.getByTestId(/^ticket-share-shr_/)).toHaveCount(before + 1);
});

test('Sign out clears the session and returns to splash', async () => {
  await page.getByTestId('nav-signout').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('splash-signin')).toBeVisible();
});

test('Sign in form mints a fresh session and lands at /inbox', async () => {
  await page.goto('/signin');
  await page.getByTestId('signin-email').fill('eve@spa.test');
  await page.getByTestId('signin-password').fill('correcthorsebatterystaple');
  await page.getByTestId('signin-submit').click();
  await expect(page).toHaveURL(/\/inbox$/);
});

test('public support form submits a ticket and shows success state with mailpit link', async () => {
  await page.goto('/support/eve');
  await page.getByTestId('support-email').fill('returning@spa.test');
  await page.getByTestId('support-subject').fill('Public form smoke');
  await page.getByTestId('support-body').fill('Hello from the support page.');
  await page.getByTestId('support-submit').click();

  await expect(page.getByTestId('support-success')).toBeVisible();
  await expect(page.getByTestId('support-mailpit-link')).toBeVisible();
});
