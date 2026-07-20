# AI Editor production readiness gate

This directory is a vendor-neutral preflight for T136b/T137. It does not
select or purchase cloud resources, implement a cloud KMS adapter, deploy a
service, or turn the existing Cloudflare Quick Tunnel into production.

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
