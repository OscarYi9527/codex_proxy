# TORVYE split preproduction deployment

This deployment replaces the disposable VMware US VPN egress with a dedicated
Singapore Provider Worker while keeping the account Gateway on the China host:

```text
AI Editor -> China Gateway -> mTLS + signed request -> Singapore Worker -> ChatGPT
```

It is an invitation-only preproduction shape, not the final production shape.
It deliberately keeps SQLite and local encrypted secret envelopes, but it
requires real authentication, HTTPS, strict migration history, mTLS and
request signatures. Production still requires PostgreSQL, external deployment
secrets and a KMS/Secret Manager Worker vault.

## Fixed hosts and ports

- China Gateway SSH alias: `torvye-gateway-cn`
- Singapore Worker SSH alias: `torvye-provider-worker`
- Gateway listener: `127.0.0.1:47920`
- Worker listener: `0.0.0.0:47930`
- Worker public origin: `https://43.156.27.252:47930`

The cloud security group must allow TCP 47930 on the Singapore host **only**
from `114.132.161.56/32`. Do not expose a general HTTP/SOCKS proxy.

## Runtime files

The following are generated and Git-ignored:

- `.worker.runtime.env`
- `.gateway.runtime.env`
- `state/`
- `secrets/`

The signing secret must be identical on both hosts. The Gateway receives only
the client key/certificate and CA. The Worker receives only the server key/
certificate and CA; it never receives the Gateway private key. The CA private
key must be retained only in offline operator storage after certificates are
issued.

`AI_EDITOR_DEBIAN_MIRROR` defaults to `deb.debian.org`. The China host may set
it to an operator-approved mirror such as `mirrors.cloud.tencent.com`; it
changes only Debian packages downloaded while building the pinned image.

## Host lifecycle

```bash
./deploy/preproduction-split/scripts/bootstrap-host.sh
./deploy/preproduction-split/scripts/start-worker.sh
./deploy/preproduction-split/scripts/start-gateway.sh
```

`start-gateway.sh` creates a temporary Cloudflare Quick Tunnel and records its
origin in `state/gateway-public-origin.txt`. Quick Tunnel is a preproduction
connectivity mechanism only and must not be promoted as the final
`gateway.torvye.com` origin.

## Versioned two-host release

After the initial host bootstrap, deploy only a clean, committed revision from
the operator's Windows checkout:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .\tools\deploy-preproduction-split.ps1 `
  -Role both
```

The tool creates an archive and exact tracked-file manifest from `HEAD`, then
deploys the Singapore Worker before the China Gateway. Each host:

1. takes a non-blocking deployment lock;
2. validates every archive path and rejects links or runtime secrets;
3. builds `torvye-ai-runtime:<12-character-commit>`;
4. checks both Node entry points before touching the running service;
5. backs up the previous source manifest, commit and mode-0600 runtime file;
6. activates the prebuilt image with Compose `--no-build`;
7. runs the role-specific health verifier;
8. restores the previous source, runtime image and service automatically when
   activation or verification fails.

Uploaded files use a unique mode-0700 remote directory and are removed after
each attempt. The Windows tool also requires shared
`http://127.0.0.1:47892/live` to stay healthy with the same PID before and
after central deployment; it never restarts or repairs that shared Proxy.

For the preproduction rollback drill only, an operator can invoke the remote
installer with:

```text
TORVYE_DEPLOY_FAILPOINT=after-activate-before-verify
```

The failpoint is deliberately not exposed by the normal deployment command.
It must produce a nonzero result and restore the previous deployed commit,
runtime image and healthy service before the failpoint build is promoted.

## Stable mainland direct ingress for the invitation MVP

After the domestic Gateway has a fixed public IPv4 and the product hostname
has been added to authoritative DNS, the same isolated Gateway can replace the
Quick Tunnel without copying state back to a local machine:

```text
AI Editor Edge
  -> https://gateway.torvye.com
  -> Caddy TLS ingress on the domestic Gateway
  -> loopback Gateway 127.0.0.1:47920
  -> mTLS + signed request
  -> Singapore Provider Worker
```

This is the short-term invitation-only MVP ingress. It deliberately retains
the preproduction SQLite/envelope boundary and the hard 30-account cap. The
long-term production gate still requires PostgreSQL, KMS/Secret Manager,
SafeLine or an equivalent WAF, off-host backups and the 72-hour acceptance.

Add these Git-ignored values to `.gateway.runtime.env`:

```text
AI_EDITOR_DIRECT_PUBLIC_ORIGIN=https://gateway.torvye.com
AI_EDITOR_DIRECT_EXPECTED_IPV4=114.132.161.56
AI_EDITOR_CADDY_IMAGE=mirror.ccs.tencentyun.com/library/caddy:2.10.2-alpine
```

Before cutover, create this authoritative DNS record and wait for public
resolvers to return it:

```text
gateway.torvye.com  A  114.132.161.56
```

The Tencent Cloud security group attached to the Gateway must also allow
inbound TCP 80 and 443 from `0.0.0.0/0` (and `::/0` only when IPv6 is actually
configured). Keep 47920 closed at the cloud boundary; it is a loopback
application port. ACME certificate issuance cannot succeed when 80/443 are
merely listed in a plan but are not present as effective inbound rules.

The scripts fail before changing the runtime when DNS is absent or points
elsewhere:

```bash
./deploy/preproduction-split/scripts/audit-direct-ingress.sh
./deploy/preproduction-split/scripts/start-gateway-direct.sh
./deploy/preproduction-split/scripts/verify-gateway-direct.sh
```

`start-gateway-direct.sh` keeps a mode-0600 runtime backup, starts Caddy,
waits for a publicly trusted certificate, recreates the Gateway with the new
public origin, verifies local/public/Worker health and only then stops the
Quick Tunnel. Any failure before completion restores the old runtime origin
and leaves the existing Gateway state intact.

An ACME “Timeout during connect” is detected from Caddy logs and fails fast
with the security-group repair instruction instead of waiting through Caddy's
long retry schedule.

The domestic deployment defaults to Tencent Cloud's Docker Hub mirror because
direct pulls from `registry-1.docker.io` can time out on mainland hosts. The
image remains the official Caddy `2.10.2-alpine` content; operators may
override `AI_EDITOR_CADDY_IMAGE` with an approved private registry mirror.

Only ports 80/443 and operator SSH should be allowed by the cloud security
group. Gateway port 47920 remains loopback-only. The Worker keeps its existing
47930 source allowlist and mTLS requirement.

Do not stop the VMware deployment or its US VPN until all of these pass:

1. Worker mTLS and unsigned-client rejection.
2. Gateway local/public liveness.
3. Gateway-to-Worker mTLS.
4. Migrated account login and model catalog.
5. Real ChatGPT `gpt-5.4-mini` SSE completion.
6. Usage settlement/outbox acknowledgement.
7. AI Editor account UI and management console.

After acceptance, stop only the old VMware `vpn-egress`/preview stack and keep
its state backup for rollback.
