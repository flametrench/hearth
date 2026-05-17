// Copyright 2026 NDC Digital, LLC
// SPDX-License-Identifier: Apache-2.0

// Package orgs holds the small set of org-lookup helpers shared
// between the customer and agent route surfaces. Mirrors
// backends/node/src/orgs.ts.
package orgs

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type OrgRecord struct {
	ID   string // wire format: org_<32hex>
	UUID string // canonical 8-4-4-4-12
	Name *string
	Slug *string
}

func FindBySlug(ctx context.Context, pool *pgxpool.Pool, slug string) (*OrgRecord, error) {
	var uid string
	var name, sl *string
	err := pool.QueryRow(ctx,
		`SELECT id::text, name, slug FROM org WHERE slug = $1 AND status = 'active'`, slug,
	).Scan(&uid, &name, &sl)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &OrgRecord{ID: encodeOrgID(uid), UUID: uid, Name: name, Slug: sl}, nil
}

func encodeOrgID(uuid string) string {
	return "org_" + strings.ReplaceAll(uuid, "-", "")
}

// ListAdminEmails returns the set of active password-credential
// identifiers for users with the owner/admin role in the given org.
// Used to address moderator notifications when a customer replies.
func ListAdminEmails(ctx context.Context, pool *pgxpool.Pool, orgUUID string) ([]string, error) {
	rows, err := pool.Query(ctx, `
		SELECT DISTINCT cred.identifier
		  FROM mem
		  JOIN cred ON cred.usr_id = mem.usr_id
		 WHERE mem.org_id = $1
		   AND mem.status = 'active'
		   AND mem.role IN ('owner', 'admin')
		   AND cred.status = 'active'
		   AND cred.type = 'password'`, orgUUID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var ident string
		if err := rows.Scan(&ident); err != nil {
			return nil, err
		}
		out = append(out, ident)
	}
	return out, rows.Err()
}

// NameOrSlug picks a human-friendly label: the org's name when set,
// the slug as a fallback, "support" when neither is.
func NameOrSlug(ctx context.Context, pool *pgxpool.Pool, orgUUID string) (string, error) {
	var name, slug *string
	err := pool.QueryRow(ctx,
		`SELECT name, slug FROM org WHERE id = $1`, orgUUID,
	).Scan(&name, &slug)
	if err != nil {
		return "support", nil
	}
	if name != nil && *name != "" {
		return *name, nil
	}
	if slug != nil && *slug != "" {
		return *slug, nil
	}
	return "support", nil
}
