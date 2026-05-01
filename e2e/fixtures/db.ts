import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://hearth:hearth@localhost:5501/hearth';

const TABLES = [
  'comment',
  'ticket',
  'inst',
  'shr',
  'tup',
  'mem',
  'inv',
  'org',
  'usr_mfa_policy',
  'mfa',
  'ses',
  'cred',
  'usr',
];

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: DATABASE_URL });
  return pool;
}

export async function resetDb(): Promise<void> {
  const p = getPool();
  await p.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

export async function setOrgSlug(orgUuid: string, name: string, slug: string): Promise<void> {
  await getPool().query(`UPDATE org SET name = $2, slug = $3 WHERE id = $1`, [orgUuid, name, slug]);
}

export async function clearMailpit(mailpitUrl = 'http://localhost:8025'): Promise<void> {
  await fetch(`${mailpitUrl}/api/v1/messages`, { method: 'DELETE' });
}

export interface MailpitMessage {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
}

export async function listMailpitMessages(
  mailpitUrl = 'http://localhost:8025',
): Promise<MailpitMessage[]> {
  const resp = await fetch(`${mailpitUrl}/api/v1/messages`);
  const json = (await resp.json()) as { messages?: MailpitMessage[] };
  return json.messages ?? [];
}

export async function teardown(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
