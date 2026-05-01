import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { DuplicateCredentialError } from '@flametrench/identity';
import { PostgresIdentityStore } from '@flametrench/identity/postgres';
import { OrgSlugConflictError } from '@flametrench/tenancy';
import { PostgresTenancyStore } from '@flametrench/tenancy/postgres';

const SESSION_TTL_SECONDS = 3600;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

interface OnboardBody {
  display_name: string;
  email: string;
  password: string;
  org_name: string;
  org_slug: string;
}

class ValidationError extends Error {}

function validate(body: unknown): OnboardBody {
  if (!body || typeof body !== 'object') {
    throw new ValidationError('body must be a JSON object');
  }
  const b = body as Record<string, unknown>;
  if (typeof b.display_name !== 'string' || !b.display_name.trim()) {
    throw new ValidationError('display_name is required');
  }
  if (typeof b.email !== 'string' || !b.email.includes('@')) {
    throw new ValidationError('email must be an email string');
  }
  if (typeof b.password !== 'string' || b.password.length < 8) {
    throw new ValidationError('password must be a string of at least 8 characters');
  }
  if (typeof b.org_name !== 'string' || !b.org_name.trim()) {
    throw new ValidationError('org_name is required');
  }
  if (typeof b.org_slug !== 'string' || !SLUG_PATTERN.test(b.org_slug)) {
    throw new ValidationError('org_slug must match ^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$');
  }
  return {
    display_name: b.display_name.trim(),
    email: b.email,
    password: b.password,
    org_name: b.org_name.trim(),
    org_slug: b.org_slug,
  };
}

export interface OnboardContext {
  pool: Pool;
}

/**
 * Atomic agent + org onboarding via the shared-client pattern. The Node
 * SDKs at `@flametrench/{identity,tenancy}@^0.2.1` cooperate with a
 * caller-owned PoolClient via SAVEPOINT/RELEASE for their multi-statement
 * methods (createOrg, createSession, etc.) — see ADR 0013.
 *
 * Sequence: createUser → createPasswordCredential → createOrg(name+slug)
 * → createSession, all on the same client between BEGIN and COMMIT. If
 * any step fails, ROLLBACK undoes everything.
 */
export function registerOnboardRoute(app: FastifyInstance, ctx: OnboardContext): void {
  app.post('/onboard', async (request, reply) => {
    let body: OnboardBody;
    try {
      body = validate(request.body);
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: { code: 'invalid_request', message: err.message } });
      }
      throw err;
    }

    const client: PoolClient = await ctx.pool.connect();
    try {
      await client.query('BEGIN');

      const sharedPool = client as unknown as Pool;
      const identityStore = new PostgresIdentityStore(sharedPool);
      const tenancyStore = new PostgresTenancyStore(sharedPool);

      const usr = await identityStore.createUser({ displayName: body.display_name });
      const cred = await identityStore.createCredential({
        usrId: usr.id,
        type: 'password',
        identifier: body.email,
        password: body.password,
      });
      const orgResult = await tenancyStore.createOrg({
        creator: usr.id,
        name: body.org_name,
        slug: body.org_slug,
      });
      const sessionResult = await identityStore.createSession({
        usrId: usr.id,
        credId: cred.id,
        ttlSeconds: SESSION_TTL_SECONDS,
      });

      await client.query('COMMIT');

      return reply.code(201).send({
        usr: {
          id: usr.id,
          display_name: body.display_name,
          email: body.email,
        },
        org: {
          id: orgResult.org.id,
          name: orgResult.org.name,
          slug: orgResult.org.slug,
        },
        session: {
          id: sessionResult.session.id,
          token: sessionResult.token,
          expires_at: sessionResult.session.expiresAt,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err instanceof OrgSlugConflictError) {
        return reply.code(409).send({
          error: { code: 'slug_taken', message: `Org slug '${body.org_slug}' is already taken` },
        });
      }
      if (err instanceof DuplicateCredentialError) {
        return reply.code(409).send({
          error: { code: 'email_taken', message: `Email '${body.email}' already has a credential` },
        });
      }
      throw err;
    } finally {
      client.release();
    }
  });
}
