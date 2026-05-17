// Copyright 2026 NDC Digital, LLC
// SPDX-License-Identifier: Apache-2.0

package routes

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/flametrench/flametrench-go/packages/identity"
	"github.com/flametrench/flametrench-go/packages/tenancy"

	"github.com/flametrench/hearth/backends/go/internal/server"
)

const onboardSessionTTLSeconds = 3600

var slugPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

type onboardBody struct {
	DisplayName string `json:"display_name"`
	Email       string `json:"email"`
	Password    string `json:"password"`
	OrgName     string `json:"org_name"`
	OrgSlug     string `json:"org_slug"`
}

func (b *onboardBody) validate() error {
	b.DisplayName = strings.TrimSpace(b.DisplayName)
	if b.DisplayName == "" {
		return errors.New("display_name is required")
	}
	if !strings.Contains(b.Email, "@") {
		return errors.New("email must be an email string")
	}
	// security-audit-v0.3.md F7: NIST SP 800-63B sets the floor for
	// primary credentials at 8 chars; Hearth raises to 12 to reject
	// single-word passphrases.
	if len(b.Password) < 12 {
		return errors.New("password must be a string of at least 12 characters")
	}
	b.OrgName = strings.TrimSpace(b.OrgName)
	if b.OrgName == "" {
		return errors.New("org_name is required")
	}
	if !slugPattern.MatchString(b.OrgSlug) {
		return errors.New("org_slug must match ^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
	}
	return nil
}

func RegisterOnboard(r chi.Router, deps server.Deps) {
	r.Post("/onboard", func(w http.ResponseWriter, req *http.Request) {
		var body onboardBody
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			server.WriteError(w, http.StatusBadRequest, "invalid_request", "body must be a JSON object")
			return
		}
		if err := body.validate(); err != nil {
			server.WriteError(w, http.StatusBadRequest, "invalid_request", err.Error())
			return
		}

		ctx := req.Context()
		tx, err := deps.Pool.Begin(ctx)
		if err != nil {
			server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		committed := false
		defer func() {
			if !committed {
				_ = tx.Rollback(ctx)
			}
		}()

		identityStore := identity.NewPostgresIdentityStore(ctx, tx)
		tenancyStore := tenancy.NewPostgresTenancyStore(ctx, tx)

		user, err := identityStore.CreateUser(&body.DisplayName)
		if err != nil {
			server.WriteError(w, http.StatusInternalServerError, "internal", "create user: "+err.Error())
			return
		}
		cred, err := identityStore.CreatePasswordCredential(user.ID, body.Email, body.Password)
		if err != nil {
			if identity.IsDuplicateCredential(err) {
				server.WriteError(w, http.StatusConflict, "email_taken", "Email '"+body.Email+"' already has a credential")
				return
			}
			server.WriteError(w, http.StatusInternalServerError, "internal", "create credential: "+err.Error())
			return
		}
		orgRes, err := tenancyStore.CreateOrg(user.ID, tenancy.CreateOrgOptions{
			Name: &body.OrgName,
			Slug: &body.OrgSlug,
		})
		if err != nil {
			if tenancy.IsOrgSlugConflict(err) {
				server.WriteError(w, http.StatusConflict, "slug_taken", "Org slug '"+body.OrgSlug+"' is already taken")
				return
			}
			server.WriteError(w, http.StatusInternalServerError, "internal", "create org: "+err.Error())
			return
		}
		sessRes, err := identityStore.CreateSession(user.ID, cred.ID, onboardSessionTTLSeconds)
		if err != nil {
			server.WriteError(w, http.StatusInternalServerError, "internal", "create session: "+err.Error())
			return
		}

		if err := tx.Commit(ctx); err != nil {
			server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		committed = true

		server.WriteJSON(w, http.StatusCreated, map[string]any{
			"usr": map[string]any{
				"id":           user.ID,
				"display_name": body.DisplayName,
				"email":        body.Email,
			},
			"org": map[string]any{
				"id":   orgRes.Org.ID,
				"name": orgRes.Org.Name,
				"slug": orgRes.Org.Slug,
			},
			"session": map[string]any{
				"id":         sessRes.Session.ID,
				"token":      sessRes.Token,
				"expires_at": sessRes.Session.ExpiresAt,
			},
		})
	})
}
