// Copyright 2026 NDC Digital, LLC
// SPDX-License-Identifier: Apache-2.0

// Package auth holds the two HTTP middlewares Hearth uses: bearer
// (session token → req-scoped Session) and share-token (share token →
// req-scoped VerifiedShare). Equivalents of @flametrench/server's
// buildBearerAuthHook plus hearth/backends/node/src/share-auth.ts.
package auth

import (
	"context"
	"net/http"
	"strings"

	"github.com/flametrench/flametrench-go/packages/authz"
	"github.com/flametrench/flametrench-go/packages/identity"

	"github.com/flametrench/hearth/backends/go/internal/server"
)

type sessionKey struct{}
type shareKey struct{}

// BearerHook returns middleware that resolves an `Authorization:
// Bearer <token>` header into an identity.Session and stores it on
// the request context. Routes call SessionFromCtx to retrieve it.
func BearerHook(store identity.IdentityStore) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			token := extractBearer(req.Header.Get("Authorization"))
			if token == "" {
				server.WriteError(w, http.StatusUnauthorized, "unauthenticated", "Missing or malformed Authorization header")
				return
			}
			ses, err := store.VerifySessionToken(token)
			if err != nil {
				server.WriteError(w, http.StatusUnauthorized, "invalid_token", "Session token is invalid, expired, or revoked")
				return
			}
			next.ServeHTTP(w, req.WithContext(context.WithValue(req.Context(), sessionKey{}, ses)))
		})
	}
}

// ShareHook returns middleware that resolves an `Authorization:
// Bearer <token>` header through the share-token verifier. Used by the
// customer endpoints, which authenticate via share token rather than
// session.
func ShareHook(store authz.ShareStore) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			token := extractBearer(req.Header.Get("Authorization"))
			if token == "" {
				server.WriteError(w, http.StatusUnauthorized, "unauthenticated", "Missing or malformed Authorization header")
				return
			}
			vs, err := store.VerifyShareToken(token)
			if err != nil {
				server.WriteError(w, http.StatusUnauthorized, "invalid_share_token", "Share token is invalid, expired, or revoked")
				return
			}
			next.ServeHTTP(w, req.WithContext(context.WithValue(req.Context(), shareKey{}, vs)))
		})
	}
}

func extractBearer(authHeader string) string {
	if len(authHeader) < 7 || !strings.EqualFold(authHeader[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(authHeader[7:])
}

// SessionFromCtx returns the verified Session attached by BearerHook,
// or the zero Session if the request did not pass through bearer auth.
func SessionFromCtx(ctx context.Context) identity.Session {
	v, _ := ctx.Value(sessionKey{}).(identity.Session)
	return v
}

// ShareFromCtx returns the verified share attached by ShareHook.
func ShareFromCtx(ctx context.Context) authz.VerifiedShare {
	v, _ := ctx.Value(shareKey{}).(authz.VerifiedShare)
	return v
}
