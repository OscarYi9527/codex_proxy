import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve()
const deployment = path.join(root, 'deploy', 'preproduction-split')

function text(file) {
  return fs.readFileSync(path.join(deployment, file), 'utf8')
    .replace(/\r\n/g, '\n')
}

describe('split preproduction deployment boundary', () => {
  it('pins the application runtime and keeps generated state out of Git', () => {
    assert.match(text('Dockerfile'), /FROM node:24\.16\.0-bookworm-slim/)
    assert.match(text('Dockerfile'), /ARG DEBIAN_MIRROR=deb\.debian\.org/)
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
    const dockerIgnore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8')
    for (const value of [
      'deploy/preproduction-split/.worker.runtime.env',
      'deploy/preproduction-split/.gateway.runtime.env',
      'deploy/preproduction-split/state/',
      'deploy/preproduction-split/secrets/'
    ]) {
      assert.match(ignore, new RegExp(value.replace(/[./]/g, '\\$&')))
    }
    assert.match(dockerIgnore, /deploy\/preproduction-split\/secrets/)
    assert.equal(fs.existsSync(path.join(deployment, '.worker.runtime.env')), false)
    assert.equal(fs.existsSync(path.join(deployment, '.gateway.runtime.env')), false)
  })

  it('exposes only the mTLS Worker and keeps Gateway on loopback', () => {
    const worker = text('worker.compose.yaml')
    const gateway = text('gateway.compose.yaml')
    assert.match(worker, /NODE_ENV: preproduction/)
    assert.match(worker, /AI_EDITOR_PROVIDER_WORKER_HOST: 0\.0\.0\.0/)
    assert.match(worker, /AI_EDITOR_PROVIDER_WORKER_PORT: "47930"/)
    assert.match(worker, /AI_EDITOR_PROVIDER_WORKER_TLS_KEY:/)
    assert.match(worker, /AI_EDITOR_PROVIDER_WORKER_TLS_CERT:/)
    assert.match(worker, /AI_EDITOR_PROVIDER_WORKER_TLS_CA:/)
    assert.match(worker, /AI_EDITOR_PROVIDER_WORKER_EXECUTOR: chatgpt-sub/)
    assert.doesNotMatch(worker, /HTTPS_PROXY|HTTP_PROXY|openvpn|mihomo|vpn-egress/i)
    assert.doesNotMatch(worker, /gateway-client-key\.pem/)

    assert.match(gateway, /NODE_ENV: preproduction/)
    assert.match(gateway, /AI_EDITOR_GATEWAY_HOST: 127\.0\.0\.1/)
    assert.match(gateway, /AI_EDITOR_GATEWAY_PORT: "47920"/)
    assert.match(gateway, /AI_EDITOR_PROVIDER_WORKER_ORIGIN:/)
    assert.match(gateway, /AI_EDITOR_PROVIDER_WORKER_CLIENT_TLS_KEY:/)
    assert.match(gateway, /AI_EDITOR_PROVIDER_WORKER_CLIENT_TLS_CERT:/)
    assert.match(gateway, /AI_EDITOR_PROVIDER_WORKER_CLIENT_TLS_CA:/)
    assert.match(gateway, /DEBIAN_MIRROR: \$\{AI_EDITOR_DEBIAN_MIRROR:-deb\.debian\.org\}/)
    assert.match(
      gateway,
      /image: \$\{AI_EDITOR_CADDY_IMAGE:-mirror\.ccs\.tencentyun\.com\/library\/caddy:2\.10\.2-alpine\}/
    )
    assert.match(gateway, /AI_EDITOR_GATEWAY_HOSTNAME:/)
    assert.match(
      gateway,
      /user: \$\{AI_EDITOR_PREPRODUCTION_UID:-1000\}:\$\{AI_EDITOR_PREPRODUCTION_GID:-1000\}/
    )
    assert.match(gateway, /127\.0\.0\.1:47920/)
    assert.match(gateway, /NET_BIND_SERVICE/)
    assert.doesNotMatch(`${worker}\n${gateway}`, /47892/)
  })

  it('verifies certificate identity, unauthorized rejection and split liveness', () => {
    const generate = text(path.join('scripts', 'generate-mtls.sh'))
    const verifyWorker = text(path.join('scripts', 'verify-worker.sh'))
    const verifyGateway = text(path.join('scripts', 'verify-gateway.sh'))
    assert.match(generate, /extendedKeyUsage=serverAuth/)
    assert.match(generate, /extendedKeyUsage=clientAuth/)
    assert.match(generate, /subjectAltName=IP:\$\{WORKER_IP\},IP:127\.0\.0\.1/)
    assert.match(verifyWorker, /openssl verify/)
    assert.match(verifyWorker, /-checkip/)
    assert.match(verifyWorker, /accepted a client without an mTLS certificate/)
    assert.match(verifyGateway, /127\.0\.0\.1:47920/)
    assert.match(verifyGateway, /worker_origin/)
    assert.match(verifyGateway, /public_origin/)
  })

  it('fails closed before replacing Quick Tunnel with stable direct TLS', () => {
    const caddy = text('Caddyfile')
    const audit = text(path.join('scripts', 'audit-direct-ingress.sh'))
    const start = text(path.join('scripts', 'start-gateway-direct.sh'))
    const verify = text(path.join('scripts', 'verify-gateway-direct.sh'))
    const readme = text('README.md')

    assert.match(caddy, /\{\$AI_EDITOR_GATEWAY_HOSTNAME\}/)
    assert.match(caddy, /reverse_proxy 127\.0\.0\.1:47920/)
    assert.match(caddy, /Strict-Transport-Security/)
    assert.match(start, /DNS is not ready/)
    assert.match(start, /direct-cutover-backups/)
    assert.match(start, /restoring the previous Gateway origin/)
    assert.match(start, /trap 'rollback \$\?' EXIT/)
    assert.match(start, /trap 'rollback 129' HUP/)
    assert.match(start, /trap 'rollback 130' INT/)
    assert.match(start, /trap 'rollback 143' TERM/)
    assert.match(start, /trap - ERR EXIT HUP INT TERM/)
    assert.match(start, /ACME cannot reach/)
    assert.match(start, /security group/)
    const afterRollbackTrap = start.slice(start.indexOf("trap 'rollback $?' ERR"))
    assert.doesNotMatch(afterRollbackTrap, /exit 1/)
    assert.match(afterRollbackTrap, /\n\s+false\n/)
    assert.match(start, /verify-gateway-direct\.sh/)
    assert.match(start, /stop cloudflared-quick/)
    assert.match(verify, /-checkhost/)
    assert.match(verify, /-checkend 1209600/)
    assert.match(verify, /strict-transport-security/)
    assert.match(verify, /worker_origin/)
    assert.match(audit, /dnsReady/)
    assert.match(audit, /getent ahostsv4/)
    assert.match(audit, /\) \|\| true/)
    assert.match(audit, /mvpCapacityReady/)
    assert.match(audit, /longTermCapacityReady/)
    assert.match(audit, /"status": "\$\{status\}"/)
    assert.match(readme, /gateway\.torvye\.com  A  114\.132\.161\.56/)
  })
})
