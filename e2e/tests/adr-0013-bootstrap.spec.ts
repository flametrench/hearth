import { test, expect } from '@playwright/test';
import { resetDb, teardown } from '../fixtures/db.js';
import { api, installSysadmin } from '../fixtures/api.js';

test.beforeAll(async () => {
  await resetDb();
});

test.afterAll(async () => {
  await teardown();
});

test('install wizard atomically writes usr + cred + inst + sysadmin tuple in one txn', async () => {
  const status1 = await api<{ installed: boolean }>('/app/install/status');
  expect(status1.installed).toBe(false);

  const result = await installSysadmin();

  expect(result.sysadmin.id).toMatch(/^usr_[0-9a-f]{32}$/);
  expect(result.inst.id).toMatch(/^inst_[0-9a-f]{32}$/);
  expect(result.inst.mfa_policy).toBe('off');

  const status2 = await api<{ installed: boolean }>('/app/install/status');
  expect(status2.installed).toBe(true);
});

test('second install call is rejected with already_installed (idempotent guard)', async () => {
  await expect(installSysadmin('second@e2e.test')).rejects.toThrow(/409/);
});
