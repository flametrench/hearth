<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use Flametrench\Authz\TupleStore;
use Flametrench\Identity\IdentityStore;
use Flametrench\Identity\Session;
use Flametrench\Tenancy\TenancyStore;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Throwable;

/**
 * Minimal port of the v0.1 + v0.2 spec routes that Hearth's SPA hits:
 * POST /v1/users, POST /v1/credentials, POST /v1/credentials/verify,
 * POST /v1/sessions, POST /v1/orgs.
 *
 * The Node backend gets these via `@flametrench/server`. There's no Laravel
 * equivalent published yet, so we hand-roll the subset Hearth needs.
 */
class SpecController
{
    public function __construct(
        private readonly IdentityStore $identityStore,
        private readonly TenancyStore $tenancyStore,
        private readonly TupleStore $tupleStore,
    ) {}

    public function createUser(Request $request): JsonResponse
    {
        $displayName = $request->input('display_name');
        $user = $this->identityStore->createUser($displayName);

        return response()->json([
            'id' => $user->id,
            'status' => $user->status->value,
            'displayName' => $user->displayName,
            'createdAt' => $user->createdAt->format(\DATE_ATOM),
            'updatedAt' => $user->updatedAt->format(\DATE_ATOM),
        ], 201);
    }

    public function createCredential(Request $request): JsonResponse
    {
        $input = $request->validate([
            'usr_id' => 'required|string|regex:/^usr_[0-9a-f]{32}$/',
            'type' => 'required|in:password',
            'identifier' => 'required|string',
            'password' => 'required|string',
        ]);
        $cred = $this->identityStore->createPasswordCredential(
            $input['usr_id'],
            $input['identifier'],
            $input['password'],
        );

        return response()->json([
            'id' => $cred->id,
            'usrId' => $cred->usrId,
            'type' => 'password',
            'identifier' => $cred->identifier,
            'status' => $cred->status->value,
        ], 201);
    }

    public function verifyCredential(Request $request): JsonResponse
    {
        $input = $request->validate([
            'type' => 'required|in:password',
            'identifier' => 'required|string',
            'proof' => 'required|array',
            'proof.password' => 'required|string',
        ]);
        try {
            $verified = $this->identityStore->verifyPassword(
                $input['identifier'],
                $input['proof']['password'],
            );
        } catch (Throwable) {
            return response()->json([
                'code' => 'invalid_credential',
                'message' => 'Identifier or password did not verify',
            ], 401);
        }

        return response()->json([
            'usr_id' => $verified->usrId,
            'cred_id' => $verified->credId,
        ]);
    }

    public function createSession(Request $request): JsonResponse
    {
        $input = $request->validate([
            'usr_id' => 'required|string|regex:/^usr_[0-9a-f]{32}$/',
            'cred_id' => 'required|string|regex:/^cred_[0-9a-f]{32}$/',
            'ttl_seconds' => 'required|integer|min:60',
        ]);
        $sessionWithToken = $this->identityStore->createSession(
            $input['usr_id'],
            $input['cred_id'],
            $input['ttl_seconds'],
        );
        $session = $sessionWithToken->session;

        return response()->json([
            'session' => [
                'id' => $session->id,
                'usrId' => $session->usrId,
                'credId' => $session->credId,
                'createdAt' => $session->createdAt->format(\DATE_ATOM),
                'expiresAt' => $session->expiresAt->format(\DATE_ATOM),
                'revokedAt' => $session->revokedAt?->format(\DATE_ATOM),
            ],
            'token' => $sessionWithToken->token,
        ]);
    }

    public function createOrg(Request $request): JsonResponse
    {
        $session = $this->session($request);
        $result = $this->tenancyStore->createOrg($session->usrId);
        $org = $result['org'];
        $mem = $result['ownerMembership'];

        return response()->json([
            'org' => [
                'id' => $org->id,
                'name' => $org->name,
                'slug' => $org->slug,
                'status' => $org->status->value,
                'createdAt' => $org->createdAt->format(\DATE_ATOM),
                'updatedAt' => $org->updatedAt->format(\DATE_ATOM),
            ],
            'ownerMembership' => [
                'id' => $mem->id,
                'usrId' => $mem->usrId,
                'orgId' => $mem->orgId,
                'role' => $mem->role->value,
                'status' => $mem->status->value,
            ],
        ], 201);
    }

    private function session(Request $request): Session
    {
        return $request->attributes->get('session');
    }
}
