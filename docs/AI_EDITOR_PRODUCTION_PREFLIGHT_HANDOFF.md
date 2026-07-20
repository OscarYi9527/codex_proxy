# AI Editor production preflight handoff

Date: 2026-07-21

## Purpose

This checkpoint prepares the operator-facing T136b/T137 decision gate while
human operators are offline. It does not select a cloud vendor, purchase
resources, implement a cloud KMS adapter, approve deployment or claim that the
Cloudflare Quick Tunnel is production.

Implemented:

- vendor-neutral production decision document;
- fail-closed CLI with a machine-readable report;
- explicit 30-account short-term capacity check;
- domestic Gateway sizing, stable HTTPS origin, ICP, WAF and KMS checks;
- authorized-region Worker sizing, stable HTTPS origin, mTLS and
  KMS/Secret Manager checks;
- PostgreSQL 16+, `verify-full`, least-privilege, migration and rollback
  dry-run checks;
- encrypted/versioned off-host backup, retention and restore-drill checks;
- host/disk/certificate/Gateway/Worker/backup alert checks;
- full-SHA source pinning, release/secret/final-Edge gates;
- separate infrastructure, security and production deployment approvals;
- rejection of decision fields that appear to contain passwords, API keys,
  Tokens, signing secrets, private keys or Provider credentials;
- explicit rejection of localhost, IP and `trycloudflare.com` production
  origins.

## Files

- `deploy/production/readiness.example.json`
- `deploy/production/README.md`
- `scripts/check-production-readiness.mjs`
- `tests/test-production-readiness.js`

## Commands

Safe blocked report using the committed placeholder document:

```powershell
npm run production:preflight -- `
  --config deploy\production\readiness.example.json `
  --report .ai-editor-dev\production-readiness-report.json `
  --report-only
```

Strict operator gate after all decisions and approvals are recorded:

```powershell
npm run production:preflight -- `
  --config D:\secure-operator-state\ai-editor-production-readiness.json `
  --report D:\secure-operator-state\ai-editor-production-readiness-report.json
```

Blocked strict checks exit with code `2`; malformed input exits with code `1`.
`--report-only` records missing decisions without turning an expected
pre-purchase state into a CI failure.

## Automated evidence

- focused production gate tests: `4/4`;
- root Proxy/Edge/Worker tests: `170/170`;
- Gateway: `136/136`;
- Admin Web: `31/31`;
- full `npm run release:check`: passed;
- shared Proxy remained PID `32260`, `/live=ok`;
- preview Edge was released only through the repository script for the full
  release gate and restored against the same Quick Tunnel/data root as PID
  `48732`, `/live=ok`.

## Remaining human decisions

T136b remains pending. Oscar must still confirm:

1. domestic Gateway cloud, mainland region and KMS;
2. Provider-authorized Worker cloud, region and KMS/Secret Manager;
3. PostgreSQL service;
4. off-host versioned object storage;
5. stable production Gateway/Worker domain plan and ICP path;
6. infrastructure and security approval.

After those choices, implement and cloud-test the selected KMS adapters,
perform database/backup/certificate drills, then request a separate T137
production deployment approval. T138 remains the 72-hour, three-network,
20-SSE and 30-minute connection acceptance.

The vendor-neutral PostgreSQL TLS and migration-identity boundary completed
after this preflight is documented in
`docs/AI_EDITOR_PRODUCTION_POSTGRES_TLS_HANDOFF.md`.
