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
