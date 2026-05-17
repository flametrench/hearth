module github.com/flametrench/hearth/backends/go

go 1.20

require (
	github.com/flametrench/flametrench-go/packages/authz v0.3.0
	github.com/flametrench/flametrench-go/packages/identity v0.3.0
	github.com/flametrench/flametrench-go/packages/tenancy v0.3.0
	github.com/go-chi/chi/v5 v5.1.0
	github.com/jackc/pgx/v5 v5.5.5
)

require (
	github.com/flametrench/flametrench-go/packages/ids v0.0.0-00010101000000-000000000000 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20221227161230-091c0ba34f0a // indirect
	github.com/jackc/puddle/v2 v2.2.1 // indirect
	golang.org/x/crypto v0.20.0 // indirect
	golang.org/x/sync v0.1.0 // indirect
	golang.org/x/sys v0.17.0 // indirect
	golang.org/x/text v0.14.0 // indirect
)

// Consume the SDK locally so Hearth catches bugs before the v0.3.0 tag.
replace (
	github.com/flametrench/flametrench-go/packages/authz => ../../../flametrench-go/packages/authz
	github.com/flametrench/flametrench-go/packages/identity => ../../../flametrench-go/packages/identity
	github.com/flametrench/flametrench-go/packages/ids => ../../../flametrench-go/packages/ids
	github.com/flametrench/flametrench-go/packages/tenancy => ../../../flametrench-go/packages/tenancy
)
