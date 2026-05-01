import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { ShareStore } from '@flametrench/authz';
import { generateHearthId, uuidFromHearthId } from './ids.js';
import { buildShareAuthHook } from './share-auth.js';
import { findOrgBySlug, listOrgAdminEmails } from './orgs.js';
import type { Mailer } from './email.js';

const SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface CustomerContext {
  pool: Pool;
  shareStore: ShareStore;
  mailer: Mailer;
}

interface SubmitBody {
  org_slug: string;
  customer_email: string;
  subject: string;
  body: string;
}

interface CommentBody {
  body: string;
}

class ValidationError extends Error {}

function validateSubmit(body: unknown): SubmitBody {
  if (!body || typeof body !== 'object') {
    throw new ValidationError('body must be a JSON object');
  }
  const b = body as Record<string, unknown>;
  if (typeof b.org_slug !== 'string' || !b.org_slug) {
    throw new ValidationError('org_slug is required');
  }
  if (typeof b.customer_email !== 'string' || !b.customer_email.includes('@')) {
    throw new ValidationError('customer_email must be an email string');
  }
  if (typeof b.subject !== 'string' || !b.subject.trim()) {
    throw new ValidationError('subject is required');
  }
  if (typeof b.body !== 'string' || !b.body.trim()) {
    throw new ValidationError('body is required');
  }
  if (b.subject.length > 200) {
    throw new ValidationError('subject must be 200 characters or fewer');
  }
  if (b.body.length > 20_000) {
    throw new ValidationError('body must be 20000 characters or fewer');
  }
  return {
    org_slug: b.org_slug,
    customer_email: b.customer_email,
    subject: b.subject.trim(),
    body: b.body.trim(),
  };
}

function validateComment(body: unknown): CommentBody {
  if (!body || typeof body !== 'object') {
    throw new ValidationError('body must be a JSON object');
  }
  const b = body as Record<string, unknown>;
  if (typeof b.body !== 'string' || !b.body.trim()) {
    throw new ValidationError('body is required');
  }
  if (b.body.length > 20_000) {
    throw new ValidationError('body must be 20000 characters or fewer');
  }
  return { body: b.body.trim() };
}

async function getInstalledByUuid(pool: Pool): Promise<string | null> {
  const { rows } = await pool.query<{ installed_by: string }>(
    `SELECT installed_by::text AS installed_by FROM inst LIMIT 1`,
  );
  return rows[0]?.installed_by ?? null;
}

function uuidToWire<P extends string>(prefix: P, uuid: string): `${P}_${string}` {
  return `${prefix}_${uuid.replaceAll('-', '')}` as `${P}_${string}`;
}

function normalizeObjectIdToUuid(objectId: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(objectId)) {
    return objectId;
  }
  return uuidFromHearthId(objectId);
}

interface TicketRow {
  id: string;
  org_id: string;
  customer_email: string;
  subject: string;
  body: string;
  status: 'open' | 'pending' | 'resolved';
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CommentRow {
  id: string;
  ticket_id: string;
  source: 'agent' | 'customer';
  author_usr_id: string | null;
  body: string;
  created_at: string;
}

async function loadTicketByUuid(pool: Pool, ticketUuid: string): Promise<TicketRow | null> {
  const { rows } = await pool.query<TicketRow>(
    `SELECT id::text AS id, org_id::text AS org_id, customer_email, subject, body, status,
            resolved_at, created_at, updated_at
       FROM ticket WHERE id = $1`,
    [ticketUuid],
  );
  return rows[0] ?? null;
}

async function listCommentsForTicket(pool: Pool, ticketUuid: string): Promise<CommentRow[]> {
  const { rows } = await pool.query<CommentRow>(
    `SELECT id::text AS id, ticket_id::text AS ticket_id, source,
            author_usr_id::text AS author_usr_id, body, created_at
       FROM comment WHERE ticket_id = $1 ORDER BY created_at ASC`,
    [ticketUuid],
  );
  return rows;
}

function serializeTicket(row: TicketRow): Record<string, unknown> {
  return {
    id: uuidToWire('ticket', row.id),
    org_id: uuidToWire('org', row.org_id),
    customer_email: row.customer_email,
    subject: row.subject,
    body: row.body,
    status: row.status,
    resolved_at: row.resolved_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function serializeComment(row: CommentRow): Record<string, unknown> {
  return {
    id: uuidToWire('comment', row.id),
    ticket_id: uuidToWire('ticket', row.ticket_id),
    source: row.source,
    author_usr_id: row.author_usr_id ? uuidToWire('usr', row.author_usr_id) : null,
    body: row.body,
    created_at: row.created_at,
  };
}

export function registerCustomerRoutes(app: FastifyInstance, ctx: CustomerContext): void {
  const shareAuth = buildShareAuthHook(ctx.shareStore);

  app.post('/tickets/submit', async (request, reply) => {
    let body: SubmitBody;
    try {
      body = validateSubmit(request.body);
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: { code: 'invalid_request', message: err.message } });
      }
      throw err;
    }

    const org = await findOrgBySlug(ctx.pool, body.org_slug);
    if (!org) {
      return reply
        .code(404)
        .send({
          error: { code: 'org_not_found', message: `No active org with slug '${body.org_slug}'` },
        });
    }

    const installedBy = await getInstalledByUuid(ctx.pool);
    if (!installedBy) {
      return reply
        .code(409)
        .send({ error: { code: 'not_installed', message: 'Hearth is not installed yet' } });
    }
    const sysadminWireId = uuidToWire('usr', installedBy);

    const ticketWireId = generateHearthId('ticket');
    const ticketUuid = uuidFromHearthId(ticketWireId);

    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO ticket (id, org_id, customer_email, subject, body)
         VALUES ($1, $2, $3, $4, $5)`,
        [ticketUuid, org.uuid, body.customer_email, body.subject, body.body],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const { share, token } = await ctx.shareStore.createShare({
      objectType: 'ticket',
      objectId: ticketWireId,
      relation: 'viewer',
      createdBy: sysadminWireId,
      expiresInSeconds: SHARE_TTL_SECONDS,
    });

    await ctx.mailer.sendShareLinkEmail({
      to: body.customer_email,
      orgName: org.name ?? org.slug ?? 'support',
      ticketSubject: body.subject,
      shareToken: token,
    });

    return reply.code(201).send({
      ticket: { id: ticketWireId, status: 'open' },
      share: { id: share.id, expires_at: share.expiresAt },
      share_url: ctx.mailer.shareUrl(token),
    });
  });

  app.register(async (instance) => {
    instance.addHook('onRequest', shareAuth);

    instance.get('/customer/ticket', async (request, reply) => {
      const verified = request.verifiedShare!;
      if (verified.objectType !== 'ticket') {
        return reply
          .code(403)
          .send({
            error: { code: 'wrong_resource', message: 'Share does not authorize a ticket view' },
          });
      }
      const ticketUuid = normalizeObjectIdToUuid(verified.objectId);
      const ticket = await loadTicketByUuid(ctx.pool, ticketUuid);
      if (!ticket) {
        return reply
          .code(404)
          .send({ error: { code: 'ticket_not_found', message: 'Ticket no longer exists' } });
      }
      const comments = await listCommentsForTicket(ctx.pool, ticketUuid);
      return reply.send({
        ticket: serializeTicket(ticket),
        comments: comments.map(serializeComment),
      });
    });

    instance.post('/customer/comment', async (request, reply) => {
      let parsed: CommentBody;
      try {
        parsed = validateComment(request.body);
      } catch (err) {
        if (err instanceof ValidationError) {
          return reply.code(400).send({ error: { code: 'invalid_request', message: err.message } });
        }
        throw err;
      }
      const verified = request.verifiedShare!;
      if (verified.objectType !== 'ticket') {
        return reply
          .code(403)
          .send({
            error: { code: 'wrong_resource', message: 'Share does not authorize a ticket reply' },
          });
      }
      const ticketUuid = normalizeObjectIdToUuid(verified.objectId);

      let savedComment: CommentRow | null = null;
      let reopened = false;
      let ticketAfter: TicketRow | null = null;

      const client = await ctx.pool.connect();
      try {
        await client.query('BEGIN');

        const lockRes = await client.query<{
          status: TicketRow['status'];
          org_id: string;
          customer_email: string;
          subject: string;
        }>(
          `SELECT status, org_id::text AS org_id, customer_email, subject
             FROM ticket WHERE id = $1 FOR UPDATE`,
          [ticketUuid],
        );
        if (lockRes.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply
            .code(404)
            .send({ error: { code: 'ticket_not_found', message: 'Ticket no longer exists' } });
        }
        const lock = lockRes.rows[0]!;
        const wasResolved = lock.status === 'resolved';

        const commentWireId = generateHearthId('comment');
        const commentUuid = uuidFromHearthId(commentWireId);
        const commentInsert = await client.query<CommentRow>(
          `INSERT INTO comment (id, ticket_id, source, author_usr_id, body)
           VALUES ($1, $2, 'customer', NULL, $3)
           RETURNING id::text AS id, ticket_id::text AS ticket_id, source,
                     author_usr_id::text AS author_usr_id, body, created_at`,
          [commentUuid, ticketUuid, parsed.body],
        );
        savedComment = commentInsert.rows[0]!;

        const newStatus = wasResolved ? 'open' : lock.status;
        const update = await client.query<TicketRow>(
          `UPDATE ticket
              SET status = $2,
                  resolved_at = CASE WHEN $2 = 'resolved' THEN resolved_at ELSE NULL END,
                  updated_at = now()
            WHERE id = $1
            RETURNING id::text AS id, org_id::text AS org_id, customer_email, subject, body,
                      status, resolved_at, created_at, updated_at`,
          [ticketUuid, newStatus],
        );
        ticketAfter = update.rows[0]!;
        reopened = wasResolved;

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      const adminEmails = await listOrgAdminEmails(ctx.pool, ticketAfter!.org_id);
      const orgRow = await ctx.pool.query<{ name: string | null; slug: string | null }>(
        `SELECT name, slug FROM org WHERE id = $1`,
        [ticketAfter!.org_id],
      );
      const orgName = orgRow.rows[0]?.name ?? orgRow.rows[0]?.slug ?? 'support';

      await ctx.mailer.sendCustomerReplyNotification({
        to: adminEmails,
        orgName,
        ticketSubject: ticketAfter!.subject,
        customerEmail: ticketAfter!.customer_email,
        reopened,
      });

      return reply.code(201).send({
        comment: serializeComment(savedComment!),
        ticket: serializeTicket(ticketAfter!),
        reopened,
      });
    });
  });
}
