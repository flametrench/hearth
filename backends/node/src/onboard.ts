import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { PostgresIdentityStore } from '@flametrench/identity/postgres';
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
 * Sequentially calls identityStore.createUser → createCredential →
 * tenancyStore.createOrg(name+slug) → identityStore.createSession.
 *
 * Not wrapped in a shared transaction because Node's
 * PostgresTenancyStore.createOrg and PostgresIdentityStore.createSession
 * internally call `this.pool.connect()` for their own BEGIN/COMMIT, which
 * fails when handed a PoolClient. The PHP onboard endpoint is fully
 * atomic — its SDKs use `nested()` and SAVEPOINTs.
 *
 * Pre-checks slug to short-circuit before doing irreversible work; orphan
 * cleanup on later failures is best-effort. See backends/node/README.md
 * for the SDK-gap note.
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

    const slugTaken = await ctx.pool.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM org WHERE slug = $1) AS exists`,
      [body.org_slug],
    );
    if (slugTaken.rows[0]?.exists) {
      return reply.code(409).send({
        error: { code: 'slug_taken', message: `Org slug '${body.org_slug}' is already taken` },
      });
    }

    const identityStore = new PostgresIdentityStore(ctx.pool);
    const tenancyStore = new PostgresTenancyStore(ctx.pool);

    const usr = await identityStore.createUser({ displayName: body.display_name });
    let cred;
    try {
      cred = await identityStore.createCredential({
        usrId: usr.id,
        type: 'password',
        identifier: body.email,
        password: body.password,
      });
    } catch (err) {
      if (err instanceof Error && /identifier|already exists|conflict/i.test(err.message)) {
        return reply.code(409).send({
          error: { code: 'email_taken', message: `Email '${body.email}' already has a credential` },
        });
      }
      throw err;
    }

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
  });
}
