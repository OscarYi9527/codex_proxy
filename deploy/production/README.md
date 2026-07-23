# AI Editor production readiness gate

This directory is a vendor-neutral preflight for T136b/T137. It does not
select or purchase cloud resources, implement a cloud KMS adapter, deploy a
service, or turn the existing Cloudflare Quick Tunnel into production.

## Frozen TORVYE origins

The user-owned production names are now frozen as:

```text
Gateway and management: https://gateway.torvye.com
Provider Worker:        https://worker.torvye.com
```

`gateway.torvye.com` serves the API and same-origin `/admin` management
surface. Do not create a wildcard record and do not place management on a
second origin. `worker.torvye.com` is not a user-facing service: its listener
must require Gateway mTLS and network allowlisting.

The committed decision example records these names but deliberately remains
blocked. Registration alone is not deployment readiness. After the domestic
Gateway fixed public IP and SafeLine ingress exist, create only:

```text
gateway  A     <domestic fixed public IP>   TTL 600
```

Add `AAAA` only after IPv6 ingress has been configured and tested. If ACME is
used, an optional `CAA` record may restrict issuance to the selected CA. Do not
point the production name at a random Quick Tunnel.

Before changing the AI Editor product target, run:

```powershell
npm run production:origin-preflight -- `
  --origin https://gateway.torvye.com `
  --expected-host gateway.torvye.com `
  --report .ai-editor-dev\gateway-origin-readiness.json
```

The command validates the exact origin, routable DNS, hostname-authorized TLS
with at least 14 days remaining, and HTTP `200` JSON `status=ok` from `/live`.
Use `--report-only` while DNS/TLS are still being provisioned; `BLOCKED` is the
expected result. The final command must return `PASS` before Code pins the
origin or switches its bundled release target to `edge`.

Copy `readiness.example.json` to a Git-ignored operator location, replace only
the non-secret decision fields, and run:

```powershell
npm run production:preflight -- `
  --config D:\secure-operator-state\ai-editor-production-readiness.json `
  --report D:\secure-operator-state\ai-editor-production-readiness-report.json
```

Before decisions are complete, generate a safe blocked report without making
the command fail:

```powershell
npm run production:preflight -- `
  --config deploy\production\readiness.example.json `
  --report .ai-editor-dev\production-readiness-report.json `
  --report-only
```

The decision document must never contain database URLs, passwords, API keys,
Tokens, signing secrets, private keys or Provider credentials. The checker
rejects fields whose names indicate such content. Real secrets stay in the
selected KMS/Secret Manager and deployment secret injection system.

`result=ready` means only that all recorded technical decisions, dry runs and
human approvals are present. T136b remains incomplete until the selected
Gateway and Worker KMS adapters exist and pass their real cloud tests. T137
still requires explicit production deployment approval, and T138 still
requires the 72-hour multi-network acceptance.
