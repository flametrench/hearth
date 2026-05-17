// Copyright 2026 NDC Digital, LLC
// SPDX-License-Identifier: Apache-2.0

// Package server wires the chi router + middleware and exposes the
// hearth-go HTTP surface. Routes are registered by the routes package
// behind a /app prefix (matches the Node backend).
package server

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/flametrench/flametrench-go/packages/authz"
	"github.com/flametrench/flametrench-go/packages/identity"
	"github.com/flametrench/flametrench-go/packages/tenancy"

	"github.com/flametrench/hearth/backends/go/internal/email"
)

// Deps is the dependency graph passed into route registration. Mirrors
// the constructor args of @flametrench/server in the Node backend.
type Deps struct {
	Ctx           context.Context
	Pool          *pgxpool.Pool
	IdentityStore identity.IdentityStore
	TenancyStore  tenancy.TenancyStore
	TupleStore    authz.TupleStore
	ShareStore    authz.ShareStore
	Mailer        *email.Mailer
}

// New builds the router, applies CORS + recovery, and mounts /healthz.
// `mountApp` receives the /app-prefixed subrouter; `mountTop` receives
// the root router for non-/app routes such as the /v1 framework API.
func New(deps Deps, mountApp func(r chi.Router, d Deps), mountTop func(r chi.Router, d Deps)) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	r.Use(corsMiddleware)

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	if mountTop != nil {
		mountTop(r, deps)
	}
	r.Route("/app", func(sub chi.Router) {
		mountApp(sub, deps)
	})

	return r
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// WriteJSON is the package's public JSON-write helper. Route packages
// use it instead of reimplementing the same three lines per handler.
func WriteJSON(w http.ResponseWriter, status int, body any) {
	writeJSON(w, status, body)
}

// WriteError renders {error: {code, message}} with the given status,
// matching the OpenAPI error envelope every Flametrench SDK emits.
func WriteError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}

// corsMiddleware opens the API up to any origin during local
// development. Matches the @fastify/cors `origin: true` block in the
// Node backend; production deployments override this.
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("access-control-allow-origin", "*")
		w.Header().Set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("access-control-allow-headers", "content-type, authorization")
		if req.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, req)
	})
}
