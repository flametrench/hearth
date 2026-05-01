<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Support\HearthIds;
use App\Support\HearthMailer;
use App\Support\OrgRepository;
use Flametrench\Authz\ShareStore;
use Flametrench\Authz\TupleStore;
use Flametrench\Identity\Session;
use Flametrench\Tenancy\TenancyStore;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Throwable;

class AgentController
{
    private const SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;

    private const ORG_ROLES = ['owner', 'admin', 'member'];

    private const ORG_ADMINS = ['owner', 'admin'];

    public function __construct(
        private readonly ShareStore $shareStore,
        private readonly TupleStore $tupleStore,
        private readonly TenancyStore $tenancyStore,
        private readonly OrgRepository $orgs,
        private readonly HearthMailer $mailer,
    ) {}

    public function inbox(Request $request, string $slug): JsonResponse
    {
        $session = $this->session($request);
        $org = $this->orgs->findBySlug($slug);
        if (! $org) {
            return response()->json([
                'error' => ['code' => 'org_not_found', 'message' => 'Org not found'],
            ], 404);
        }
        if (! $this->checkOrgRole($session->usrId, $org->wireId, self::ORG_ROLES)) {
            return response()->json([
                'error' => ['code' => 'forbidden', 'message' => 'Not a member of this org'],
            ], 403);
        }
        $status = (string) $request->query('status', 'all');
        $valid = ['all', 'open', 'pending', 'resolved'];
        if (! in_array($status, $valid, true)) {
            return response()->json([
                'error' => ['code' => 'invalid_request', 'message' => 'status must be one of all|open|pending|resolved'],
            ], 400);
        }
        if ($status === 'all') {
            $rows = DB::select(
                'SELECT id::text AS id, org_id::text AS org_id, customer_email, subject, body,
                        status, resolved_at, created_at, updated_at
                   FROM ticket WHERE org_id = ?
                   ORDER BY updated_at DESC LIMIT 50',
                [$org->uuid],
            );
        } else {
            $rows = DB::select(
                'SELECT id::text AS id, org_id::text AS org_id, customer_email, subject, body,
                        status, resolved_at, created_at, updated_at
                   FROM ticket WHERE org_id = ? AND status = ?
                   ORDER BY updated_at DESC LIMIT 50',
                [$org->uuid, $status],
            );
        }

        return response()->json([
            'tickets' => array_map([$this, 'serializeTicket'], $rows),
            'org' => ['id' => $org->wireId, 'name' => $org->name, 'slug' => $org->slug],
        ]);
    }

    public function ticketDetail(Request $request, string $ticketId): JsonResponse
    {
        $session = $this->session($request);
        $ticketUuid = HearthIds::toUuid($ticketId);
        $ticket = $this->loadTicket($ticketUuid);
        if (! $ticket) {
            return response()->json(['error' => ['code' => 'ticket_not_found', 'message' => 'Ticket not found']], 404);
        }
        $orgWire = HearthIds::fromUuid('org', $ticket->org_id);
        if (! $this->checkOrgRole($session->usrId, $orgWire, self::ORG_ROLES)) {
            return response()->json(['error' => ['code' => 'forbidden', 'message' => "Not a member of this ticket's org"]], 403);
        }
        $comments = DB::select(
            'SELECT id::text AS id, ticket_id::text AS ticket_id, source,
                    author_usr_id::text AS author_usr_id, body, created_at
               FROM comment WHERE ticket_id = ? ORDER BY created_at ASC',
            [$ticketUuid],
        );
        $shares = DB::select(
            "SELECT id::text AS id, expires_at::text AS expires_at,
                    revoked_at::text AS revoked_at, consumed_at::text AS consumed_at
               FROM shr WHERE object_type = 'ticket' AND object_id = ?
               ORDER BY created_at DESC",
            [$ticketUuid],
        );

        return response()->json([
            'ticket' => $this->serializeTicket($ticket),
            'comments' => array_map([$this, 'serializeComment'], $comments),
            'shares' => array_map([$this, 'serializeShare'], $shares),
        ]);
    }

    public function comment(Request $request, string $ticketId): JsonResponse
    {
        $input = $request->validate(['body' => 'required|string|max:20000']);
        $session = $this->session($request);
        $ticketUuid = HearthIds::toUuid($ticketId);
        $ticket = $this->loadTicket($ticketUuid);
        if (! $ticket) {
            return response()->json(['error' => ['code' => 'ticket_not_found', 'message' => 'Ticket not found']], 404);
        }
        $orgWire = HearthIds::fromUuid('org', $ticket->org_id);
        if (! $this->checkOrgRole($session->usrId, $orgWire, self::ORG_ROLES)) {
            return response()->json(['error' => ['code' => 'forbidden', 'message' => "Not a member of this ticket's org"]], 403);
        }
        $body = trim($input['body']);
        $commentWireId = HearthIds::generate('comment');
        $commentUuid = HearthIds::toUuid($commentWireId);
        $authorUuid = HearthIds::toUuid($session->usrId);

        DB::transaction(function () use ($ticketUuid, $commentUuid, $authorUuid, $body): void {
            DB::insert(
                "INSERT INTO comment (id, ticket_id, source, author_usr_id, body)
                 VALUES (?, ?, 'agent', ?, ?)",
                [$commentUuid, $ticketUuid, $authorUuid, $body],
            );
            DB::update(
                "UPDATE ticket SET status = CASE WHEN status = 'open' THEN 'pending' ELSE status END,
                                  updated_at = now()
                  WHERE id = ?",
                [$ticketUuid],
            );
        });

        $refreshed = $this->loadTicket($ticketUuid);

        return response()->json([
            'comment' => [
                'id' => $commentWireId,
                'ticket_id' => $ticketId,
                'source' => 'agent',
                'author_usr_id' => $session->usrId,
                'body' => $body,
            ],
            'ticket' => $refreshed ? $this->serializeTicket($refreshed) : null,
        ], 201);
    }

    public function assign(Request $request, string $ticketId): JsonResponse
    {
        $input = $request->validate(['assignee_usr_id' => 'required|string|regex:/^usr_[0-9a-f]{32}$/']);
        $session = $this->session($request);
        $ticketUuid = HearthIds::toUuid($ticketId);
        $ticket = $this->loadTicket($ticketUuid);
        if (! $ticket) {
            return response()->json(['error' => ['code' => 'ticket_not_found', 'message' => 'Ticket not found']], 404);
        }
        $orgWire = HearthIds::fromUuid('org', $ticket->org_id);
        if (! $this->checkOrgRole($session->usrId, $orgWire, self::ORG_ROLES)) {
            return response()->json(['error' => ['code' => 'forbidden', 'message' => "Not a member of this ticket's org"]], 403);
        }
        if (! $this->checkOrgRole($input['assignee_usr_id'], $orgWire, self::ORG_ROLES)) {
            return response()->json(['error' => ['code' => 'invalid_assignee', 'message' => 'Assignee is not a member of this org']], 400);
        }

        try {
            $this->tupleStore->createTuple(
                subjectType: 'usr',
                subjectId: $input['assignee_usr_id'],
                relation: 'assignee',
                objectType: 'ticket',
                objectId: $ticketId,
                createdBy: $session->usrId,
            );
        } catch (Throwable $e) {
            if (! str_contains((string) $e->getMessage(), 'already exists')) {
                throw $e;
            }
        }

        DB::update('UPDATE ticket SET updated_at = now() WHERE id = ?', [$ticketUuid]);
        $refreshed = $this->loadTicket($ticketUuid);

        return response()->json([
            'assignment' => [
                'ticket_id' => $ticketId,
                'assignee_usr_id' => $input['assignee_usr_id'],
                'relation' => 'assignee',
            ],
            'ticket' => $refreshed ? $this->serializeTicket($refreshed) : null,
        ]);
    }

    public function resolve(Request $request, string $ticketId): JsonResponse
    {
        return $this->setStatus($request, $ticketId, 'resolved', 'now()');
    }

    public function reopen(Request $request, string $ticketId): JsonResponse
    {
        return $this->setStatus($request, $ticketId, 'open', 'NULL');
    }

    public function mintShare(Request $request, string $ticketId): JsonResponse
    {
        $resend = $request->boolean('resend_email', true);
        $session = $this->session($request);
        $ticketUuid = HearthIds::toUuid($ticketId);
        $ticket = $this->loadTicket($ticketUuid);
        if (! $ticket) {
            return response()->json(['error' => ['code' => 'ticket_not_found', 'message' => 'Ticket not found']], 404);
        }
        $orgWire = HearthIds::fromUuid('org', $ticket->org_id);
        if (! $this->checkOrgRole($session->usrId, $orgWire, self::ORG_ADMINS)) {
            return response()->json(['error' => ['code' => 'forbidden', 'message' => 'Only org admins can mint share tokens']], 403);
        }
        $result = $this->shareStore->createShare(
            objectType: 'ticket',
            objectId: $ticketId,
            relation: 'viewer',
            createdBy: $session->usrId,
            expiresInSeconds: self::SHARE_TTL_SECONDS,
        );
        if ($resend) {
            $orgName = $this->orgs->nameByUuid($ticket->org_id);
            $this->mailer->sendShareLinkEmail($ticket->customer_email, $orgName, $ticket->subject, $result->token);
        }

        return response()->json([
            'share' => ['id' => $result->share->id, 'expires_at' => $result->share->expiresAt->format(\DATE_ATOM)],
            'share_url' => $this->mailer->shareUrl($result->token),
        ], 201);
    }

    public function revokeShare(Request $request, string $shrId): JsonResponse
    {
        if (! str_starts_with($shrId, 'shr_')) {
            return response()->json(['error' => ['code' => 'invalid_request', 'message' => 'Path must be a shr_<32hex> id']], 400);
        }
        $session = $this->session($request);
        try {
            $share = $this->shareStore->getShare($shrId);
        } catch (Throwable) {
            return response()->json(['error' => ['code' => 'share_not_found', 'message' => 'Share not found']], 404);
        }
        if ($share->objectType !== 'ticket') {
            return response()->json(['error' => ['code' => 'wrong_resource', 'message' => 'Share does not reference a ticket']], 400);
        }
        $ticketUuid = preg_match('/^[0-9a-f-]{36}$/', $share->objectId)
            ? $share->objectId
            : HearthIds::toUuid($share->objectId);
        $ticket = $this->loadTicket($ticketUuid);
        if (! $ticket) {
            return response()->json(['error' => ['code' => 'ticket_not_found', 'message' => 'Ticket no longer exists']], 404);
        }
        $orgWire = HearthIds::fromUuid('org', $ticket->org_id);
        if (! $this->checkOrgRole($session->usrId, $orgWire, self::ORG_ADMINS)) {
            return response()->json(['error' => ['code' => 'forbidden', 'message' => 'Only org admins can revoke shares']], 403);
        }
        $revoked = $this->shareStore->revokeShare($shrId);

        return response()->json([
            'share' => [
                'id' => $revoked->id,
                'revoked_at' => $revoked->revokedAt?->format(\DATE_ATOM),
                'expires_at' => $revoked->expiresAt->format(\DATE_ATOM),
            ],
        ]);
    }

    public function orgSettings(Request $request, string $orgId): JsonResponse
    {
        if (! str_starts_with($orgId, 'org_')) {
            return response()->json(['error' => ['code' => 'invalid_request', 'message' => 'Path must be an org_<32hex> id']], 400);
        }
        $session = $this->session($request);
        if (! $this->checkOrgRole($session->usrId, $orgId, self::ORG_ADMINS)) {
            return response()->json(['error' => ['code' => 'forbidden', 'message' => 'Only org admins can update settings']], 403);
        }
        $input = $request->validate([
            'name' => 'sometimes|nullable|string',
            'slug' => 'sometimes|nullable|string',
        ]);
        $updated = $this->tenancyStore->updateOrg(
            orgId: $orgId,
            name: $input['name'] ?? null,
            slug: $input['slug'] ?? null,
        );

        return response()->json([
            'org' => [
                'id' => $updated->id,
                'name' => $updated->name,
                'slug' => $updated->slug,
            ],
        ]);
    }

    private function setStatus(Request $request, string $ticketId, string $status, string $resolvedAtSql): JsonResponse
    {
        $session = $this->session($request);
        $ticketUuid = HearthIds::toUuid($ticketId);
        $ticket = $this->loadTicket($ticketUuid);
        if (! $ticket) {
            return response()->json(['error' => ['code' => 'ticket_not_found', 'message' => 'Ticket not found']], 404);
        }
        $orgWire = HearthIds::fromUuid('org', $ticket->org_id);
        if (! $this->checkOrgRole($session->usrId, $orgWire, self::ORG_ROLES)) {
            return response()->json(['error' => ['code' => 'forbidden', 'message' => "Not a member of this ticket's org"]], 403);
        }
        $row = DB::selectOne(
            "UPDATE ticket SET status = ?, resolved_at = $resolvedAtSql, updated_at = now()
              WHERE id = ?
              RETURNING id::text AS id, org_id::text AS org_id, customer_email, subject, body,
                        status, resolved_at, created_at, updated_at",
            [$status, $ticketUuid],
        );

        return response()->json(['ticket' => $this->serializeTicket($row)]);
    }

    private function session(Request $request): Session
    {
        return $request->attributes->get('session');
    }

    private function checkOrgRole(string $usrWireId, string $orgWireId, array $relations): bool
    {
        $result = $this->tupleStore->checkAny(
            subjectType: 'usr',
            subjectId: $usrWireId,
            relations: $relations,
            objectType: 'org',
            objectId: $orgWireId,
        );

        return $result->allowed;
    }

    private function loadTicket(string $ticketUuid): ?object
    {
        return DB::selectOne(
            'SELECT id::text AS id, org_id::text AS org_id, customer_email, subject, body, status,
                    resolved_at, created_at, updated_at
               FROM ticket WHERE id = ?',
            [$ticketUuid],
        );
    }

    private function serializeTicket(object $row): array
    {
        return [
            'id' => HearthIds::fromUuid('ticket', $row->id),
            'org_id' => HearthIds::fromUuid('org', $row->org_id),
            'customer_email' => $row->customer_email,
            'subject' => $row->subject,
            'body' => $row->body,
            'status' => $row->status,
            'resolved_at' => $row->resolved_at,
            'created_at' => $row->created_at,
            'updated_at' => $row->updated_at,
        ];
    }

    private function serializeComment(object $row): array
    {
        return [
            'id' => HearthIds::fromUuid('comment', $row->id),
            'ticket_id' => HearthIds::fromUuid('ticket', $row->ticket_id),
            'source' => $row->source,
            'author_usr_id' => $row->author_usr_id ? HearthIds::fromUuid('usr', $row->author_usr_id) : null,
            'body' => $row->body,
            'created_at' => $row->created_at,
        ];
    }

    private function serializeShare(object $row): array
    {
        return [
            'id' => HearthIds::fromUuid('shr', $row->id),
            'expires_at' => $row->expires_at,
            'revoked_at' => $row->revoked_at,
            'consumed_at' => $row->consumed_at,
        ];
    }
}
