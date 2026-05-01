import { test, expect } from '@playwright/test';
import { resetDb, clearMailpit, teardown } from '../fixtures/db.js';
import { api, installSysadmin, signin, createOrgWithSlug } from '../fixtures/api.js';

test.describe.configure({ mode: 'serial' });

interface InboxResponse {
  tickets: Array<{ id: string; subject: string; status: string }>;
}

interface SubmitResponse {
  ticket: { id: string; status: string };
}

let token: string;
let ticketId: string;

test.beforeAll(async () => {
  await resetDb();
  await clearMailpit();
  await installSysadmin();
  const session = await signin('sysadmin@e2e.test', 'correcthorsebatterystaple');
  token = session.token;
  await createOrgWithSlug(token, 'Acme', 'acme');
  const submit = await api<SubmitResponse>('/app/tickets/submit', {
    method: 'POST',
    body: {
      org_slug: 'acme',
      customer_email: 'cx@example.com',
      subject: 'Need help',
      body: 'Where are my tickets?',
    },
  });
  ticketId = submit.ticket.id;
});

test.afterAll(async () => {
  await teardown();
});

test('agent inbox lists the submitted ticket', async () => {
  const inbox = await api<InboxResponse>('/app/orgs/acme/tickets?status=open', { bearer: token });
  expect(inbox.tickets.length).toBeGreaterThan(0);
  expect(inbox.tickets[0]!.id).toBe(ticketId);
});

test('agent comment moves status open → pending', async () => {
  await api(`/app/tickets/${ticketId}/comment`, {
    method: 'POST',
    body: { body: 'Looking now.' },
    bearer: token,
  });
  const inbox = await api<InboxResponse>('/app/orgs/acme/tickets?status=pending', {
    bearer: token,
  });
  expect(inbox.tickets.some((t) => t.id === ticketId)).toBe(true);
});

test('resolve then reopen flips status correctly', async () => {
  await api(`/app/tickets/${ticketId}/resolve`, { method: 'POST', body: {}, bearer: token });
  let inbox = await api<InboxResponse>('/app/orgs/acme/tickets?status=resolved', { bearer: token });
  expect(inbox.tickets.some((t) => t.id === ticketId)).toBe(true);

  await api(`/app/tickets/${ticketId}/reopen`, { method: 'POST', body: {}, bearer: token });
  inbox = await api<InboxResponse>('/app/orgs/acme/tickets?status=open', { bearer: token });
  expect(inbox.tickets.some((t) => t.id === ticketId)).toBe(true);
});

test('mint share + revoke', async () => {
  const minted = await api<{ share: { id: string } }>(`/app/tickets/${ticketId}/share`, {
    method: 'POST',
    body: { resend_email: false },
    bearer: token,
  });
  expect(minted.share.id).toMatch(/^shr_[0-9a-f]{32}$/);
  const revoked = await api<{ share: { revoked_at: string | null } }>(
    `/app/shares/${minted.share.id}/revoke`,
    { method: 'POST', body: {}, bearer: token },
  );
  expect(revoked.share.revoked_at).not.toBeNull();
});
