# AI Editor Provider Credential Encryption T136a Handoff

Date: 2026-07-20

## Scope

This checkpoint completes the locally executable part of T136/PW3. It does not
claim that a production cloud KMS/Secret Manager has been selected or
integrated.

Implemented:

- AES-256-GCM envelope encryption for every Gateway Provider credential;
- one random DEK per credential and KEK-only DEK wrapping;
- authenticated binding to credential ID, Provider ID, credential version and
  secret purpose;
- `envelope-v1`, `key_version` and monotonic `credential_version` persistence;
- fail-closed decryption when ciphertext, nonce, tag, wrapped DEK, AAD or master
  key is wrong;
- read-back-verified, idempotent `plaintext-v1` migration;
- DEK-only rewrap during master-key rotation;
- encrypted SQLite online backups and authenticated restore with SQLite
  integrity verification;
- backup-before-schema/data-migration ordering for mutating CLI operations;
- encrypted Worker persistence for refreshed ChatGPT Access/Refresh/ID Tokens
  and expiry;
- Worker restart recovery, administrator credential replacement protection,
  key rotation, tamper rejection and copy/restore tests;
- release boundary inclusion for the Worker credential vault.

The Gateway management API still returns only a masked preview. It never
returns a complete credential, encrypted payload or wrapped DEK.

## Local key boundary

Development and test environments use Git-ignored key files:

```text
gateway-credential-master-keys.gateway-secret
provider-worker-credential-master-keys.worker-secret
```

These files are for isolated local development only. Production Gateway and
Provider Worker startup fail closed unless an external KMS/Secret Manager
implementation is injected. There is no automatic fallback to a local key
file in production.

T136b remains blocked on the explicit choice of:

- the domestic Gateway cloud/KMS;
- the authorized-region Worker cloud/KMS or Secret Manager;
- production PostgreSQL and encrypted object-storage backup services.

The vendor-neutral decision preflight added on 2026-07-21 is documented in
`docs/AI_EDITOR_PRODUCTION_PREFLIGHT_HANDOFF.md`. It records and validates the
future choices without storing secrets, but intentionally cannot satisfy
T136b until the selected cloud adapters and real recovery drills exist.

## Operator commands

Run from the repository root against the isolated development Gateway:

```powershell
npm run gateway:credentials -- status
npm run gateway:credentials -- verify
npm run gateway:credentials -- backup
npm run gateway:credentials -- migrate
npm run gateway:credentials -- rotate
npm run gateway:credentials -- restore --source <backup.gateway-backup> --destination <new.sqlite>
```

`migrate` and `rotate` require an existing SQLite database and an active
level-1 administrator. They create an encrypted backup before changing the
database or credentials. `restore` refuses to overwrite an existing
destination.

## Validation

Latest local validation:

- syntax and TypeScript checks: passed;
- standalone/Edge/Worker root tests: `156/156`;
- Provider Worker focused tests: `18/18`;
- Gateway: `126/126`;
- Admin Web: `28/28`;
- release check: passed;
- `npm audit --audit-level=high`: `0 vulnerabilities`;
- Provider Worker runtime boundary: `29` allowlisted files; built artifact:
  `30` files including its release manifest;
- built Worker artifact: started on isolated `127.0.0.1:47930` and returned
  `/live.status=ok`.

Tests cover ciphertext/AAD tampering, wrong keys, migration interruption and
resume, credential-version replacement, key rewrap, encrypted backup restore,
Worker restart recovery and refreshed OAuth Token persistence.

## Release gate

Do not expose the Gateway or Worker as a public production service while any
of the following is true:

- T136b production KMS/Secret Manager adapters are not implemented;
- real credentials remain `plaintext-v1`;
- production backup key custody and restore drills are not complete;
- production PostgreSQL TLS/least-privilege, mTLS certificate rotation and
  secret-scan gates have not passed.

The shared standalone Proxy at `127.0.0.1:47892` is outside this migration and
must not be modified or restarted for T136.
