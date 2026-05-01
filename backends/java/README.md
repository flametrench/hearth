# Java backend (Javalin)

Wired in **Milestone 5**, gated on Maven Central publish unblock. Until then
this directory is a placeholder; during the block, install SDKs to the local
Maven repo via `mvn install` in each of the `flametrench-setup/*-java/`
directories.

| Item           | Value                                                              |
| -------------- | ------------------------------------------------------------------ |
| Framework      | Javalin                                                            |
| Runtime        | JDK 21+                                                            |
| Port           | 5004                                                               |
| Postgres       | `localhost:5504` (service `postgres-java` in `docker-compose.yml`) |
| Connection URL | `jdbc:postgresql://localhost:5504/hearth`                          |

## SDKs

- `dev.flametrench:ids`, `dev.flametrench:identity`, `dev.flametrench:tenancy`, `dev.flametrench:authz`

Maven-Central-publish-blocked as of 2026-05-01. Local install path: each
SDK's pom.xml at `flametrench-setup/{ids,identity,tenancy,authz}-java/`.
