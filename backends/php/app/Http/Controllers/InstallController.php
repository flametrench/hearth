<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Support\HearthIds;
use Flametrench\Authz\PostgresTupleStore;
use Flametrench\Identity\PostgresIdentityStore;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class InstallController
{
    public function status(): JsonResponse
    {
        $count = (int) DB::scalar('SELECT COUNT(*) FROM inst');

        return response()->json(['installed' => $count > 0]);
    }

    public function install(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'sysadmin_email' => 'required|email',
            'sysadmin_password' => 'required|string|min:8',
            'sysadmin_display_name' => 'required|string',
            'mfa_policy' => 'required|in:off,admins,all',
        ]);

        // C3 (security-audit-v0.3.md): pre-fix this checked count
        // OUTSIDE the transaction, leaving a TOCTOU race where two
        // concurrent installer requests both passed the gate before
        // either took the txn — both then created an inst row +
        // sysadmin. The cheap pre-check stays for the common
        // already-installed response, but the txn now takes a
        // Postgres advisory lock + re-checks before insert. The lock
        // is auto-released at COMMIT/ROLLBACK.
        $count = (int) DB::scalar('SELECT COUNT(*) FROM inst');
        if ($count > 0) {
            return response()->json([
                'error' => ['code' => 'already_installed', 'message' => 'Hearth has already been installed'],
            ], 409);
        }

        // 0x6865617274686e73 = "hearthns" packed (h-e-a-r-t-h-n-s, 8 ASCII
        // bytes). MUST match Node backend (install.ts:85) so the two
        // backends serialize against the same Postgres advisory-lock key
        // — adopters running mixed Node + PHP installers concurrently
        // (e.g. blue/green deploy mid-install) get exactly one winner.
        // security-audit-v0.3.md S13 re-audit caught a prior typo here.
        $advisoryLockKey = 7522525896799448691;

        try {
            $result = DB::transaction(function () use ($validated, $advisoryLockKey): array {
                $pdo = DB::connection()->getPdo();
                $stmt = $pdo->prepare('SELECT pg_advisory_xact_lock(?)');
                $stmt->execute([$advisoryLockKey]);
                $lockedCount = (int) DB::scalar('SELECT COUNT(*) FROM inst');
                if ($lockedCount > 0) {
                    // Throw a typed sentinel so the catch below maps to a 409.
                    throw new \RuntimeException('hearth_already_installed_after_lock');
                }
                $identityStore = new PostgresIdentityStore($pdo);
                $tupleStore = new PostgresTupleStore($pdo);

                $sysadmin = $identityStore->createUser($validated['sysadmin_display_name']);
                $identityStore->createPasswordCredential(
                    $sysadmin->id,
                    $validated['sysadmin_email'],
                    $validated['sysadmin_password'],
                );

                $instWireId = HearthIds::generate('inst');
                $instUuid = HearthIds::toUuid($instWireId);
                $sysadminUuid = HearthIds::toUuid($sysadmin->id);

                $stmt = $pdo->prepare(
                    'INSERT INTO inst (id, mfa_policy, installed_by) VALUES (?, ?, ?)'
                );
                $stmt->execute([$instUuid, $validated['mfa_policy'], $sysadminUuid]);

                $tupleStore->createTuple(
                    subjectType: 'usr',
                    subjectId: $sysadmin->id,
                    relation: 'sysadmin',
                    objectType: 'inst',
                    objectId: $instWireId,
                    createdBy: $sysadmin->id,
                );

                return [
                    'inst' => ['id' => $instWireId, 'mfa_policy' => $validated['mfa_policy']],
                    'sysadmin' => [
                        'id' => $sysadmin->id,
                        'email' => $validated['sysadmin_email'],
                        'display_name' => $validated['sysadmin_display_name'],
                    ],
                ];
            });
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'hearth_already_installed_after_lock') {
                return response()->json([
                    'error' => ['code' => 'already_installed', 'message' => 'Hearth has already been installed'],
                ], 409);
            }
            throw $e;
        }

        return response()->json($result, 201);
    }
}
