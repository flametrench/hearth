import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { PostgresIdentityStore } from '@flametrench/identity/postgres';
import { PostgresTupleStore } from '@flametrench/authz/postgres';
import { generateHearthId, uuidFromHearthId } from './ids.js';

export type MfaPolicy = 'off' | 'admins' | 'all';

export interface InstallRequestBody {
  sysadmin_email: string;
  sysadmin_password: string;
  sysadmin_display_name: string;
  mfa_policy: MfaPolicy;
}

interface InstallStatusRow {
  count: string;
}

async function isInstalled(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<InstallStatusRow>(`SELECT COUNT(*)::text AS count FROM inst`);
  return Number(rows[0]?.count ?? '0') > 0;
}

function validateBody(body: unknown): InstallRequestBody {
  if (!body || typeof body !== 'object') {
    throw new ValidationError('body must be a JSON object');
  }
  const b = body as Record<string, unknown>;
  const email = b.sysadmin_email;
  const password = b.sysadmin_password;
  const displayName = b.sysadmin_display_name;
  const mfaPolicy = b.mfa_policy;

  if (typeof email !== 'string' || !email.includes('@')) {
    throw new ValidationError('sysadmin_email must be an email string');
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw new ValidationError('sysadmin_password must be a string of at least 8 characters');
  }
  if (typeof displayName !== 'string' || displayName.length === 0) {
    throw new ValidationError('sysadmin_display_name must be a non-empty string');
  }
  if (mfaPolicy !== 'off' && mfaPolicy !== 'admins' && mfaPolicy !== 'all') {
    throw new ValidationError(`mfa_policy must be one of 'off' | 'admins' | 'all'`);
  }
  return {
    sysadmin_email: email,
    sysadmin_password: password,
    sysadmin_display_name: displayName,
    mfa_policy: mfaPolicy,
  };
}

class ValidationError extends Error {}

export interface InstallContext {
  pool: Pool;
}

export function registerInstallRoute(app: FastifyInstance, ctx: InstallContext): void {
  app.get('/install/status', async () => {
    return { installed: await isInstalled(ctx.pool) };
  });

  app.post('/install', async (request, reply) => {
    let body: InstallRequestBody;
    try {
      body = validateBody(request.body);
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: { code: 'invalid_request', message: err.message } });
      }
      throw err;
    }

    if (await isInstalled(ctx.pool)) {
      return reply.code(409).send({
        error: { code: 'already_installed', message: 'Hearth has already been installed' },
      });
    }

    const client: PoolClient = await ctx.pool.connect();
    try {
      await client.query('BEGIN');

      const sharedPool = client as unknown as Pool;
      const identityStore = new PostgresIdentityStore(sharedPool);
      const tupleStore = new PostgresTupleStore(sharedPool);

      const sysadmin = await identityStore.createUser({ displayName: body.sysadmin_display_name });
      await identityStore.createCredential({
        usrId: sysadmin.id,
        type: 'password',
        identifier: body.sysadmin_email,
        password: body.sysadmin_password,
      });

      const instId = generateHearthId('inst');
      await client.query(
        `INSERT INTO inst (id, mfa_policy, installed_by)
         VALUES ($1, $2, $3)`,
        [uuidFromHearthId(instId), body.mfa_policy, uuidFromHearthId(sysadmin.id)],
      );

      await tupleStore.createTuple({
        subjectType: 'usr',
        subjectId: sysadmin.id,
        relation: 'sysadmin',
        objectType: 'inst',
        objectId: instId,
        createdBy: sysadmin.id,
      });

      await client.query('COMMIT');

      return reply.code(201).send({
        inst: { id: instId, mfa_policy: body.mfa_policy },
        sysadmin: {
          id: sysadmin.id,
          email: body.sysadmin_email,
          display_name: body.sysadmin_display_name,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}
