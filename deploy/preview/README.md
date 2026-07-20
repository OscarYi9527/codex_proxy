# AI Editor VMware Public Preview

This directory creates the temporary public pre-release environment used before
the 1–30 user cloud MVP. It is deliberately separate from the shared standalone
Proxy at `127.0.0.1:47892`.

## Topology

```text
External preview tester
  -> Cloudflare quick/named tunnel (outbound-only)
  -> Ubuntu VM loopback Gateway :47920
  -> signed loopback Provider Worker :47930
  -> optional Mihomo/Clash loopback proxy :7890
  -> ChatGPT/OpenAI test Provider
```

No VM port is published to the Internet. Gateway, Worker, Mihomo and its
controller are forced to `127.0.0.1`. Cloudflared is the only public ingress
and establishes an outbound tunnel.

## Boundaries

- `NODE_ENV=preview` requires a public HTTPS origin, real account auth, secure
  management cookies and zero `plaintext-v1` Provider credentials.
- Preview uses Git-ignored local envelope key files. It is not the production
  KMS/Secret Manager implementation.
- Quick Tunnel and Clash are for temporary invitation acceptance only.
- Do not copy the shared `47892` configuration, account files or Tokens.
- Do not pass tunnel credentials, Clash subscriptions or Provider secrets on a
  command line or commit them to Git.

## Ubuntu VM bootstrap

Run once in the Ubuntu console:

```bash
cd ~/codex_proxy
./deploy/preview/scripts/bootstrap-ubuntu.sh
```

Sign out and back in after it finishes. The script installs Docker, Compose,
OpenSSH, VMware Tools and Python YAML support. UFW permits SSH only from the
VMware NAT subnet and denies other inbound traffic.

## Quick public tunnel

Quick mode requires no Cloudflare account and returns a temporary
`trycloudflare.com` origin:

```bash
cd ~/codex_proxy/deploy/preview
./scripts/start-preview.sh --quick --executor mock
```

On the first real-auth start, the foreground bootstrap prints the fixed login
name `admin` and a randomly generated one-time password. Save it immediately:
the password is not written to preview state and is not printed again. The
account must change it on first login.

The script:

1. generates a private Gateway/Worker signing secret;
2. builds the pinned Node 24 preview image;
3. bootstraps the real-auth Gateway administrator in the foreground;
4. starts Worker on loopback;
5. starts Cloudflare Quick Tunnel and discovers its HTTPS origin;
6. starts Gateway with that exact public origin;
7. verifies local listeners and public `/live`.

The generated origin is stored in
`state/preview-origin.txt`. It changes when the quick tunnel is recreated.

VMware NAT can receive Clash `198.18.0.0/15` fake-IP answers without receiving
the corresponding TUN route. Preview therefore uses Cloudflare HTTP/2 and
pins `region1.v2.argotunnel.com` / `region2.v2.argotunnel.com` to current
Cloudflare edge addresses inside the cloudflared containers. These defaults
are preview-only and can be replaced through
`AI_EDITOR_CLOUDFLARED_REGION1_IP` and
`AI_EDITOR_CLOUDFLARED_REGION2_IP` in `.runtime.env`.

## Named preview tunnel

Create a Cloudflare tunnel manually, copy
`cloudflared-config.yml.example` to `state/cloudflared/config.yml`, and place
the Cloudflare credentials JSON beside it with mode `0600`. Then run:

```bash
./scripts/start-preview.sh \
  --named https://preview.cocoduck.live \
  --executor mock
```

The named tunnel is more convenient for repeated Code builds, but it still
does not replace the final domestic cloud ingress.

## Optional Clash/Mihomo outbound

Create the subscription secret without putting it in shell history:

```bash
install -d -m 700 secrets
read -rsp 'Clash subscription URL: ' SUBSCRIPTION_URL
printf '%s' "$SUBSCRIPTION_URL" > secrets/clash-subscription-url
unset SUBSCRIPTION_URL
chmod 600 secrets/clash-subscription-url
python3 scripts/prepare-mihomo-config.py
```

The preparation script downloads at most 8 MiB, requires Clash YAML, disables
LAN/TUN/transparent listeners and forces proxy/controller/DNS listeners to
loopback. Start the real subscription executor with:

```bash
./scripts/start-preview.sh \
  --quick \
  --with-clash \
  --executor chatgpt-sub
```

The real account must be imported through the isolated Gateway management
page. Never copy credentials from shared `47892`.

## Verification and shutdown

Inside Ubuntu:

```bash
./scripts/verify-preview.sh
./scripts/stop-preview.sh
```

From Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  D:\AI_prejoct\codex_proxy-provider-worker\tools\Test-AiEditorPreviewVm.ps1 `
  -StartVm
```

After SSH key access is enabled, add `-SshUser`, `-SshKeyPath` and the remote
repository path to run the Guest verification automatically.
