// Copyright 2026 NDC Digital, LLC
// SPDX-License-Identifier: Apache-2.0

package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/flametrench/flametrench-go/packages/authz"
	"github.com/flametrench/flametrench-go/packages/tenancy"

	"github.com/flametrench/hearth/backends/go/internal/auth"
	"github.com/flametrench/hearth/backends/go/internal/email"
	"github.com/flametrench/hearth/backends/go/internal/ids"
	"github.com/flametrench/hearth/backends/go/internal/orgs"
	"github.com/flametrench/hearth/backends/go/internal/server"
)

const agentShareTTLSeconds = 30 * 24 * 60 * 60

var (
	orgRoleRelations  = []string{"owner", "admin", "member"}
	orgAdminRelations = []string{"owner", "admin"}
)

type shareRowSummary struct {
	ID         string
	ExpiresAt  *time.Time
	RevokedAt  *time.Time
	ConsumedAt *time.Time
}

func listSharesForTicket(ctx context.Context, pool *pgxpool.Pool, uid string) ([]shareRowSummary, error) {
	rows, err := pool.Query(ctx, `
		SELECT id::text, expires_at, revoked_at, consumed_at
		  FROM shr
		 WHERE object_type = 'ticket' AND object_id = $1
		 ORDER BY created_at DESC`, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []shareRowSummary{}
	for rows.Next() {
		var s shareRowSummary
		if err := rows.Scan(&s.ID, &s.ExpiresAt, &s.RevokedAt, &s.ConsumedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func serializeShare(s shareRowSummary) map[string]any {
	return map[string]any{
		"id":          uuidToWire("shr", s.ID),
		"expires_at":  s.ExpiresAt,
		"revoked_at":  s.RevokedAt,
		"consumed_at": s.ConsumedAt,
	}
}

func checkOrgRole(deps server.Deps, usrID, orgID string, relations []string) (bool, error) {
	r, err := deps.TupleStore.CheckAny(authz.CheckAnyInput{
		SubjectType: "usr", SubjectID: usrID,
		Relations:  relations,
		ObjectType: "org", ObjectID: orgID,
	})
	if err != nil {
		return false, err
	}
	return r.Allowed, nil
}

func RegisterAgent(r chi.Router, deps server.Deps) {
	r.Group(func(g chi.Router) {
		g.Use(auth.BearerHook(deps.IdentityStore))

		g.Get("/orgs/{slug}/tickets", func(w http.ResponseWriter, req *http.Request) {
			ses := auth.SessionFromCtx(req.Context())
			slug := chi.URLParam(req, "slug")
			org, err := orgs.FindBySlug(req.Context(), deps.Pool, slug)
			if err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			if org == nil {
				server.WriteError(w, http.StatusNotFound, "org_not_found", "Org not found")
				return
			}
			orgWire := uuidToWire("org", org.UUID)
			allowed, err := checkOrgRole(deps, ses.UsrID, orgWire, orgRoleRelations)
			if err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			if !allowed {
				server.WriteError(w, http.StatusForbidden, "forbidden", "Not a member of this org")
				return
			}
			status := req.URL.Query().Get("status")
			filterAll := status == "" || status == "all"
			if !filterAll && status != "open" && status != "pending" && status != "resolved" {
				server.WriteError(w, http.StatusBadRequest, "invalid_request", "status must be one of all|open|pending|resolved")
				return
			}
			args := []any{org.UUID}
			where := `org_id = $1`
			if !filterAll {
				args = append(args, status)
				where += ` AND status = $2`
			}
			rows, err := deps.Pool.Query(req.Context(), `
				SELECT id::text, org_id::text, customer_email, subject, body, status,
				       resolved_at, created_at, updated_at
				  FROM ticket WHERE `+where+`
				 ORDER BY updated_at DESC LIMIT 50`, args...)
			if err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			defer rows.Close()
			tickets := []map[string]any{}
			for rows.Next() {
				var t ticketRow
				if err := rows.Scan(&t.ID, &t.OrgID, &t.CustomerEmail, &t.Subject, &t.Body,
					&t.Status, &t.ResolvedAt, &t.CreatedAt, &t.UpdatedAt); err != nil {
					server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
					return
				}
				tickets = append(tickets, serializeTicket(&t))
			}
			server.WriteJSON(w, http.StatusOK, map[string]any{
				"tickets": tickets,
				"org": map[string]any{
					"id":   orgWire,
					"name": org.Name,
					"slug": org.Slug,
				},
			})
		})

		g.Get("/tickets/{ticket_id}", func(w http.ResponseWriter, req *http.Request) {
			ses := auth.SessionFromCtx(req.Context())
			ticketUUID, err := ids.UUIDFromHearthID(chi.URLParam(req, "ticket_id"))
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
				server.WriteError(w, http.StatusNotFound, "ticket_not_found", "Ticket not found")
				return
			}
			orgWire := uuidToWire("org", ticket.OrgID)
			allowed, err := checkOrgRole(deps, ses.UsrID, orgWire, orgRoleRelations)
			if err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			if !allowed {
				server.WriteError(w, http.StatusForbidden, "forbidden", "Not a member of this ticket's org")
				return
			}
			comments, err := listCommentsForTicket(req.Context(), deps.Pool, ticketUUID)
			if err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			shares, err := listSharesForTicket(req.Context(), deps.Pool, ticketUUID)
			if err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			cs := make([]map[string]any, 0, len(comments))
			for _, c := range comments {
				cs = append(cs, serializeComment(c))
			}
			ss := make([]map[string]any, 0, len(shares))
			for _, s := range shares {
				ss = append(ss, serializeShare(s))
			}
			server.WriteJSON(w, http.StatusOK, map[string]any{
				"ticket":   serializeTicket(ticket),
				"comments": cs,
				"shares":   ss,
			})
		})

		g.Post("/tickets/{ticket_id}/comment", func(w http.ResponseWriter, req *http.Request) {
			ses := auth.SessionFromCtx(req.Context())
			var body commentBody
			if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
				server.WriteError(w, http.StatusBadRequest, "invalid_request", "body must be a JSON object")
				return
			}
			if err := body.validate(); err != nil {
				server.WriteError(w, http.StatusBadRequest, "invalid_request", err.Error())
				return
			}
			ticketWireID := chi.URLParam(req, "ticket_id")
			ticketUUID, err := ids.UUIDFromHearthID(ticketWireID)
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
				server.WriteError(w, http.StatusNotFound, "ticket_not_found", "Ticket not found")
				return
			}
			orgWire := uuidToWire("org", ticket.OrgID)
			allowed, err := checkOrgRole(deps, ses.UsrID, orgWire, orgRoleRelations)
			if err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			if !allowed {
				server.WriteError(w, http.StatusForbidden, "forbidden", "Not a member of this ticket's org")
				return
			}
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
			authorUUID, err := ids.UUIDFromHearthID(ses.UsrID)
			if err != nil {
				// Fall back to wireToUUID (usr_<32hex>).
				authorUUID, err = wireToUUID(ses.UsrID)
				if err != nil {
					server.WriteError(w, http.StatusBadRequest, "invalid_request", err.Error())
					return
				}
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
			if _, err := tx.Exec(ctx,
				`INSERT INTO comment (id, ticket_id, source, author_usr_id, body)
				 VALUES ($1, $2, 'agent', $3, $4)`,
				commentUUID, ticketUUID, authorUUID, body.Body,
			); err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			if _, err := tx.Exec(ctx,
				`UPDATE ticket SET status = CASE WHEN status = 'open' THEN 'pending' ELSE status END,
				                   updated_at = now()
				  WHERE id = $1`, ticketUUID,
			); err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			if err := tx.Commit(ctx); err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			committed = true

			refreshed, _ := loadTicketByUUID(req.Context(), deps.Pool, ticketUUID)
			var refreshedJSON any
			if refreshed != nil {
				refreshedJSON = serializeTicket(refreshed)
			}
			server.WriteJSON(w, http.StatusCreated, map[string]any{
				"comment": map[string]any{
					"id":            commentWireID,
					"ticket_id":     ticketWireID,
					"source":        "agent",
					"author_usr_id": ses.UsrID,
					"body":          body.Body,
				},
				"ticket": refreshedJSON,
			})
		})

		g.Post("/tickets/{ticket_id}/assign", func(w http.ResponseWriter, req *http.Request) {
			ses := auth.SessionFromCtx(req.Context())
			var b struct {
				AssigneeUsrID string `json:"assignee_usr_id"`
			}
			if err := json.NewDecoder(req.Body).Decode(&b); err != nil || !strings.HasPrefix(b.AssigneeUsrID, "usr_") {
				server.WriteError(w, http.StatusBadRequest, "invalid_request", "assignee_usr_id must be a usr_<32hex> id")
				return
			}
			ticketWireID := chi.URLParam(req, "ticket_id")
			ticketUUID, err := ids.UUIDFromHearthID(ticketWireID)
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
				server.WriteError(w, http.StatusNotFound, "ticket_not_found", "Ticket not found")
				return
			}
			orgWire := uuidToWire("org", ticket.OrgID)
			callerOk, err := checkOrgRole(deps, ses.UsrID, orgWire, orgRoleRelations)
			if err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			if !callerOk {
				server.WriteError(w, http.StatusForbidden, "forbidden", "Not a member of this ticket's org")
				return
			}
			assigneeOk, err := checkOrgRole(deps, b.AssigneeUsrID, orgWire, orgRoleRelations)
			if err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			if !assigneeOk {
				server.WriteError(w, http.StatusBadRequest, "invalid_assignee", "Assignee is not a member of this org")
				return
			}
			creator := ses.UsrID
			if _, err := deps.TupleStore.CreateTuple(authz.CreateTupleInput{
				SubjectType: "usr", SubjectID: b.AssigneeUsrID,
				Relation:    "assignee",
				ObjectType:  "ticket", ObjectID: ticketWireID,
				CreatedBy: &creator,
			}); err != nil && !authz.IsDuplicateTuple(err) {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			if _, err := deps.Pool.Exec(req.Context(),
				`UPDATE ticket SET updated_at = now() WHERE id = $1`, ticketUUID,
			); err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			refreshed, _ := loadTicketByUUID(req.Context(), deps.Pool, ticketUUID)
			var refreshedJSON any
			if refreshed != nil {
				refreshedJSON = serializeTicket(refreshed)
			}
			server.WriteJSON(w, http.StatusOK, map[string]any{
				"assignment": map[string]any{
					"ticket_id":       ticketWireID,
					"assignee_usr_id": b.AssigneeUsrID,
					"relation":        "assignee",
				},
				"ticket": refreshedJSON,
			})
		})

		setStatus := func(status, resolvedAtSQL string) http.HandlerFunc {
			return func(w http.ResponseWriter, req *http.Request) {
				ses := auth.SessionFromCtx(req.Context())
				ticketUUID, err := ids.UUIDFromHearthID(chi.URLParam(req, "ticket_id"))
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
					server.WriteError(w, http.StatusNotFound, "ticket_not_found", "Ticket not found")
					return
				}
				orgWire := uuidToWire("org", ticket.OrgID)
				allowed, err := checkOrgRole(deps, ses.UsrID, orgWire, orgRoleRelations)
				if err != nil {
					server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
					return
				}
				if !allowed {
					server.WriteError(w, http.StatusForbidden, "forbidden", "Not a member of this ticket's org")
					return
				}
				var t ticketRow
				err = deps.Pool.QueryRow(req.Context(),
					`UPDATE ticket SET status = $2, resolved_at = `+resolvedAtSQL+`, updated_at = now()
					  WHERE id = $1
					  RETURNING id::text, org_id::text, customer_email, subject, body,
					            status, resolved_at, created_at, updated_at`,
					ticketUUID, status,
				).Scan(&t.ID, &t.OrgID, &t.CustomerEmail, &t.Subject, &t.Body,
					&t.Status, &t.ResolvedAt, &t.CreatedAt, &t.UpdatedAt)
				if err != nil {
					server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
					return
				}
				server.WriteJSON(w, http.StatusOK, map[string]any{"ticket": serializeTicket(&t)})
			}
		}
		g.Post("/tickets/{ticket_id}/resolve", setStatus("resolved", "now()"))
		g.Post("/tickets/{ticket_id}/reopen", setStatus("open", "NULL"))

		g.Post("/tickets/{ticket_id}/share", func(w http.ResponseWriter, req *http.Request) {
			ses := auth.SessionFromCtx(req.Context())
			ticketWireID := chi.URLParam(req, "ticket_id")
			ticketUUID, err := ids.UUIDFromHearthID(ticketWireID)
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
				server.WriteError(w, http.StatusNotFound, "ticket_not_found", "Ticket not found")
				return
			}
			orgWire := uuidToWire("org", ticket.OrgID)
			adminOk, err := checkOrgRole(deps, ses.UsrID, orgWire, orgAdminRelations)
			if err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			if !adminOk {
				server.WriteError(w, http.StatusForbidden, "forbidden", "Only org admins can mint share tokens")
				return
			}
			var body struct {
				ResendEmail *bool `json:"resend_email"`
			}
			_ = json.NewDecoder(req.Body).Decode(&body)
			res, err := deps.ShareStore.CreateShare(authz.CreateShareInput{
				ObjectType:       "ticket",
				ObjectID:         ticketWireID,
				Relation:         "commenter",
				CreatedBy:        ses.UsrID,
				ExpiresInSeconds: agentShareTTLSeconds,
			})
			if err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			if body.ResendEmail == nil || *body.ResendEmail {
				orgName, _ := orgs.NameOrSlug(req.Context(), deps.Pool, ticket.OrgID)
				_ = deps.Mailer.SendShareLink(email.ShareLinkEmail{
					To:            ticket.CustomerEmail,
					OrgName:       orgName,
					TicketSubject: ticket.Subject,
					ShareToken:    res.Token,
				})
			}
			server.WriteJSON(w, http.StatusCreated, map[string]any{
				"share":     map[string]any{"id": res.Share.ID, "expires_at": res.Share.ExpiresAt},
				"share_url": deps.Mailer.ShareURL(res.Token),
			})
		})

		g.Post("/orgs/{org_id}/settings", func(w http.ResponseWriter, req *http.Request) {
			ses := auth.SessionFromCtx(req.Context())
			orgWire := chi.URLParam(req, "org_id")
			if !strings.HasPrefix(orgWire, "org_") {
				server.WriteError(w, http.StatusBadRequest, "invalid_request", "Path must be an org_<32hex> id")
				return
			}
			adminOk, err := checkOrgRole(deps, ses.UsrID, orgWire, orgAdminRelations)
			if err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			if !adminOk {
				server.WriteError(w, http.StatusForbidden, "forbidden", "Only org admins can update settings")
				return
			}
			// Decode into a map first so we can distinguish "key
			// missing" (preserve current value) from "key present and
			// null" (clear field).
			raw := map[string]json.RawMessage{}
			_ = json.NewDecoder(req.Body).Decode(&raw)
			update := tenancy.UpdateOrgInput{}
			if v, ok := raw["name"]; ok {
				if string(v) == "null" {
					update.ClearName = true
				} else {
					var n string
					if err := json.Unmarshal(v, &n); err == nil {
						update.Name = &n
					}
				}
			}
			if v, ok := raw["slug"]; ok {
				if string(v) == "null" {
					update.ClearSlug = true
				} else {
					var sl string
					if err := json.Unmarshal(v, &sl); err == nil {
						update.Slug = &sl
					}
				}
			}
			updated, err := deps.TenancyStore.UpdateOrg(orgWire, update)
			if err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			server.WriteJSON(w, http.StatusOK, map[string]any{
				"org": map[string]any{
					"id":     updated.ID,
					"name":   updated.Name,
					"slug":   updated.Slug,
					"status": updated.Status,
				},
			})
		})

		g.Post("/shares/{shr_id}/revoke", func(w http.ResponseWriter, req *http.Request) {
			ses := auth.SessionFromCtx(req.Context())
			shrID := chi.URLParam(req, "shr_id")
			if !strings.HasPrefix(shrID, "shr_") {
				server.WriteError(w, http.StatusBadRequest, "invalid_request", "Path must be a shr_<32hex> id")
				return
			}
			share, err := deps.ShareStore.GetShare(shrID)
			if err != nil {
				server.WriteError(w, http.StatusNotFound, "share_not_found", "Share not found")
				return
			}
			if share.ObjectType != "ticket" {
				server.WriteError(w, http.StatusBadRequest, "wrong_resource", "Share does not reference a ticket")
				return
			}
			ticketUUID, err := normalizeObjectIDToUUID(share.ObjectID)
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
			orgWire := uuidToWire("org", ticket.OrgID)
			adminOk, err := checkOrgRole(deps, ses.UsrID, orgWire, orgAdminRelations)
			if err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			if !adminOk {
				server.WriteError(w, http.StatusForbidden, "forbidden", "Only org admins can revoke shares")
				return
			}
			revoked, err := deps.ShareStore.RevokeShare(shrID)
			if err != nil {
				server.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			server.WriteJSON(w, http.StatusOK, map[string]any{
				"share": map[string]any{
					"id":         revoked.ID,
					"revoked_at": revoked.RevokedAt,
					"expires_at": revoked.ExpiresAt,
				},
			})
		})
	})
}

// silence "unused" if pgx is only needed for types — we use it in
// loadTicketByUUID below.
var _ = errors.New
var _ = pgx.ErrNoRows
