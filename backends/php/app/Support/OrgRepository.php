<?php

declare(strict_types=1);

namespace App\Support;

use Illuminate\Support\Facades\DB;
use stdClass;

class OrgRepository
{
    public function findBySlug(string $slug): ?stdClass
    {
        $row = DB::selectOne(
            "SELECT id::text AS uuid, name, slug FROM org WHERE slug = ? AND status = 'active'",
            [$slug],
        );
        if (! $row) {
            return null;
        }
        $obj = new stdClass;
        $obj->uuid = $row->uuid;
        $obj->name = $row->name;
        $obj->slug = $row->slug;
        $obj->wireId = HearthIds::fromUuid('org', $row->uuid);

        return $obj;
    }

    public function nameByUuid(string $orgUuid): string
    {
        $row = DB::selectOne('SELECT name, slug FROM org WHERE id = ?', [$orgUuid]);
        if (! $row) {
            return 'support';
        }

        return $row->name ?? $row->slug ?? 'support';
    }

    /** @return string[] */
    public function listAdminEmails(string $orgUuid): array
    {
        $rows = DB::select(
            "SELECT DISTINCT cred.identifier
               FROM mem
               JOIN cred ON cred.usr_id = mem.usr_id
              WHERE mem.org_id = ?
                AND mem.status = 'active'
                AND mem.role IN ('owner', 'admin')
                AND cred.status = 'active'
                AND cred.type = 'password'",
            [$orgUuid],
        );

        return array_map(fn ($r) => $r->identifier, $rows);
    }

    public function installedByUuid(): ?string
    {
        $row = DB::selectOne('SELECT installed_by::text AS installed_by FROM inst LIMIT 1');

        return $row?->installed_by;
    }
}
