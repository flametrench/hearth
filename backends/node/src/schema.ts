import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(HERE, '..', '..', '..', 'shared', 'sql');

async function tableExists(pool: Pool, name: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = $1
     ) AS exists`,
    [name],
  );
  return rows[0]?.exists ?? false;
}

async function applyFile(pool: Pool, filename: string): Promise<void> {
  const sql = await readFile(resolve(SQL_DIR, filename), 'utf8');
  await pool.query(sql);
}

export async function ensureSchema(pool: Pool): Promise<void> {
  if (!(await tableExists(pool, 'usr'))) {
    await applyFile(pool, 'flametrench-schema.sql');
  }
  if (!(await tableExists(pool, 'ticket'))) {
    await applyFile(pool, 'hearth-schema.sql');
  }
}
