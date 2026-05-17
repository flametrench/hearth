// Copyright 2026 NDC Digital, LLC
// SPDX-License-Identifier: Apache-2.0

// Minimal port of the /v1 framework HTTP routes that @flametrench/server
// exposes in Node — the three endpoints the e2e fixtures need to drive
// signin + org bootstrap. Not a complete server-package replacement;
// each endpoint is documented with the matching path in
// node-repo/packages/server/src/routes/*.ts so the e2e contract is
// auditable.
package routes

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/flametrench/flametrench-go/packages/identity"
	"github.com/flametrench/flametrench-go/packages/tenancy"

	"github.com/flametrench/hearth/backends/go/internal/auth"
	"github.com/flametrench/hearth/backends/go/internal/server"
)

// RegisterV1 mounts the framework endpoints under /v1.
func RegisterV1(r chi.Router, deps server.Deps) {
	r.Route("/v1", func(v chi.Router) {
		v.Post("/credentials/verify", verifyCredential(deps))
		v.Post("/sessions", createSession(deps))

		v.Group(func(g chi.Router) {
			g.Use(auth.BearerHook(deps.IdentityStore))
			g.Post("/orgs", createOrg(deps))
		})
	})
}

// POST /v1/credentials/verify — used during signin to exchange
// identifier+password for {usr_id, cred_id}. Matches
// node-repo/packages/server/src/routes/credentials.ts.
func verifyCredential(deps server.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		var body struct {
			Type       string `json:"type"`
			Identifier string `json:"identifier"`
			Proof      struct {
				Password string `json:"password"`
			} `json:"proof"`
		}
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			server.WriteError(w, http.StatusBadRequest, "invalid_request", err.Error())
			return
		}
		if body.Type != "password" {
			server.WriteError(w, http.StatusBadRequest, "invalid_request", "only type=password is supported")
			return
		}
		vc, err := deps.IdentityStore.VerifyPassword(body.Identifier, body.Proof.Password)
		if err != nil {
			server.WriteError(w, http.StatusUnauthorized, "invalid_credential", err.Error())
			return
		}
		server.WriteJSON(w, http.StatusOK, map[string]any{
			"usr_id":  vc.UsrID,
			"cred_id": vc.CredID,
		})
	}
}

// POST /v1/sessions — mint a session bearer from a verified credential.
func createSession(deps server.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		var body struct {
			UsrID      string `json:"usr_id"`
			CredID     string `json:"cred_id"`
			TTLSeconds int    `json:"ttl_seconds"`
		}
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			server.WriteError(w, http.StatusBadRequest, "invalid_request", err.Error())
			return
		}
		if body.TTLSeconds == 0 {
			body.TTLSeconds = 3600
		}
		res, err := deps.IdentityStore.CreateSession(body.UsrID, body.CredID, body.TTLSeconds)
		if err != nil {
			server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		// The SPA reads `session.expiresAt` (camelCase) from this
		// response, so the field shape must match the Node server's
		// exactly. Keep both `session` and top-level `token` to satisfy
		// the e2e fixtures and the SPA.
		server.WriteJSON(w, http.StatusCreated, map[string]any{
			"session": map[string]any{
				"id":        res.Session.ID,
				"expiresAt": res.Session.ExpiresAt,
			},
			"token": res.Token,
		})
	}
}

// POST /v1/orgs — bearer-authenticated org creation. The Node server
// emits {org: {id}} which createOrgWithSlug then narrows via the
// subsequent /app/orgs/:id/settings PATCH.
func createOrg(deps server.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		ses := auth.SessionFromCtx(req.Context())
		// Body is optional. Schemes that allowed embedding name/slug
		// here have moved to the org-settings PATCH; we accept and
		// forward.
		var body struct {
			Name *string `json:"name"`
			Slug *string `json:"slug"`
		}
		_ = json.NewDecoder(req.Body).Decode(&body)
		opts := tenancy.CreateOrgOptions{}
		if body.Name != nil && strings.TrimSpace(*body.Name) != "" {
			opts.Name = body.Name
		}
		if body.Slug != nil && *body.Slug != "" {
			opts.Slug = body.Slug
		}
		res, err := deps.TenancyStore.CreateOrg(ses.UsrID, opts)
		if err != nil {
			if tenancy.IsOrgSlugConflict(err) {
				server.WriteError(w, http.StatusConflict, "slug_taken", err.Error())
				return
			}
			server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		server.WriteJSON(w, http.StatusCreated, map[string]any{
			"org": map[string]any{
				"id":     res.Org.ID,
				"name":   res.Org.Name,
				"slug":   res.Org.Slug,
				"status": res.Org.Status,
			},
		})
	}
}

// Verify the auth.SessionFromCtx import is used; identity package is
// imported here only via the Deps consumers above, but Go requires the
// import to be referenced. Pull a sentinel so the import is live.
var _ = identity.IdentityStore(nil)
