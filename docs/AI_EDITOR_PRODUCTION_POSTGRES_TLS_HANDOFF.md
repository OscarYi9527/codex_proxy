# AI Editor production PostgreSQL TLS handoff

Date: 2026-07-21

## Scope

This vendor-neutral checkpoint completes the locally executable PostgreSQL
TLS and migration-identity boundary for T136b. It does not select a managed
PostgreSQL vendor or claim that real cloud TLS, least privilege, backup or
rollback drills have passed.

Implemented:

- production Gateway now requires `AI_EDITOR_GATEWAY_DB_DIALECT=postgres`;
- production PostgreSQL requires an existing trusted CA file;
- optional client certificate and key must be configured together;
- optional TLS server-name override is syntax-bounded;
- the `pg.Pool` TLS object always uses `rejectUnauthorized=true`;
- CA, client certificate and key contents are read from files, not copied into
  the decision document or logs;
- all connection-string `ssl*` parameters are rejected because node-postgres
  can replace the explicit TLS object when those parameters are present;
- production Gateway never auto-runs Kysely migrations, even if a manually
  constructed config incorrectly requests it;
- `AI_EDITOR_GATEWAY_MIGRATE_ON_START=true` is rejected in production;
- `npm run gateway:bootstrap` is the explicit migration/bootstrap entry point
  for a separately injected migration identity;
- production startup inspects the effective runtime role and rejects
  superuser, role/database creation, replication, RLS bypass, database
  CREATE/TEMP, schema CREATE, application-object ownership and predefined
  server file/program execution privileges.

Production environment variables:

```text
AI_EDITOR_GATEWAY_DB_DIALECT=postgres
AI_EDITOR_GATEWAY_POSTGRES_URL=<secret-injected PostgreSQL URL>
AI_EDITOR_GATEWAY_POSTGRES_TLS_CA=<mounted CA path>
AI_EDITOR_GATEWAY_POSTGRES_TLS_CERT=<optional mounted client certificate path>
AI_EDITOR_GATEWAY_POSTGRES_TLS_KEY=<optional mounted client key path>
AI_EDITOR_GATEWAY_POSTGRES_TLS_SERVER_NAME=<optional certificate DNS name>
```

The URL, passwords and certificate/private-key contents must remain in the
deployment secret system. They must not be committed or included in readiness
reports.

## Validation

- Gateway TypeScript check: passed;
- focused config, pool and runtime-role tests: `17/17`;
- complete Gateway tests: `153/153`;
- root Proxy/Edge/Worker tests: `170/170`;
- Admin Web tests: `31/31`;
- full `npm run release:check`: passed;
- tests cover production PostgreSQL enforcement, missing CA, connection-string
  TLS override rejection, partial client identity rejection, CA-only managed
  PostgreSQL, CA+client identity, production auto-migration denial and every
  forbidden runtime-role privilege.

The release gate temporarily released only the isolated preview Edge through
the repository script. Shared `47892` remained PID `32260`, `/live=ok`; the
preview Edge was restored against the same Quick Tunnel/data root as PID
`35172`, `/live=ok`.

## Remaining cloud gate

After Oscar selects the PostgreSQL service:

1. mount the vendor CA and configure the real endpoint;
2. create separate migration and runtime database roles;
3. grant only required table/sequence DML, revoke database TEMP/CREATE, keep
   application object ownership on the migration role, and let production
   startup verify the effective runtime role;
4. run migration and rollback dry runs on a disposable production-shaped
   database;
5. complete encrypted off-host backup and restore drills;
6. record those results in the production readiness decision.

Until those steps pass, the preflight remains blocked and T136b is incomplete.
