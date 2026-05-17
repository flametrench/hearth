// Copyright 2026 NDC Digital, LLC
// SPDX-License-Identifier: Apache-2.0

// Package db owns the pgx pool and applies the two shared schema files
// (Flametrench tables + Hearth-specific tables) when they are missing
// from the target database. Mirrors backends/node/src/{db,schema}.ts.
package db

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func NewPool(ctx context.Context, url string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("pgxpool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return pool, nil
}

// sharedSQLDir returns hearth/shared/sql resolved relative to this
// source file so it works whether the binary is invoked from the
// backend dir or from `go run`.
func sharedSQLDir() (string, error) {
	_, here, _, ok := runtime.Caller(0)
	if !ok {
		return "", fmt.Errorf("runtime.Caller failed")
	}
	// internal/db/db.go → backends/go → backends → hearth → shared/sql
	return filepath.Join(filepath.Dir(here), "..", "..", "..", "..", "shared", "sql"), nil
}

func tableExists(ctx context.Context, pool *pgxpool.Pool, name string) (bool, error) {
	var exists bool
	err := pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_schema = current_schema() AND table_name = $1
		)`, name,
	).Scan(&exists)
	if err != nil {
		return false, err
	}
	return exists, nil
}

func applyFile(ctx context.Context, pool *pgxpool.Pool, dir, name string) error {
	p := filepath.Join(dir, name)
	sql, err := os.ReadFile(p)
	if err != nil {
		return fmt.Errorf("read %s: %w", p, err)
	}
	// pgx requires a connection acquired for multi-statement DDL.
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, string(sql)); err != nil {
		return fmt.Errorf("apply %s: %w", name, err)
	}
	return nil
}

func EnsureSchema(ctx context.Context, pool *pgxpool.Pool) error {
	dir, err := sharedSQLDir()
	if err != nil {
		return err
	}
	if _, err := os.Stat(dir); err != nil {
		return fmt.Errorf("shared sql dir not found at %s: %w", dir, err)
	}
	if ok, err := tableExists(ctx, pool, "usr"); err != nil {
		return err
	} else if !ok {
		if err := applyFile(ctx, pool, dir, "flametrench-schema.sql"); err != nil {
			return err
		}
	}
	if ok, err := tableExists(ctx, pool, "ticket"); err != nil {
		return err
	} else if !ok {
		if err := applyFile(ctx, pool, dir, "hearth-schema.sql"); err != nil {
			return err
		}
	}
	return nil
}

// Querier is the subset of pgxpool/pgx.Tx needed for read/write ops in
// the route handlers. Lets the route layer accept either *pgxpool.Pool
// or pgx.Tx without an interface assertion at each call site.
type Querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}
