import type { Pool } from 'pg';

export interface OrgRecord {
  id: string;
  uuid: string;
  name: string | null;
  slug: string | null;
}

export async function findOrgBySlug(pool: Pool, slug: string): Promise<OrgRecord | null> {
  const { rows } = await pool.query<{ uuid: string; name: string | null; slug: string | null }>(
    `SELECT id::text AS uuid, name, slug FROM org WHERE slug = $1 AND status = 'active'`,
    [slug],
  );
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return {
    id: encodeOrgId(row.uuid),
    uuid: row.uuid,
    name: row.name,
    slug: row.slug,
  };
}

export async function listOrgAdminEmails(pool: Pool, orgUuid: string): Promise<string[]> {
  const { rows } = await pool.query<{ identifier: string }>(
    `SELECT DISTINCT cred.identifier
       FROM mem
       JOIN cred ON cred.usr_id = mem.usr_id
      WHERE mem.org_id = $1
        AND mem.status = 'active'
        AND mem.role IN ('owner', 'admin')
        AND cred.status = 'active'
        AND cred.type = 'password'`,
    [orgUuid],
  );
  return rows.map((r) => r.identifier);
}

function encodeOrgId(uuid: string): string {
  return `org_${uuid.replaceAll('-', '')}`;
}
