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

        $count = (int) DB::scalar('SELECT COUNT(*) FROM inst');
        if ($count > 0) {
            return response()->json([
                'error' => ['code' => 'already_installed', 'message' => 'Hearth has already been installed'],
            ], 409);
        }

        $result = DB::transaction(function () use ($validated): array {
            $pdo = DB::connection()->getPdo();
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

        return response()->json($result, 201);
    }
}
