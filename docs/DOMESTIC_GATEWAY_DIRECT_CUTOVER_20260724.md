# TORVYE domestic Gateway direct-ingress cutover

Date: 2026-07-24

## Objective

Replace the local/VMware and temporary Quick Tunnel ingress with the registered
mainland Gateway while preserving the existing Singapore Provider Worker:

```text
AI Editor Edge
  -> https://gateway.torvye.com
  -> domestic TLS ingress
  -> Gateway 127.0.0.1:47920
  -> mTLS + signed request
  -> Singapore Provider Worker 43.156.27.252:47930
  -> ChatGPT subscription route
```

The local Edge on each product device remains part of the product security
boundary. It is not a local account/Gateway server and must not be removed.

## Audited domestic host

- Tencent Cloud instance: `ins-05jlq40e`
- Name: `torvye-gateway-cn-01`
- Region: Guangzhou (`ap-guangzhou`)
- Public IPv4: `114.132.161.56`
- Private IPv4: `172.16.0.15`
- Security group: `sg-qv7wiiud`
- OS: Ubuntu 24.04.4 LTS
- Capacity: 2 vCPU, 3.6 GiB RAM, 50 GiB system disk, 5 Mbps
- Docker: 29.1.3
- Docker Compose: 2.40.3

This capacity passes the bounded invitation-MVP minimum implemented by the
audit script. It does not pass the long-term 4 vCPU / 8 GiB / 100 GiB target
and must be upgraded before the 30-account invitation test produces evidence
that the larger production load is needed.

## Current safe state

- Gateway listens only on `127.0.0.1:47920`.
- The active public ingress remains
  `https://manager-oak-carmen-despite.trycloudflare.com`.
- The existing Gateway-to-Singapore Worker route remains healthy.
- The Quick Tunnel and Gateway containers survived every failed direct-ingress
  experiment.
- No local/shared `127.0.0.1:47892` process was stopped or changed.

## Delivered implementation

Proxy branch:

```text
codex/subscription-account-management
9d2bec9
```

Added:

- Caddy direct TLS ingress with loopback reverse proxy;
- Tencent Cloud Docker Hub mirror fallback;
- DNS, hardware, listener and firewall audit;
- fail-closed direct cutover;
- mode-0600 runtime backups;
- automatic rollback to the old Gateway origin;
- TLS hostname/expiry, HSTS, `/live`, `/ready` and Worker mTLS verification;
- Quick Tunnel shutdown only after complete direct-path acceptance.

## Automated and runtime evidence

- Bash syntax checks: PASS.
- deployment boundary tests: `4/4`.
- Proxy root tests: `203/203`.
- workspace type checks: PASS.
- Docker Compose config on the real domestic host: PASS.
- Caddy config validation on the real domestic host: PASS.
- Direct-ingress audit:
  - MVP capacity: ready;
  - Gateway loopback boundary: ready;
  - ports 80/443 locally available;
  - formal DNS: blocked.
- The first Caddy image pull from Docker Hub timed out. The implementation now
  uses Tencent Cloud's mirror for the same pinned official image.
- A real ACME attempt using temporary DNS reached Let's Encrypt but the
  external challenge timed out on both TCP 80 and 443.
- The script now detects that condition within seconds and reports the exact
  security-group action instead of waiting through Caddy's long retry cycle.
- A second real failure-path run proved automatic rollback:
  - runtime origin restored to the Quick Tunnel;
  - Gateway recreated successfully;
  - Caddy stopped;
  - local and public Gateway `/live` both returned `status=ok`.

## Required operator actions

These two external-state changes cannot be performed from the host because it
has no Tencent Cloud CAM role and no DNSPod API credential:

1. In security group `sg-qv7wiiud`, add effective inbound rules:
   - TCP 80 from `0.0.0.0/0`;
   - TCP 443 from `0.0.0.0/0`;
   - keep TCP 47920 and 47930 closed on the domestic Gateway;
   - keep SSH limited to the operator network where practical.
2. In DNSPod for `torvye.com`, add:
   - host: `gateway`;
   - type: `A`;
   - value: `114.132.161.56`;
   - TTL: `600`;
   - no CDN/proxy indirection during first certificate issuance.

For a mainland public production service, complete the required ICP filing
before inviting external users. DNS and ACME can be validated first, but a
successful certificate alone is not evidence of regulatory readiness.

## Cutover after the operator actions

Restore the formal origin in the Git-ignored runtime file and run:

```bash
cd /home/ubuntu/torvye/codex_proxy
./deploy/preproduction-split/scripts/audit-direct-ingress.sh
./deploy/preproduction-split/scripts/start-gateway-direct.sh
./deploy/preproduction-split/scripts/verify-gateway-direct.sh
```

The final audit must show `status=READY`, `dnsReady=true` and
`mvpCapacityReady=true`. The cutover is complete only after:

1. trusted TLS and HSTS pass;
2. public `/live` and `/ready` pass;
3. Gateway-to-Worker mTLS passes;
4. Quick Tunnel is stopped;
5. Windows Edge is rebound to `https://gateway.torvye.com`;
6. Code login, management Webview, model catalog and a real
   `gpt-5.6-terra` SSE Turn pass;
7. the Windows product is rebuilt with `productTarget=edge` and checksum
   verification passes.
