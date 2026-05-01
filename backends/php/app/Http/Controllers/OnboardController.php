<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use Flametrench\Identity\PostgresIdentityStore;
use Flametrench\Tenancy\Exceptions\OrgSlugConflictException;
use Flametrench\Tenancy\PostgresTenancyStore;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Throwable;

class OnboardController
{
    private const SESSION_TTL_SECONDS = 3600;

    public function onboard(Request $request): JsonResponse
    {
        $input = $request->validate([
            'display_name' => 'required|string',
            'email' => 'required|email',
            'password' => 'required|string|min:8',
            'org_name' => 'required|string',
            'org_slug' => 'required|string|regex:/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/',
        ]);

        try {
            $result = DB::transaction(function () use ($input): array {
                $pdo = DB::connection()->getPdo();
                $identityStore = new PostgresIdentityStore($pdo);
                $tenancyStore = new PostgresTenancyStore($pdo);

                $usr = $identityStore->createUser($input['display_name']);
                $cred = $identityStore->createPasswordCredential(
                    $usr->id,
                    $input['email'],
                    $input['password'],
                );
                $orgResult = $tenancyStore->createOrg(
                    $usr->id,
                    $input['org_name'],
                    $input['org_slug'],
                );
                $sessionResult = $identityStore->createSession(
                    $usr->id,
                    $cred->id,
                    self::SESSION_TTL_SECONDS,
                );

                return [
                    'usr' => $usr,
                    'org' => $orgResult['org'],
                    'session' => $sessionResult,
                ];
            });
        } catch (OrgSlugConflictException) {
            return response()->json([
                'error' => ['code' => 'slug_taken', 'message' => "Org slug '{$input['org_slug']}' is already taken"],
            ], 409);
        } catch (Throwable $e) {
            if (str_contains($e->getMessage(), 'duplicate key') && str_contains($e->getMessage(), 'identifier')) {
                return response()->json([
                    'error' => ['code' => 'email_taken', 'message' => "Email '{$input['email']}' already has a credential"],
                ], 409);
            }
            throw $e;
        }

        return response()->json([
            'usr' => [
                'id' => $result['usr']->id,
                'display_name' => $input['display_name'],
                'email' => $input['email'],
            ],
            'org' => [
                'id' => $result['org']->id,
                'name' => $result['org']->name,
                'slug' => $result['org']->slug,
            ],
            'session' => [
                'id' => $result['session']->session->id,
                'token' => $result['session']->token,
                'expires_at' => $result['session']->session->expiresAt->format(\DATE_ATOM),
            ],
        ], 201);
    }
}
