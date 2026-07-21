import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const preview = path.join(root, 'deploy', 'preview')

function text(file) {
  return fs.readFileSync(path.join(preview, file), 'utf8')
}

describe('public preview deployment boundary', () => {
  it('keeps every preview listener on host loopback and away from shared 47892', () => {
    const compose = text('compose.yaml')
    assert.equal(compose.includes('47892'), false)
    const portSections = compose.match(/^\s{4}ports:\s*\n(?:^\s{6}-[^\n]*\n?)+/gm) || []
    assert.deepEqual(portSections, [
      '    ports:\n      - "127.0.0.1:7891:7891"\n'
    ])
    assert.match(compose, /AI_EDITOR_GATEWAY_HOST:\s+127\.0\.0\.1/)
    assert.match(compose, /AI_EDITOR_PROVIDER_WORKER_HOST:\s+127\.0\.0\.1/)
    assert.match(compose, /AI_EDITOR_PROVIDER_WORKER_ORIGIN:\s+http:\/\/127\.0\.0\.1:47930/)
    assert.match(compose, /--url\s*\n\s*-\s+http:\/\/127\.0\.0\.1:47920/)
    assert.match(compose, /region1\.v2\.argotunnel\.com=\$\{AI_EDITOR_CLOUDFLARED_REGION1_IP/)
    assert.match(compose, /region2\.v2\.argotunnel\.com=\$\{AI_EDITOR_CLOUDFLARED_REGION2_IP/)
    assert.match(compose, /AI_EDITOR_CLOUDFLARED_PROTOCOL:-http2/)
    assert.match(compose, /network_mode:\s+host/)
    assert.match(compose, /no-new-privileges:true/)
    assert.match(compose, /cap_drop:\s*\n\s*-\s+ALL/)
    assert.match(compose, /image:\s+\$\{AI_EDITOR_MIHOMO_IMAGE:-metacubex\/mihomo:latest\}/)
    assert.match(compose, /user:\s+"\$\{AI_EDITOR_PREVIEW_UID:-1000\}:\$\{AI_EDITOR_PREVIEW_GID:-1000\}"/)
    assert.match(compose, /state\/mihomo:\/etc\/mihomo/)
    assert.match(compose, /profiles:\s*\n\s*-\s+openvpn/)
    assert.match(compose, /\/dev\/net\/tun:\/dev\/net\/tun/)
    assert.match(compose, /cap_add:\s*\n\s*-\s+NET_ADMIN/)
    assert.match(compose, /-\s+DAC_OVERRIDE/)
    assert.match(compose, /secrets\/openvpn\/client\.ovpn:\/run\/ai-editor-vpn\/client\.ovpn:ro/)
    assert.match(compose, /secrets\/openvpn\/auth:\/run\/ai-editor-vpn\/auth:ro/)
  })

  it('does not place preview secrets or generated state in the repository', () => {
    const environment = text('.env.example')
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
    const dockerIgnore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8')
    assert.match(environment, /AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET=\s*$/m)
    assert.match(environment, /AI_EDITOR_CLOUDFLARED_PROTOCOL=http2/)
    assert.match(environment, /AI_EDITOR_CLOUDFLARED_REGION1_IP=198\.41\.192\.27/)
    assert.match(environment, /AI_EDITOR_CLOUDFLARED_REGION2_IP=198\.41\.200\.233/)
    assert.match(ignore, /deploy\/preview\/\.runtime\.env/)
    assert.match(ignore, /deploy\/preview\/state\//)
    assert.match(ignore, /deploy\/preview\/secrets\//)
    assert.match(dockerIgnore, /deploy\/preview\/secrets/)
    assert.equal(fs.existsSync(path.join(preview, '.runtime.env')), false)
  })

  it('pins the Node runtime and requires secure preview origin behavior', () => {
    const dockerfile = text('Dockerfile')
    const start = text(path.join('scripts', 'start-preview.sh'))
    const mihomo = text(path.join('scripts', 'prepare-mihomo-config.py'))
    const vpnDockerfile = text(path.join('vpn-egress', 'Dockerfile'))
    const vpnEntrypoint = text(path.join('vpn-egress', 'entrypoint.sh'))
    const tinyproxy = text(path.join('vpn-egress', 'tinyproxy.conf'))
    assert.match(dockerfile, /node:24\.16\.0-bookworm-slim/)
    assert.match(dockerfile, /USER node/)
    assert.match(start, /\^https:\/\/\[\^\/\]\+\$/)
    assert.match(start, /openssl rand -base64 48/)
    assert.match(start, /AI_EDITOR_CLOUDFLARED_REGION1_IP 198\.41\.192\.27/)
    assert.match(start, /AI_EDITOR_CLOUDFLARED_REGION2_IP 198\.41\.200\.233/)
    assert.match(start, /Registered tunnel connection/)
    assert.match(start, /grep -Ev '\^https:\/\/api\\\.trycloudflare\\\.com\$'/)
    assert.match(text(path.join('scripts', 'verify-preview.sh')), /--retry 30/)
    const bootstrap = 'compose run --rm --no-deps -T gateway node gateway/dist/bootstrap-cli.js'
    assert.match(start, new RegExp(bootstrap.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.ok(
      start.indexOf(bootstrap) < start.indexOf('compose up -d provider-worker'),
      'Gateway bootstrap must run before preview services start'
    )
    assert.match(mihomo, /config\["allow-lan"\] = False/)
    assert.match(mihomo, /config\["bind-address"\] = "127\.0\.0\.1"/)
    assert.match(mihomo, /config\.pop\(unsafe_listener/)
    assert.match(start, /--with-openvpn/)
    assert.match(start, /--with-clash and --with-openvpn are mutually exclusive/)
    assert.match(start, /AI_EDITOR_WORKER_HTTPS_PROXY http:\/\/127\.0\.0\.1:7891/)
    assert.match(start, /--profile openvpn up -d vpn-egress/)
    assert.match(vpnDockerfile, /apt-get install -y --no-install-recommends/)
    assert.match(vpnDockerfile, /openvpn/)
    assert.match(vpnDockerfile, /tinyproxy/)
    assert.equal(vpnDockerfile.includes('secrets/openvpn'), false)
    assert.match(vpnEntrypoint, /--auth-nocache/)
    assert.match(vpnEntrypoint, /--remote-cert-tls server/)
    assert.match(vpnEntrypoint, /Initialization Sequence Completed/)
    assert.match(tinyproxy, /Listen 0\.0\.0\.0/)
    assert.match(tinyproxy, /Allow 127\.0\.0\.1/)
    assert.match(tinyproxy, /Allow 172\.16\.0\.0\/12/)
  })
})
