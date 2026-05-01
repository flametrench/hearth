-- Hearth app-side schema.
-- Applied AFTER shared/sql/flametrench-schema.sql by every backend at startup.
--
-- Convention: UUID primary keys (matching Flametrench reference schema). The
-- application layer wraps them in `inst_`, `ticket_`, `comment_` wire-format
-- prefixes via the @flametrench/ids SDK (Node) and per-language equivalents.
-- App-defined prefixes are spec#8-supported in v0.2.

-- ===========================================================================
-- inst — singleton install row
-- ===========================================================================
--
-- One row per Hearth install. The `singleton` partial unique index pins
-- this to exactly one row. `mfa_policy` is decided at install time by the
-- wizard (decision #3 from the Hearth plan).
--
-- (usr, sysadmin, inst.id) tuples in the Flametrench `tup` table grant
-- sysadmin access to /admin/* routes.
CREATE TABLE inst (
    id            UUID PRIMARY KEY,
    singleton     BOOLEAN NOT NULL DEFAULT TRUE
                    CHECK (singleton = TRUE),
    mfa_policy    TEXT NOT NULL DEFAULT 'off'
                    CHECK (mfa_policy IN ('off', 'admins', 'all')),
    installed_by  UUID NOT NULL REFERENCES usr(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX inst_singleton_idx ON inst (singleton);

-- ===========================================================================
-- ticket — customer-submitted support request bound to an org
-- ===========================================================================
--
-- The customer is identified only by `customer_email` (a string, not a
-- Flametrench identity). Customer access flows through a `shr` token bound
-- to the ticket; see ADR 0012 + decision #5 (one share per ticket, no
-- cross-org aggregation).
--
-- Status machine: open → pending → resolved, with reopen back to open. A
-- customer reply on a `resolved` ticket auto-reopens it (app-layer logic).
CREATE TABLE ticket (
    id              UUID PRIMARY KEY,
    org_id          UUID NOT NULL REFERENCES org(id),
    customer_email  TEXT NOT NULL,
    subject         TEXT NOT NULL,
    body            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'pending', 'resolved')),
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Inbox queries: per-org, filter by status, order by recency.
CREATE INDEX ticket_org_status_updated_idx
    ON ticket (org_id, status, updated_at DESC);

-- ===========================================================================
-- comment — threaded message under a ticket (dual-source)
-- ===========================================================================
--
-- Agent comments have a Flametrench identity (`author_usr_id`); customer
-- comments do not (the customer has no `usr` row by design — see Hearth
-- plan §1 "disjoint populations"). The CHECK enforces this disjunction.
CREATE TABLE comment (
    id             UUID PRIMARY KEY,
    ticket_id      UUID NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
    source         TEXT NOT NULL
                     CHECK (source IN ('agent', 'customer')),
    author_usr_id  UUID REFERENCES usr(id),
    body           TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT comment_author_matches_source
      CHECK ((source = 'agent'    AND author_usr_id IS NOT NULL)
          OR (source = 'customer' AND author_usr_id IS NULL))
);

CREATE INDEX comment_ticket_created_idx
    ON comment (ticket_id, created_at);
