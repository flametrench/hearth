const FT_API_URL = process.env.FT_API_URL ?? 'http://localhost:5001';

interface FetchOptions {
  method?: string;
  body?: unknown;
  bearer?: string;
}

export async function api<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`;
  const init: RequestInit = { method: options.method ?? 'GET', headers };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const resp = await fetch(`${FT_API_URL}${path}`, init);
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${resp.status} ${path}: ${text}`);
  return text.length > 0 ? (JSON.parse(text) as T) : (undefined as T);
}

export interface InstallResult {
  inst: { id: string; mfa_policy: string };
  sysadmin: { id: string; email: string; display_name: string };
}

export async function installSysadmin(
  email = 'sysadmin@e2e.test',
  password = 'correcthorsebatterystaple',
): Promise<InstallResult> {
  return api<InstallResult>('/app/install', {
    method: 'POST',
    body: {
      sysadmin_email: email,
      sysadmin_password: password,
      sysadmin_display_name: 'E2E Sysadmin',
      mfa_policy: 'off',
    },
  });
}

export async function signin(
  email: string,
  password: string,
): Promise<{ token: string; usr_id: string }> {
  const verify = await api<{ usr_id: string; cred_id: string }>('/v1/credentials/verify', {
    method: 'POST',
    body: { type: 'password', identifier: email, proof: { password } },
  });
  const ses = await api<{ token: string }>('/v1/sessions', {
    method: 'POST',
    body: { usr_id: verify.usr_id, cred_id: verify.cred_id, ttl_seconds: 3600 },
  });
  return { token: ses.token, usr_id: verify.usr_id };
}

export async function createOrgWithSlug(
  bearer: string,
  name: string,
  slug: string,
): Promise<{ org_id: string }> {
  const org = await api<{ org: { id: string } }>('/v1/orgs', {
    method: 'POST',
    body: {},
    bearer,
  });
  await api(`/app/orgs/${org.org.id}/settings`, {
    method: 'POST',
    body: { name, slug },
    bearer,
  });
  return { org_id: org.org.id };
}
