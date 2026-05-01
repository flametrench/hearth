import { test, expect } from '@playwright/test';
import { resetDb, teardown } from '../fixtures/db.js';
import { api } from '../fixtures/api.js';

test.describe.configure({ mode: 'serial' });

interface OnboardResponse {
  usr: { id: string; display_name: string; email: string };
  org: { id: string; name: string; slug: string };
  session: { id: string; token: string; expires_at: string };
}

interface InboxResponse {
  tickets: unknown[];
  org: { id: string; slug: string };
}

test.beforeAll(async () => {
  await resetDb();
});

test.afterAll(async () => {
  await teardown();
});

test('POST /app/onboard creates user + cred + org + owner-mem + session in one call', async () => {
  const result = await api<OnboardResponse>('/app/onboard', {
    method: 'POST',
    body: {
      display_name: 'Alice Founder',
      email: 'alice@onboard.test',
      password: 'correcthorsebatterystaple',
      org_name: 'Acme Onboard',
      org_slug: 'acme-onboard',
    },
  });
  expect(result.usr.id).toMatch(/^usr_[0-9a-f]{32}$/);
  expect(result.usr.email).toBe('alice@onboard.test');
  expect(result.org.id).toMatch(/^org_[0-9a-f]{32}$/);
  expect(result.org.slug).toBe('acme-onboard');
  expect(result.session.token.length).toBeGreaterThan(20);
});

test('returned session token grants immediate access to the new org inbox', async () => {
  const result = await api<OnboardResponse>('/app/onboard', {
    method: 'POST',
    body: {
      display_name: 'Bob',
      email: 'bob@onboard.test',
      password: 'correcthorsebatterystaple',
      org_name: 'Bob Support',
      org_slug: 'bob-support',
    },
  });
  const inbox = await api<InboxResponse>('/app/orgs/bob-support/tickets', {
    bearer: result.session.token,
  });
  expect(inbox.org.slug).toBe('bob-support');
  expect(inbox.tickets).toEqual([]);
});

test('duplicate slug returns 409 slug_taken', async () => {
  await expect(
    api('/app/onboard', {
      method: 'POST',
      body: {
        display_name: 'Carol',
        email: 'carol@onboard.test',
        password: 'correcthorsebatterystaple',
        org_name: 'Carol',
        org_slug: 'acme-onboard',
      },
    }),
  ).rejects.toThrow(/409/);
});

test('400 on missing required fields', async () => {
  await expect(
    api('/app/onboard', {
      method: 'POST',
      body: { display_name: 'X', email: 'no-org@test.test', password: 'password123' },
    }),
  ).rejects.toThrow(/400/);
});
