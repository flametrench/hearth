import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { IdentityStore } from '@flametrench/identity';
import type { ShareStore, TupleStore } from '@flametrench/authz';
import { buildBearerAuthHook, requireSession } from '@flametrench/server';

import { generateHearthId, uuidFromHearthId } from './ids.js';
import { findOrgBySlug } from './orgs.js';
import type { Mailer } from './email.js';

const SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;

const ORG_ROLE_RELATIONS = ['owner', 'admin', 'member'];
const ORG_ADMIN_RELATIONS = ['owner', 'admin'];

type TicketStatus = 'open' | 'pending' | 'resolved';

export interface AgentContext {
  pool: Pool;
  identityStore: IdentityStore;
  tupleStore: TupleStore;
  shareStore: ShareStore;
  mailer: Mailer;
}

function uuidToWire<P extends string>(prefix: P, uuid: string): `${P}_${string}` {
  return `${prefix}_${uuid.replaceAll('-', '')}` as `${P}_${string}`;
}

interface TicketRow {
  id: string;
  org_id: string;
  customer_email: string;
  subject: string;
  body: string;
  status: TicketStatus;
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

interface ShareRowSummary {
  id: string;
  expires_at: string;
  revoked_at: string | null;
  consumed_at: string | null;
}

const TICKET_COLS = `id::text AS id, org_id::text AS org_id, customer_email, subject, body,
                     status, resolved_at, created_at, updated_at`;

async function loadTicketByUuid(pool: Pool, ticketUuid: string): Promise<TicketRow | null> {
  const { rows } = await pool.query<TicketRow>(`SELECT ${TICKET_COLS} FROM ticket WHERE id = $1`, [
    ticketUuid,
  ]);
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

async function listSharesForTicket(pool: Pool, ticketUuid: string): Promise<ShareRowSummary[]> {
  const { rows } = await pool.query<ShareRowSummary>(
    `SELECT id::text AS id, expires_at::text AS expires_at,
            revoked_at::text AS revoked_at, consumed_at::text AS consumed_at
       FROM shr
      WHERE object_type = 'ticket' AND object_id = $1
      ORDER BY created_at DESC`,
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

function serializeShare(row: ShareRowSummary): Record<string, unknown> {
  return {
    id: uuidToWire('shr', row.id),
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    consumed_at: row.consumed_at,
  };
}

async function checkOrgRole(
  ctx: AgentContext,
  usrId: `usr_${string}`,
  orgId: `org_${string}`,
  relations: string[],
): Promise<boolean> {
  const result = await ctx.tupleStore.checkAny({
    subjectType: 'usr',
    subjectId: usrId,
    relations,
    objectType: 'org',
    objectId: orgId,
  });
  return result.allowed;
}

async function getOrgNameByUuid(pool: Pool, orgUuid: string): Promise<string> {
  const { rows } = await pool.query<{ name: string | null; slug: string | null }>(
    `SELECT name, slug FROM org WHERE id = $1`,
    [orgUuid],
  );
  return rows[0]?.name ?? rows[0]?.slug ?? 'support';
}

export function registerAgentRoutes(app: FastifyInstance, ctx: AgentContext): void {
  const auth = buildBearerAuthHook({
    identityStore: ctx.identityStore,
    tenancyStore: undefined as never,
    tupleStore: ctx.tupleStore,
  });

  app.register(async (instance) => {
    instance.addHook('onRequest', auth);

    instance.get<{ Params: { slug: string }; Querystring: { status?: string } }>(
      '/orgs/:slug/tickets',
      async (request, reply) => {
        const session = requireSession(request);
        const org = await findOrgBySlug(ctx.pool, request.params.slug);
        if (!org) {
          return reply
            .code(404)
            .send({ error: { code: 'org_not_found', message: 'Org not found' } });
        }
        const allowed = await checkOrgRole(
          ctx,
          session.usrId,
          uuidToWire('org', org.uuid),
          ORG_ROLE_RELATIONS,
        );
        if (!allowed) {
          return reply
            .code(403)
            .send({ error: { code: 'forbidden', message: 'Not a member of this org' } });
        }

        const status = request.query.status;
        const filterAll = !status || status === 'all';
        if (!filterAll && status !== 'open' && status !== 'pending' && status !== 'resolved') {
          return reply.code(400).send({
            error: {
              code: 'invalid_request',
              message: `status must be one of all|open|pending|resolved`,
            },
          });
        }

        const params: unknown[] = [org.uuid];
        let where = `org_id = $1`;
        if (!filterAll) {
          params.push(status);
          where += ` AND status = $2`;
        }
        const { rows } = await ctx.pool.query<TicketRow>(
          `SELECT ${TICKET_COLS} FROM ticket WHERE ${where}
           ORDER BY updated_at DESC LIMIT 50`,
          params,
        );

        return reply.send({
          tickets: rows.map(serializeTicket),
          org: { id: uuidToWire('org', org.uuid), name: org.name, slug: org.slug },
        });
      },
    );

    instance.get<{ Params: { ticket_id: string } }>(
      '/tickets/:ticket_id',
      async (request, reply) => {
        const session = requireSession(request);
        const ticketUuid = uuidFromHearthId(request.params.ticket_id);
        const ticket = await loadTicketByUuid(ctx.pool, ticketUuid);
        if (!ticket) {
          return reply
            .code(404)
            .send({ error: { code: 'ticket_not_found', message: 'Ticket not found' } });
        }
        const allowed = await checkOrgRole(
          ctx,
          session.usrId,
          uuidToWire('org', ticket.org_id),
          ORG_ROLE_RELATIONS,
        );
        if (!allowed) {
          return reply
            .code(403)
            .send({ error: { code: 'forbidden', message: "Not a member of this ticket's org" } });
        }
        const [comments, shares] = await Promise.all([
          listCommentsForTicket(ctx.pool, ticketUuid),
          listSharesForTicket(ctx.pool, ticketUuid),
        ]);
        return reply.send({
          ticket: serializeTicket(ticket),
          comments: comments.map(serializeComment),
          shares: shares.map(serializeShare),
        });
      },
    );

    instance.post<{ Params: { ticket_id: string }; Body: { body: string } }>(
      '/tickets/:ticket_id/comment',
      async (request, reply) => {
        const session = requireSession(request);
        const body = request.body;
        if (!body || typeof body.body !== 'string' || !body.body.trim()) {
          return reply
            .code(400)
            .send({ error: { code: 'invalid_request', message: 'body is required' } });
        }
        if (body.body.length > 20_000) {
          return reply
            .code(400)
            .send({
              error: { code: 'invalid_request', message: 'body must be 20000 characters or fewer' },
            });
        }

        const ticketUuid = uuidFromHearthId(request.params.ticket_id);
        const ticket = await loadTicketByUuid(ctx.pool, ticketUuid);
        if (!ticket) {
          return reply
            .code(404)
            .send({ error: { code: 'ticket_not_found', message: 'Ticket not found' } });
        }
        const allowed = await checkOrgRole(
          ctx,
          session.usrId,
          uuidToWire('org', ticket.org_id),
          ORG_ROLE_RELATIONS,
        );
        if (!allowed) {
          return reply
            .code(403)
            .send({ error: { code: 'forbidden', message: "Not a member of this ticket's org" } });
        }

        const commentWireId = generateHearthId('comment');
        const commentUuid = uuidFromHearthId(commentWireId);
        const trimmed = body.body.trim();

        const client = await ctx.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `INSERT INTO comment (id, ticket_id, source, author_usr_id, body)
             VALUES ($1, $2, 'agent', $3, $4)`,
            [commentUuid, ticketUuid, uuidFromHearthId(session.usrId), trimmed],
          );
          await client.query(
            `UPDATE ticket SET status = CASE WHEN status = 'open' THEN 'pending' ELSE status END,
                               updated_at = now()
              WHERE id = $1`,
            [ticketUuid],
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }

        const refreshed = await loadTicketByUuid(ctx.pool, ticketUuid);
        return reply.code(201).send({
          comment: {
            id: commentWireId,
            ticket_id: request.params.ticket_id,
            source: 'agent',
            author_usr_id: session.usrId,
            body: trimmed,
          },
          ticket: refreshed ? serializeTicket(refreshed) : null,
        });
      },
    );

    instance.post<{ Params: { ticket_id: string }; Body: { assignee_usr_id: string } }>(
      '/tickets/:ticket_id/assign',
      async (request, reply) => {
        const session = requireSession(request);
        const assigneeWire = request.body?.assignee_usr_id;
        if (typeof assigneeWire !== 'string' || !assigneeWire.startsWith('usr_')) {
          return reply
            .code(400)
            .send({
              error: {
                code: 'invalid_request',
                message: 'assignee_usr_id must be a usr_<32hex> id',
              },
            });
        }

        const ticketUuid = uuidFromHearthId(request.params.ticket_id);
        const ticket = await loadTicketByUuid(ctx.pool, ticketUuid);
        if (!ticket) {
          return reply
            .code(404)
            .send({ error: { code: 'ticket_not_found', message: 'Ticket not found' } });
        }
        const orgWire = uuidToWire('org', ticket.org_id);
        const callerOk = await checkOrgRole(ctx, session.usrId, orgWire, ORG_ROLE_RELATIONS);
        if (!callerOk) {
          return reply
            .code(403)
            .send({ error: { code: 'forbidden', message: "Not a member of this ticket's org" } });
        }
        const assigneeOk = await checkOrgRole(
          ctx,
          assigneeWire as `usr_${string}`,
          orgWire,
          ORG_ROLE_RELATIONS,
        );
        if (!assigneeOk) {
          return reply
            .code(400)
            .send({
              error: { code: 'invalid_assignee', message: 'Assignee is not a member of this org' },
            });
        }

        try {
          await ctx.tupleStore.createTuple({
            subjectType: 'usr',
            subjectId: assigneeWire as `usr_${string}`,
            relation: 'assignee',
            objectType: 'ticket',
            objectId: request.params.ticket_id,
            createdBy: session.usrId,
          });
        } catch (err) {
          if (err instanceof Error && err.message.includes('already exists')) {
            // idempotent — ignore duplicate tuple
          } else {
            throw err;
          }
        }

        await ctx.pool.query(`UPDATE ticket SET updated_at = now() WHERE id = $1`, [ticketUuid]);
        const refreshed = await loadTicketByUuid(ctx.pool, ticketUuid);
        return reply.send({
          assignment: {
            ticket_id: request.params.ticket_id,
            assignee_usr_id: assigneeWire,
            relation: 'assignee',
          },
          ticket: refreshed ? serializeTicket(refreshed) : null,
        });
      },
    );

    const setStatus =
      (status: TicketStatus, resolvedAtSql: string) =>
      async (
        request: import('fastify').FastifyRequest<{ Params: { ticket_id: string } }>,
        reply: import('fastify').FastifyReply,
      ) => {
        const session = requireSession(request);
        const ticketUuid = uuidFromHearthId(request.params.ticket_id);
        const ticket = await loadTicketByUuid(ctx.pool, ticketUuid);
        if (!ticket) {
          return reply
            .code(404)
            .send({ error: { code: 'ticket_not_found', message: 'Ticket not found' } });
        }
        const allowed = await checkOrgRole(
          ctx,
          session.usrId,
          uuidToWire('org', ticket.org_id),
          ORG_ROLE_RELATIONS,
        );
        if (!allowed) {
          return reply
            .code(403)
            .send({ error: { code: 'forbidden', message: "Not a member of this ticket's org" } });
        }
        const { rows } = await ctx.pool.query<TicketRow>(
          `UPDATE ticket SET status = $2, resolved_at = ${resolvedAtSql}, updated_at = now()
            WHERE id = $1
            RETURNING ${TICKET_COLS}`,
          [ticketUuid, status],
        );
        return reply.send({ ticket: serializeTicket(rows[0]!) });
      };

    instance.post<{ Params: { ticket_id: string } }>(
      '/tickets/:ticket_id/resolve',
      setStatus('resolved', 'now()'),
    );
    instance.post<{ Params: { ticket_id: string } }>(
      '/tickets/:ticket_id/reopen',
      setStatus('open', 'NULL'),
    );

    instance.post<{ Params: { ticket_id: string }; Body: { resend_email?: boolean } }>(
      '/tickets/:ticket_id/share',
      async (request, reply) => {
        const session = requireSession(request);
        const ticketUuid = uuidFromHearthId(request.params.ticket_id);
        const ticket = await loadTicketByUuid(ctx.pool, ticketUuid);
        if (!ticket) {
          return reply
            .code(404)
            .send({ error: { code: 'ticket_not_found', message: 'Ticket not found' } });
        }
        const orgWire = uuidToWire('org', ticket.org_id);
        const adminOk = await checkOrgRole(ctx, session.usrId, orgWire, ORG_ADMIN_RELATIONS);
        if (!adminOk) {
          return reply
            .code(403)
            .send({
              error: { code: 'forbidden', message: 'Only org admins can mint share tokens' },
            });
        }

        const { share, token } = await ctx.shareStore.createShare({
          objectType: 'ticket',
          objectId: request.params.ticket_id,
          relation: 'viewer',
          createdBy: session.usrId,
          expiresInSeconds: SHARE_TTL_SECONDS,
        });

        if (request.body?.resend_email !== false) {
          const orgName = await getOrgNameByUuid(ctx.pool, ticket.org_id);
          await ctx.mailer.sendShareLinkEmail({
            to: ticket.customer_email,
            orgName,
            ticketSubject: ticket.subject,
            shareToken: token,
          });
        }

        return reply.code(201).send({
          share: { id: share.id, expires_at: share.expiresAt },
          share_url: ctx.mailer.shareUrl(token),
        });
      },
    );

    instance.post<{ Params: { shr_id: string } }>(
      '/shares/:shr_id/revoke',
      async (request, reply) => {
        const session = requireSession(request);
        const shrId = request.params.shr_id;
        if (!shrId.startsWith('shr_')) {
          return reply
            .code(400)
            .send({ error: { code: 'invalid_request', message: 'Path must be a shr_<32hex> id' } });
        }
        const share = await ctx.shareStore.getShare(shrId as `shr_${string}`).catch(() => null);
        if (!share) {
          return reply
            .code(404)
            .send({ error: { code: 'share_not_found', message: 'Share not found' } });
        }
        if (share.objectType !== 'ticket') {
          return reply
            .code(400)
            .send({
              error: { code: 'wrong_resource', message: 'Share does not reference a ticket' },
            });
        }
        const ticketUuid = (() => {
          if (
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(share.objectId)
          ) {
            return share.objectId;
          }
          return uuidFromHearthId(share.objectId);
        })();
        const ticket = await loadTicketByUuid(ctx.pool, ticketUuid);
        if (!ticket) {
          return reply
            .code(404)
            .send({ error: { code: 'ticket_not_found', message: 'Ticket no longer exists' } });
        }
        const orgWire = uuidToWire('org', ticket.org_id);
        const adminOk = await checkOrgRole(ctx, session.usrId, orgWire, ORG_ADMIN_RELATIONS);
        if (!adminOk) {
          return reply
            .code(403)
            .send({ error: { code: 'forbidden', message: 'Only org admins can revoke shares' } });
        }
        const revoked = await ctx.shareStore.revokeShare(shrId as `shr_${string}`);
        return reply.send({
          share: {
            id: revoked.id,
            revoked_at: revoked.revokedAt,
            expires_at: revoked.expiresAt,
          },
        });
      },
    );
  });
}
