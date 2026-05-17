// Copyright 2026 NDC Digital, LLC
// SPDX-License-Identifier: Apache-2.0

// Package routes ports the Node backend's route modules to Go. Each
// file in this package mirrors one file under hearth/backends/node/src.
package routes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/flametrench/flametrench-go/packages/authz"
	"github.com/flametrench/flametrench-go/packages/identity"

	"github.com/flametrench/hearth/backends/go/internal/ids"
	"github.com/flametrench/hearth/backends/go/internal/server"
)

// hearthInstallAdvisoryLockKey — "hearthns" packed (h-e-a-r-t-h-n-s, 8
// ASCII bytes). MUST match the PHP and Node backends' value so all
// three serialize against the same Postgres advisory-lock key. From
// security-audit-v0.3.md finding C3 (TOCTOU on install gate).
const hearthInstallAdvisoryLockKey int64 = 0x6865617274686e73

type installBody struct {
	SysadminEmail       string `json:"sysadmin_email"`
	SysadminPassword    string `json:"sysadmin_password"`
	SysadminDisplayName string `json:"sysadmin_display_name"`
	MfaPolicy           string `json:"mfa_policy"`
}

func (b installBody) validate() error {
	if !strings.Contains(b.SysadminEmail, "@") {
		return errors.New("sysadmin_email must be an email string")
	}
	if len(b.SysadminPassword) < 8 {
		return errors.New("sysadmin_password must be a string of at least 8 characters")
	}
	if b.SysadminDisplayName == "" {
		return errors.New("sysadmin_display_name must be a non-empty string")
	}
	switch b.MfaPolicy {
	case "off", "admins", "all":
	default:
		return errors.New("mfa_policy must be one of 'off' | 'admins' | 'all'")
	}
	return nil
}

func RegisterInstall(r chi.Router, deps server.Deps) {
	r.Get("/install/status", func(w http.ResponseWriter, req *http.Request) {
		installed, err := isInstalled(req.Context(), deps.Pool)
		if err != nil {
			server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		server.WriteJSON(w, http.StatusOK, map[string]bool{"installed": installed})
	})

	r.Post("/install", func(w http.ResponseWriter, req *http.Request) {
		var body installBody
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			server.WriteError(w, http.StatusBadRequest, "invalid_request", "body must be a JSON object")
			return
		}
		if err := body.validate(); err != nil {
			server.WriteError(w, http.StatusBadRequest, "invalid_request", err.Error())
			return
		}

		ctx := req.Context()
		if installed, err := isInstalled(ctx, deps.Pool); err != nil {
			server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		} else if installed {
			server.WriteError(w, http.StatusConflict, "already_installed", "Hearth has already been installed")
			return
		}

		result, status, err := runInstall(ctx, deps.Pool, body)
		if err != nil {
			server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		if status == http.StatusConflict {
			server.WriteError(w, http.StatusConflict, "already_installed", "Hearth has already been installed")
			return
		}
		server.WriteJSON(w, http.StatusCreated, result)
	})
}

type installResult struct {
	Inst struct {
		ID        string `json:"id"`
		MfaPolicy string `json:"mfa_policy"`
	} `json:"inst"`
	Sysadmin struct {
		ID          string `json:"id"`
		Email       string `json:"email"`
		DisplayName string `json:"display_name"`
	} `json:"sysadmin"`
}

func isInstalled(ctx context.Context, pool *pgxpool.Pool) (bool, error) {
	var count int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM inst`).Scan(&count); err != nil {
		return false, err
	}
	return count > 0, nil
}

// runInstall opens a tx, takes the install advisory lock, re-checks
// emptiness inside the lock, then writes inst + admin user + admin
// credential + the sysadmin tuple. Returns httpStatus = 409 only when
// the inside-lock re-check observes a row.
func runInstall(ctx context.Context, pool *pgxpool.Pool, body installBody) (installResult, int, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return installResult{}, 0, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", hearthInstallAdvisoryLockKey); err != nil {
		return installResult{}, 0, err
	}

	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM inst)`).Scan(&exists); err != nil {
		return installResult{}, 0, err
	}
	if exists {
		return installResult{}, http.StatusConflict, nil
	}

	// pgx.Tx satisfies both PgxExecutor interfaces structurally; the
	// SDK stores write through this single tx (ADR 0013 caller-owned-
	// connection pattern) so the entire install commits atomically.
	identityStore := identity.NewPostgresIdentityStore(ctx, tx)
	tupleStore := authz.NewPostgresTupleStore(ctx, tx)

	user, err := identityStore.CreateUser(&body.SysadminDisplayName)
	if err != nil {
		return installResult{}, 0, fmt.Errorf("create user: %w", err)
	}
	if _, err := identityStore.CreatePasswordCredential(user.ID, body.SysadminEmail, body.SysadminPassword); err != nil {
		return installResult{}, 0, fmt.Errorf("create credential: %w", err)
	}

	instID, err := ids.Generate(ids.PrefixInstall)
	if err != nil {
		return installResult{}, 0, err
	}
	instUUID, err := ids.UUIDFromHearthID(instID)
	if err != nil {
		return installResult{}, 0, err
	}
	usrUUID, err := wireToUUID(user.ID)
	if err != nil {
		return installResult{}, 0, err
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO inst (id, mfa_policy, installed_by) VALUES ($1, $2, $3)`,
		instUUID, body.MfaPolicy, usrUUID,
	); err != nil {
		return installResult{}, 0, fmt.Errorf("insert inst: %w", err)
	}

	if _, err := tupleStore.CreateTuple(authz.CreateTupleInput{
		SubjectType: "usr", SubjectID: user.ID,
		Relation:    "sysadmin",
		ObjectType:  "inst", ObjectID: instID,
		CreatedBy:   &user.ID,
	}); err != nil {
		return installResult{}, 0, fmt.Errorf("create tuple: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return installResult{}, 0, err
	}
	committed = true

	var res installResult
	res.Inst.ID = instID
	res.Inst.MfaPolicy = body.MfaPolicy
	res.Sysadmin.ID = user.ID
	res.Sysadmin.Email = body.SysadminEmail
	res.Sysadmin.DisplayName = body.SysadminDisplayName
	return res, http.StatusCreated, nil
}

// wireToUUID parses the `prefix_<32hex>` wire format into the 8-4-4-4-12
// UUID string Postgres uuid columns accept.
func wireToUUID(id string) (string, error) {
	sep := strings.IndexByte(id, '_')
	if sep == -1 || len(id)-sep-1 != 32 {
		return "", fmt.Errorf("malformed wire id: %q", id)
	}
	h := id[sep+1:]
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[0:8], h[8:12], h[12:16], h[16:20], h[20:32]), nil
}
