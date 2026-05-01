<?php

declare(strict_types=1);

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

class HearthApplySchema extends Command
{
    protected $signature = 'hearth:apply-schema';

    protected $description = 'Apply Flametrench v0.2 schema + Hearth schema to the configured database (idempotent).';

    public function handle(): int
    {
        $base = realpath(base_path('../../shared/sql'));
        if ($base === false) {
            $this->error('shared/sql directory not found');

            return self::FAILURE;
        }

        $usrExists = DB::scalar(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'usr')"
        );
        if (! $usrExists) {
            $this->info('Applying flametrench-schema.sql');
            DB::unprepared(file_get_contents($base.'/flametrench-schema.sql'));
        } else {
            $this->info('flametrench schema already present, skipping');
        }

        $ticketExists = DB::scalar(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'ticket')"
        );
        if (! $ticketExists) {
            $this->info('Applying hearth-schema.sql');
            DB::unprepared(file_get_contents($base.'/hearth-schema.sql'));
        } else {
            $this->info('hearth schema already present, skipping');
        }

        $this->info('Done.');

        return self::SUCCESS;
    }
}
