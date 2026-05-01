<?php

declare(strict_types=1);

namespace App\Providers;

use Flametrench\Authz\PostgresShareStore;
use Flametrench\Authz\PostgresTupleStore;
use Flametrench\Authz\ShareStore;
use Flametrench\Authz\TupleStore;
use Flametrench\Identity\IdentityStore;
use Flametrench\Identity\PostgresIdentityStore;
use Flametrench\Tenancy\PostgresTenancyStore;
use Flametrench\Tenancy\TenancyStore;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\ServiceProvider;
use PDO;

/**
 * Override Flametrench\Laravel\FlametrenchServiceProvider's default
 * in-memory bindings with Postgres-backed stores, sharing Laravel's
 * configured pgsql connection PDO.
 *
 * Each store is a singleton bound to the connection's PDO; the install
 * wizard constructs fresh stores inside DB::transaction() so they
 * cooperate with the caller-driven transaction (ADR 0013).
 */
class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(IdentityStore::class, function (): IdentityStore {
            return new PostgresIdentityStore($this->pdo());
        });
        $this->app->singleton(TenancyStore::class, function (): TenancyStore {
            return new PostgresTenancyStore($this->pdo());
        });
        $this->app->singleton(TupleStore::class, function (): TupleStore {
            return new PostgresTupleStore($this->pdo());
        });
        $this->app->singleton(ShareStore::class, function (): ShareStore {
            return new PostgresShareStore($this->pdo());
        });
    }

    public function boot(): void
    {
        // no-op
    }

    private function pdo(): PDO
    {
        return DB::connection()->getPdo();
    }
}
