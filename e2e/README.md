# Hearth e2e suite

Wired in **Milestone 2**. Until then this directory is a placeholder.

| Item      | Value                                            |
| --------- | ------------------------------------------------ |
| Framework | Playwright                                       |
| Target    | `FT_API_URL=http://localhost:500X` (any backend) |

## Spec files (planned)

- `customer-flow.spec.ts` — public submit → email → reply via share link
- `agent-flow.spec.ts` — signin → MFA → assign → comment → resolve
- `admin-flow.spec.ts` — invite agent → role change → revoke share
- `adr-0013-bootstrap.spec.ts` — install wizard atomic outer transaction
