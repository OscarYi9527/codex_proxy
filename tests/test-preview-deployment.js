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
    assert.equal(compose.includes('ports:'), false)
    assert.equal(compose.includes('47892'), false)
    assert.match(compose, /AI_EDITOR_GATEWAY_HOST:\s+127\.0\.0\.1/)
    assert.match(compose, /AI_EDITOR_PROVIDER_WORKER_HOST:\s+127\.0\.0\.1/)
    assert.match(compose, /AI_EDITOR_PROVIDER_WORKER_ORIGIN:\s+http:\/\/127\.0\.0\.1:47930/)
    assert.match(compose, /--url\s*\n\s*-\s+http:\/\/127\.0\.0\.1:47920/)
    assert.match(compose, /network_mode:\s+host/)
    assert.match(compose, /no-new-privileges:true/)
    assert.match(compose, /cap_drop:\s*\n\s*-\s+ALL/)
  })

  it('does not place preview secrets or generated state in the repository', () => {
    const environment = text('.env.example')
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
    const dockerIgnore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8')
    assert.match(environment, /AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET=\s*$/m)
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
    assert.match(dockerfile, /node:24\.16\.0-bookworm-slim/)
    assert.match(dockerfile, /USER node/)
    assert.match(start, /\^https:\/\/\[\^\/\]\+\$/)
    assert.match(start, /openssl rand -base64 48/)
    assert.match(mihomo, /config\["allow-lan"\] = False/)
    assert.match(mihomo, /config\["bind-address"\] = "127\.0\.0\.1"/)
    assert.match(mihomo, /config\.pop\(unsafe_listener/)
  })
})
