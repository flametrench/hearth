// Copyright 2026 NDC Digital, LLC
// SPDX-License-Identifier: Apache-2.0

package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/flametrench/flametrench-go/packages/authz"

	"github.com/flametrench/hearth/backends/go/internal/auth"
	"github.com/flametrench/hearth/backends/go/internal/email"
	"github.com/flametrench/hearth/backends/go/internal/ids"
	"github.com/flametrench/hearth/backends/go/internal/orgs"
	"github.com/flametrench/hearth/backends/go/internal/server"
)

const shareTTLSeconds = 30 * 24 * 60 * 60

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type submitBody struct {
	OrgSlug       string `json:"org_slug"`
	CustomerEmail string `json:"customer_email"`
	Subject       string `json:"subject"`
	Body          string `json:"body"`
}

func (b *submitBody) validate() error {
	if b.OrgSlug == "" {
		return errors.New("org_slug is required")
	}
	if !strings.Contains(b.CustomerEmail, "@") {
		return errors.New("customer_email must be an email string")
	}
	b.Subject = strings.TrimSpace(b.Subject)
	if b.Subject == "" {
		return errors.New("subject is required")
	}
	b.Body = strings.TrimSpace(b.Body)
	if b.Body == "" {
		return errors.New("body is required")
	}
	if len(b.Subject) > 200 {
		return errors.New("subject must be 200 characters or fewer")
	}
	if len(b.Body) > 20_000 {
		return errors.New("body must be 20000 characters or fewer")
	}
	return nil
}

type commentBody struct {
	Body string `json:"body"`
}

func (b *commentBody) validate() error {
	b.Body = strings.TrimSpace(b.Body)
	if b.Body == "" {
		return errors.New("body is required")
	}
	if len(b.Body) > 20_000 {
		return errors.New("body must be 20000 characters or fewer")
	}
	return nil
}

type ticketRow struct {
	ID            string
	OrgID         string
	CustomerEmail string
	Subject       string
	Body          string
	Status        string
	ResolvedAt    *time.Time
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

type commentRow struct {
	ID          string
	TicketID    string
	Source      string
	AuthorUsrID *string
	Body        string
	CreatedAt   time.Time
}

func loadTicketByUUID(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, uid string) (*ticketRow, error) {
	var t ticketRow
	err := q.QueryRow(ctx, `
		SELECT id::text, org_id::text, customer_email, subject, body, status,
		       resolved_at, created_at, updated_at
		  FROM ticket WHERE id = $1`, uid,
	).Scan(&t.ID, &t.OrgID, &t.CustomerEmail, &t.Subject, &t.Body, &t.Status, &t.ResolvedAt, &t.CreatedAt, &t.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func listCommentsForTicket(ctx context.Context, pool *pgxpool.Pool, uid string) ([]commentRow, error) {
	rows, err := pool.Query(ctx, `
		SELECT id::text, ticket_id::text, source, author_usr_id::text, body, created_at
		  FROM comment WHERE ticket_id = $1 ORDER BY created_at ASC`, uid,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []commentRow{}
	for rows.Next() {
		var c commentRow
		var authorPtr *string
		if err := rows.Scan(&c.ID, &c.TicketID, &c.Source, &authorPtr, &c.Body, &c.CreatedAt); err != nil {
			return nil, err
		}
		c.AuthorUsrID = authorPtr
		out = append(out, c)
	}
	return out, rows.Err()
}

func uuidToWire(prefix, u string) string {
	return prefix + "_" + strings.ReplaceAll(u, "-", "")
}

func serializeTicket(t *ticketRow) map[string]any {
	return map[string]any{
		"id":             uuidToWire("ticket", t.ID),
		"org_id":         uuidToWire("org", t.OrgID),
		"customer_email": t.CustomerEmail,
		"subject":        t.Subject,
		"body":           t.Body,
		"status":         t.Status,
		"resolved_at":    t.ResolvedAt,
		"created_at":     t.CreatedAt,
		"updated_at":     t.UpdatedAt,
	}
}

func serializeComment(c commentRow) map[string]any {
	var author any
	if c.AuthorUsrID != nil {
		author = uuidToWire("usr", *c.AuthorUsrID)
	}
	return map[string]any{
		"id":            uuidToWire("comment", c.ID),
		"ticket_id":     uuidToWire("ticket", c.TicketID),
		"source":        c.Source,
		"author_usr_id": author,
		"body":          c.Body,
		"created_at":    c.CreatedAt,
	}
}

func normalizeObjectIDToUUID(objectID string) (string, error) {
	if uuidPattern.MatchString(objectID) {
		return objectID, nil
	}
	return ids.UUIDFromHearthID(objectID)
}

func getInstalledByUUID(ctx context.Context, pool *pgxpool.Pool) (string, error) {
	var u *string
	err := pool.QueryRow(ctx, `SELECT installed_by::text FROM inst LIMIT 1`).Scan(&u)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if u == nil {
		return "", nil
	}
	return *u, nil
}

func RegisterCustomer(r chi.Router, deps server.Deps) {
	r.Post("/tickets/submit", func(w http.ResponseWriter, req *http.Request) {
		var body submitBody
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			server.WriteError(w, http.StatusBadRequest, "invalid_request", "body must be a JSON object")
			return
		}
		if err := body.validate(); err != nil {
			server.WriteError(w, http.StatusBadRequest, "invalid_request", err.Error())
			return
		}
		ctx := req.Context()
		org, err := orgs.FindBySlug(ctx, deps.Pool, body.OrgSlug)
		if err != nil {
			server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		if org == nil {
			server.WriteError(w, http.StatusNotFound, "org_not_found", "No active org with slug '"+body.OrgSlug+"'")
			return
		}
		installedBy, err := getInstalledByUUID(ctx, deps.Pool)
		if err != nil {
			server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		if installedBy == "" {
			server.WriteError(w, http.StatusConflict, "not_installed", "Hearth is not installed yet")
			return
		}
		sysadminWireID := uuidToWire("usr", installedBy)

		ticketWireID, err := ids.Generate(ids.PrefixTicket)
		if err != nil {
			server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		ticketUUID, err := ids.UUIDFromHearthID(ticketWireID)
		if err != nil {
			server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}

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
		if _, err := tx.Exec(ctx,
			`INSERT INTO ticket (id, org_id, customer_email, subject, body)
			 VALUES ($1, $2, $3, $4, $5)`,
			ticketUUID, org.UUID, body.CustomerEmail, body.Subject, body.Body,
		); err != nil {
			server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		if err := tx.Commit(ctx); err != nil {
			server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		committed = true

		// C2 (security-audit-v0.3.md): customer share relation MUST be
		// 'commenter' — the customer endpoints below enforce it and a
		// mismatch would silently 403 the customer flow.
		res, err := deps.ShareStore.CreateShare(authz.CreateShareInput{
			ObjectType:       "ticket",
			ObjectID:         ticketWireID,
			Relation:         "commenter",
			CreatedBy:        sysadminWireID,
			ExpiresInSeconds: shareTTLSeconds,
		})
		if err != nil {
			server.WriteError(w, http.StatusInternalServerError, "internal", "create share: "+err.Error())
			return
		}

		orgName := body.OrgSlug
		if org.Name != nil && *org.Name != "" {
			orgName = *org.Name
		}
		// Email delivery is best-effort; a mailpit hiccup must not
		// fail the ticket submission.
		_ = deps.Mailer.SendShareLink(email.ShareLinkEmail{
			To:            body.CustomerEmail,
			OrgName:       orgName,
			TicketSubject: body.Subject,
			ShareToken:    res.Token,
		})

		server.WriteJSON(w, http.StatusCreated, map[string]any{
			"ticket":    map[string]any{"id": ticketWireID, "status": "open"},
			"share":     map[string]any{"id": res.Share.ID, "expires_at": res.Share.ExpiresAt},
			"share_url": deps.Mailer.ShareURL(res.Token),
		})
	})

	// /customer/ticket + /customer/comment require share-token auth.
	r.Group(func(g chi.Router) {
		g.Use(auth.ShareHook(deps.ShareStore))

		g.Get("/customer/ticket", func(w http.ResponseWriter, req *http.Request) {
			vs := auth.ShareFromCtx(req.Context())
			if vs.ObjectType != "ticket" {
				server.WriteError(w, http.StatusForbidden, "wrong_resource", "Share does not authorize a ticket view")
				return
			}
			if vs.Relation != "commenter" {
				server.WriteError(w, http.StatusForbidden, "wrong_relation", "Share does not authorize ticket access")
				return
			}
			ticketUUID, err := normalizeObjectIDToUUID(vs.ObjectID)
			if err != nil {
				server.WriteError(w, http.StatusBadRequest, "invalid_request", err.Error())
				return
			}
			ticket, err := loadTicketByUUID(req.Context(), deps.Pool, ticketUUID)
			if err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			if ticket == nil {
				server.WriteError(w, http.StatusNotFound, "ticket_not_found", "Ticket no longer exists")
				return
			}
			comments, err := listCommentsForTicket(req.Context(), deps.Pool, ticketUUID)
			if err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			cs := make([]map[string]any, 0, len(comments))
			for _, c := range comments {
				cs = append(cs, serializeComment(c))
			}
			server.WriteJSON(w, http.StatusOK, map[string]any{
				"ticket":   serializeTicket(ticket),
				"comments": cs,
			})
		})

		g.Post("/customer/comment", func(w http.ResponseWriter, req *http.Request) {
			var body commentBody
			if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
				server.WriteError(w, http.StatusBadRequest, "invalid_request", "body must be a JSON object")
				return
			}
			if err := body.validate(); err != nil {
				server.WriteError(w, http.StatusBadRequest, "invalid_request", err.Error())
				return
			}
			vs := auth.ShareFromCtx(req.Context())
			if vs.ObjectType != "ticket" {
				server.WriteError(w, http.StatusForbidden, "wrong_resource", "Share does not authorize a ticket reply")
				return
			}
			if vs.Relation != "commenter" {
				server.WriteError(w, http.StatusForbidden, "wrong_relation", "Share does not authorize a ticket reply")
				return
			}
			ticketUUID, err := normalizeObjectIDToUUID(vs.ObjectID)
			if err != nil {
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

			var status, orgID, customerEmail, subject string
			err = tx.QueryRow(ctx,
				`SELECT status, org_id::text, customer_email, subject
				   FROM ticket WHERE id = $1 FOR UPDATE`, ticketUUID,
			).Scan(&status, &orgID, &customerEmail, &subject)
			if errors.Is(err, pgx.ErrNoRows) {
				server.WriteError(w, http.StatusNotFound, "ticket_not_found", "Ticket no longer exists")
				return
			}
			if err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			wasResolved := status == "resolved"

			commentWireID, err := ids.Generate(ids.PrefixComment)
			if err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			commentUUID, err := ids.UUIDFromHearthID(commentWireID)
			if err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}

			var saved commentRow
			var authorPtr *string
			err = tx.QueryRow(ctx, `
				INSERT INTO comment (id, ticket_id, source, author_usr_id, body)
				VALUES ($1, $2, 'customer', NULL, $3)
				RETURNING id::text, ticket_id::text, source, author_usr_id::text, body, created_at`,
				commentUUID, ticketUUID, body.Body,
			).Scan(&saved.ID, &saved.TicketID, &saved.Source, &authorPtr, &saved.Body, &saved.CreatedAt)
			if err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			saved.AuthorUsrID = authorPtr

			newStatus := status
			if wasResolved {
				newStatus = "open"
			}
			var after ticketRow
			err = tx.QueryRow(ctx, `
				UPDATE ticket
				   SET status = $2,
				       resolved_at = CASE WHEN $2 = 'resolved' THEN resolved_at ELSE NULL END,
				       updated_at = now()
				 WHERE id = $1
				 RETURNING id::text, org_id::text, customer_email, subject, body,
				           status, resolved_at, created_at, updated_at`,
				ticketUUID, newStatus,
			).Scan(&after.ID, &after.OrgID, &after.CustomerEmail, &after.Subject, &after.Body,
				&after.Status, &after.ResolvedAt, &after.CreatedAt, &after.UpdatedAt)
			if err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}

			if err := tx.Commit(ctx); err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			committed = true

			adminEmails, _ := orgs.ListAdminEmails(ctx, deps.Pool, after.OrgID)
			orgName, _ := orgs.NameOrSlug(ctx, deps.Pool, after.OrgID)
			_ = deps.Mailer.SendCustomerReplyNotification(email.CustomerReplyNotification{
				To:            adminEmails,
				OrgName:       orgName,
				TicketSubject: after.Subject,
				CustomerEmail: after.CustomerEmail,
				Reopened:      wasResolved,
			})

			server.WriteJSON(w, http.StatusCreated, map[string]any{
				"comment":  serializeComment(saved),
				"ticket":   serializeTicket(&after),
				"reopened": wasResolved,
			})
		})
	})
}
