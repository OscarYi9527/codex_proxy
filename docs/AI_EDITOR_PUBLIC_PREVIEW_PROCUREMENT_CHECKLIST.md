# AI Editor Public Preview and MVP Procurement Checklist

Date: 2026-07-20

## Current VMware preview

No purchase is required to complete the first temporary public preview:

- existing Windows host and Ubuntu VMware VM;
- Cloudflare Quick Tunnel free temporary origin;
- local SQLite and local envelope key files;
- existing authorized test Provider account;
- existing Clash subscription, if it is still authorized and usable.

A free Cloudflare account plus control of `cocoduck.live` is required only when
switching from a random Quick Tunnel URL to
`https://preview.cocoduck.live`.

## Before inviting external preview testers

Prepare:

- one dedicated AI Editor test administrator;
- one dedicated ChatGPT subscription test account or limited Provider API
  balance;
- a Cloudflare account and DNS control if a stable preview hostname is needed;
- a backup destination outside the VM for encrypted Gateway backups;
- a host power/network availability window and a rollback contact.

Do not buy SafeLine, a WAF subscription, Redis or a managed database merely for
the first 3–10 person temporary preview.

## Before the 1–30 user public MVP

The recorded short-term production architecture requires:

1. **Domestic Gateway host**
   - initial size: 4 vCPU, 8 GB RAM, 100 GB SSD/data disk;
   - fixed public IP and at least 5–10 Mbps usable bandwidth;
   - eligible for the `cocoduck.live` ICP filing and HTTPS service;
   - runs SafeLine, Gateway and short-term PostgreSQL.
2. **Authorized-region Provider Worker**
   - initial size: 2 vCPU, 4 GB RAM, 40–80 GB disk;
   - fixed public IP in a Provider-supported region;
   - only its mTLS Gateway endpoint is exposed.
3. **Domain and certificate**
   - keep `cocoduck.live` if ownership is confirmed;
   - ICP filing for a mainland ingress;
   - ACME/TLS certificate can initially be free.
4. **Secret management**
   - KMS/Secret Manager for the domestic Gateway;
   - KMS/Secret Manager for the overseas Worker;
   - separate keys and least-privilege identities.
5. **Backups**
   - versioned object storage outside the Gateway host;
   - encrypted PostgreSQL and configuration backups;
   - lifecycle policy and one completed restore drill.
6. **Provider capacity**
   - dedicated authorized ChatGPT subscription accounts for the experimental
     channel;
   - API credits for any OpenAI/API Provider offered to testers.
7. **Monitoring**
   - host, disk, certificate, Gateway, Worker and backup alerts;
   - cloud-native basic monitoring is sufficient for the 30-user invitation
     MVP.

SafeLine Community Edition does not require a software purchase. Clash and
Cloudflare Quick Tunnel must not be counted as production dependencies.

## Do not purchase yet

Until the 3–10 person preview and 72-hour acceptance provide evidence, do not
purchase:

- a second Gateway or load balancer;
- a second/hot Worker;
- managed PostgreSQL primary/standby;
- Redis;
- paid CDN/WAF/Anti-DDoS tiers;
- multi-region disaster recovery.

These become mandatory before user 31 according to the long-term roadmap.
