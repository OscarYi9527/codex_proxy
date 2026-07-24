# TORVYE split preproduction deployment — 2026-07-23

## Result

The preproduction route is now:

```text
AI Editor -> China Gateway (114.132.161.56)
          -> mTLS + signed request
          -> Singapore Provider Worker (43.156.27.252)
          -> ChatGPT
```

Current temporary public Gateway origin:

```text
https://peace-flashers-forum-mas.trycloudflare.com
```

This is a Cloudflare Quick Tunnel for preproduction only. It must not be
written into `product.json` or treated as the final production origin.

## Deployed revision

Proxy branch:

```text
codex/subscription-account-management
88e1e49bdb4ca64d319655ec99b832e7eaeb42d0
```

The final source revision includes:

- `preproduction` Gateway/Worker environment;
- remote Worker HTTPS and mandatory mTLS;
- strict preproduction migration history;
- encrypted local Gateway/Worker credential envelopes;
- split Docker Compose deployment;
- certificate generation and liveness verification;
- China Debian mirror override for image builds.

## Server state

- China Gateway: `/home/ubuntu/torvye/codex_proxy`
- Singapore Worker: `/home/ubuntu/torvye/codex_proxy`
- Gateway: `127.0.0.1:47920`
- Worker: `0.0.0.0:47930`
- Security group: TCP `47930`, source `114.132.161.56/32`
- Shared Windows Proxy `127.0.0.1:47892`: not stopped or modified

The VMware Gateway state was copied through an SQLite online backup. The
current local Codex subscription credential was then imported into the
preproduction Gateway and stored in the Gateway envelope credential store.
No token or private key is included in this report.

## Acceptance evidence

- Worker mTLS `/live`: PASS.
- Unsigned Worker client rejected: PASS.
- Gateway local/public/Worker liveness: PASS.
- Edge account state: `ready`.
- Model catalog: 6 authorized ChatGPT subscription models.
- Real `gpt-5.4-mini` SSE: `response.completed`, exact test text returned.
- Gateway settlement: completed Turn persisted as `settled`.
- Singapore Worker direct OpenAI HTTPS check: HTTP `401`, proving outbound
  HTTPS reachability without exposing an API key.

## Rollback

The VMware preview and its US VPN state remain available as rollback. Do not
delete them until the new route has completed the intended soak period.

The next production-only gates remain separate:

1. complete the `torvye.com` ICP filing, then re-enable the already validated
   stable Gateway DNS/TLS path (`gateway.torvye.com`);
2. named Cloudflare Tunnel or equivalent production ingress;
3. PostgreSQL and external secret/KMS vault;
4. final Code product `edge` target and release acceptance.

## 2026-07-24 direct-ingress rollback update

The stable origin completed DNS, TCP 80/443, Caddy, Let's Encrypt TLS, HSTS
and Worker mTLS validation. Tencent Cloud then intercepted the unfiled
mainland domain, so direct Caddy was stopped and the temporary Quick Tunnel
was restored. This is an ICP filing blocker, not a Gateway/Worker defect.

The deployed `start-gateway.sh` now waits up to 240 seconds for a newly issued
Quick Tunnel hostname to propagate before it publishes the origin. Windows,
the domestic host and the Singapore host all passed `/live` after the script
update; no running service was restarted for the update.
