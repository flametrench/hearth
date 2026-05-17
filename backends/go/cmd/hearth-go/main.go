// Copyright 2026 NDC Digital, LLC
// SPDX-License-Identifier: Apache-2.0

// Hearth Go backend — Flametrench v0.3 reference application port.
// Mirrors hearth/backends/node/src/index.ts; uses chi for routing and
// the Postgres-backed flametrench-go SDK stores per ADR 0013.
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/flametrench/flametrench-go/packages/authz"
	"github.com/flametrench/flametrench-go/packages/identity"
	"github.com/flametrench/flametrench-go/packages/tenancy"

	"github.com/flametrench/hearth/backends/go/internal/db"
	"github.com/flametrench/hearth/backends/go/internal/email"
	"github.com/flametrench/hearth/backends/go/internal/env"
	"github.com/flametrench/hearth/backends/go/internal/routes"
	"github.com/flametrench/hearth/backends/go/internal/server"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	cfg, err := env.Load()
	if err != nil {
		return err
	}
	ctx := context.Background()
	pool, err := db.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	if err := db.EnsureSchema(ctx, pool); err != nil {
		return fmt.Errorf("ensure schema: %w", err)
	}

	mailer := email.New(email.Config{
		Host:          cfg.SMTPHost,
		Port:          cfg.SMTPPort,
		From:          cfg.SMTPFrom,
		PublicBaseURL: cfg.HearthPublicBaseURL,
	})

	deps := server.Deps{
		Ctx:           ctx,
		Pool:          pool,
		IdentityStore: identity.NewPostgresIdentityStore(ctx, pool),
		TenancyStore:  tenancy.NewPostgresTenancyStore(ctx, pool),
		TupleStore:    authz.NewPostgresTupleStore(ctx, pool),
		ShareStore:    authz.NewPostgresShareStore(ctx, pool),
		Mailer:        mailer,
	}

	handler := server.New(deps,
		func(r chi.Router, d server.Deps) {
			routes.RegisterInstall(r, d)
			routes.RegisterOnboard(r, d)
			routes.RegisterCustomer(r, d)
			routes.RegisterAgent(r, d)
		},
		func(r chi.Router, d server.Deps) {
			routes.RegisterV1(r, d)
		},
	)

	addr := fmt.Sprintf(":%d", cfg.Port)
	srv := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		log.Printf("hearth-go listening on %s", addr)
		errCh <- srv.ListenAndServe()
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	select {
	case err := <-errCh:
		if err != nil && err != http.ErrServerClosed {
			return err
		}
		return nil
	case <-sigCh:
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	}
}
