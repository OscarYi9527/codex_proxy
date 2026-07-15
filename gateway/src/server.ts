import { pathToFileURL } from 'node:url'
import { createGatewayApp, type GatewayApp } from './app.js'
import { loadGatewayConfig } from './config.js'

export async function startGatewayServer(): Promise<GatewayApp> {
  const config = loadGatewayConfig()
  const gateway = await createGatewayApp({ config })
  await gateway.app.listen({ host: config.host, port: config.port })
  console.log(`[ai-editor-gateway] listening on http://${config.host}:${config.port}`)
  return gateway
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false

if (isMain) {
  const gateway = await startGatewayServer()
  let stopping = false
  const stop = async (signal: string) => {
    if (stopping) return
    stopping = true
    console.log(`[ai-editor-gateway] ${signal} received`)
    await gateway.close()
    process.exit(0)
  }
  process.once('SIGINT', () => void stop('SIGINT'))
  process.once('SIGTERM', () => void stop('SIGTERM'))
}
