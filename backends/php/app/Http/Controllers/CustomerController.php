<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Support\HearthIds;
use App\Support\HearthMailer;
use App\Support\OrgRepository;
use Flametrench\Authz\ShareStore;
use Flametrench\Authz\VerifiedShare;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class CustomerController
{
    private const SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;

    public function __construct(
        private readonly ShareStore $shareStore,
        private readonly OrgRepository $orgs,
        private readonly HearthMailer $mailer,
    ) {}

    public function submit(Request $request): JsonResponse
    {
        $input = $request->validate([
            'org_slug' => 'required|string',
            'customer_email' => 'required|email',
            'subject' => 'required|string|max:200',
            'body' => 'required|string|max:20000',
        ]);

        $org = $this->orgs->findBySlug($input['org_slug']);
        if (! $org) {
            return response()->json([
                'error' => ['code' => 'org_not_found', 'message' => "No active org with slug '{$input['org_slug']}'"],
            ], 404);
        }

        $installedBy = $this->orgs->installedByUuid();
        if (! $installedBy) {
            return response()->json([
                'error' => ['code' => 'not_installed', 'message' => 'Hearth is not installed yet'],
            ], 409);
        }
        $sysadminWireId = HearthIds::fromUuid('usr', $installedBy);

        $ticketWireId = HearthIds::generate('ticket');
        $ticketUuid = HearthIds::toUuid($ticketWireId);

        DB::transaction(function () use ($ticketUuid, $org, $input): void {
            DB::insert(
                'INSERT INTO ticket (id, org_id, customer_email, subject, body) VALUES (?, ?, ?, ?, ?)',
                [
                    $ticketUuid,
                    $org->uuid,
                    $input['customer_email'],
                    trim($input['subject']),
                    trim($input['body']),
                ],
            );
        });

        // C2 (security-audit-v0.3.md): the share's relation is
        // load-bearing — verifyShareToken returns it and the adopter
        // MUST gate write paths on it. 'commenter' (not 'viewer')
        // because this share authorizes BOTH reading the ticket AND
        // posting comments. Mirror with the Node backend.
        $result = $this->shareStore->createShare(
            objectType: 'ticket',
            objectId: $ticketWireId,
            relation: 'commenter',
            createdBy: $sysadminWireId,
            expiresInSeconds: self::SHARE_TTL_SECONDS,
        );

        $orgName = $org->name ?? $org->slug ?? 'support';
        $this->mailer->sendShareLinkEmail(
            $input['customer_email'],
            $orgName,
            trim($input['subject']),
            $result->token,
        );

        return response()->json([
            'ticket' => ['id' => $ticketWireId, 'status' => 'open'],
            'share' => ['id' => $result->share->id, 'expires_at' => $result->share->expiresAt->format(\DATE_ATOM)],
            'share_url' => $this->mailer->shareUrl($result->token),
        ], 201);
    }

    public function viewTicket(Request $request): JsonResponse
    {
        $verified = $this->verified($request);
        if ($verified->objectType !== 'ticket') {
            return response()->json([
                'error' => ['code' => 'wrong_resource', 'message' => 'Share does not authorize a ticket view'],
            ], 403);
        }
        // C2 (security-audit-v0.3.md): enforce share relation. 'commenter'
        // implies the ability to both view and reply; pre-fix this endpoint
        // accepted any share relation for the ticket.
        if ($verified->relation !== 'commenter') {
            return response()->json([
                'error' => ['code' => 'wrong_relation', 'message' => 'Share does not authorize ticket access'],
            ], 403);
        }
        $ticketUuid = $this->normalizeUuid($verified->objectId);
        $ticket = $this->loadTicket($ticketUuid);
        if (! $ticket) {
            return response()->json([
                'error' => ['code' => 'ticket_not_found', 'message' => 'Ticket no longer exists'],
            ], 404);
        }

        return response()->json([
            'ticket' => $this->serializeTicket($ticket),
            'comments' => array_map([$this, 'serializeComment'], $this->listComments($ticketUuid)),
        ]);
    }

    public function postComment(Request $request): JsonResponse
    {
        $input = $request->validate([
            'body' => 'required|string|max:20000',
        ]);
        $verified = $this->verified($request);
        if ($verified->objectType !== 'ticket') {
            return response()->json([
                'error' => ['code' => 'wrong_resource', 'message' => 'Share does not authorize a ticket reply'],
            ], 403);
        }
        // C2 (security-audit-v0.3.md): explicitly require 'commenter'.
        // Pre-fix this endpoint accepted any share for the ticket — a
        // 'viewer' share could post comments. The check here is the
        // adopter contract: verified.relation MUST match route intent.
        if ($verified->relation !== 'commenter') {
            return response()->json([
                'error' => ['code' => 'wrong_relation', 'message' => 'Share does not authorize a ticket reply'],
            ], 403);
        }
        $ticketUuid = $this->normalizeUuid($verified->objectId);

        $body = trim($input['body']);
        $commentWireId = HearthIds::generate('comment');
        $commentUuid = HearthIds::toUuid($commentWireId);

        $reopened = false;
        $ticketAfter = null;

        DB::transaction(function () use ($ticketUuid, $commentUuid, $body, &$reopened, &$ticketAfter): void {
            $lock = DB::selectOne(
                'SELECT status, org_id::text AS org_id, customer_email, subject FROM ticket WHERE id = ? FOR UPDATE',
                [$ticketUuid],
            );
            if (! $lock) {
                return;
            }
            $wasResolved = $lock->status === 'resolved';

            DB::insert(
                "INSERT INTO comment (id, ticket_id, source, author_usr_id, body)
                 VALUES (?, ?, 'customer', NULL, ?)",
                [$commentUuid, $ticketUuid, $body],
            );

            $newStatus = $wasResolved ? 'open' : $lock->status;
            $reopened = $wasResolved;

            DB::update(
                "UPDATE ticket
                    SET status = ?,
                        resolved_at = CASE WHEN ? = 'resolved' THEN resolved_at ELSE NULL END,
                        updated_at = now()
                  WHERE id = ?",
                [$newStatus, $newStatus, $ticketUuid],
            );

            $ticketAfter = $this->loadTicket($ticketUuid);
        });

        if (! $ticketAfter) {
            return response()->json([
                'error' => ['code' => 'ticket_not_found', 'message' => 'Ticket no longer exists'],
            ], 404);
        }

        $admins = $this->orgs->listAdminEmails($ticketAfter->org_id);
        $orgName = $this->orgs->nameByUuid($ticketAfter->org_id);
        $this->mailer->sendCustomerReplyNotification(
            $admins,
            $orgName,
            $ticketAfter->subject,
            $ticketAfter->customer_email,
            $reopened,
        );

        $commentAfter = (object) [
            'id' => $commentUuid,
            'ticket_id' => $ticketUuid,
            'source' => 'customer',
            'author_usr_id' => null,
            'body' => $body,
            'created_at' => date(\DATE_ATOM),
        ];

        return response()->json([
            'comment' => $this->serializeComment($commentAfter),
            'ticket' => $this->serializeTicket($ticketAfter),
            'reopened' => $reopened,
        ], 201);
    }

    private function verified(Request $request): VerifiedShare
    {
        return $request->attributes->get('verified_share');
    }

    private function normalizeUuid(string $objectId): string
    {
        if (preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $objectId)) {
            return $objectId;
        }

        return HearthIds::toUuid($objectId);
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

    /** @return list<object> */
    private function listComments(string $ticketUuid): array
    {
        return DB::select(
            'SELECT id::text AS id, ticket_id::text AS ticket_id, source,
                    author_usr_id::text AS author_usr_id, body, created_at
               FROM comment WHERE ticket_id = ? ORDER BY created_at ASC',
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
}
