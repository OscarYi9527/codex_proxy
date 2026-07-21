#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseProxyMode } from './mode.js'
import { safeErrorText } from './logger.js'

export async function startSelectedMode(options = {}) {
  const mode = options.mode || parseProxyMode(options)
  if (mode === 'standalone') {
    const { startStandaloneServer } = await import('./server.js')
    return startStandaloneServer()
  }
  if (mode === 'edge') {
    const { startEdgeServer } = await import('./edge/edge-server.js')
    return startEdgeServer()
  }
  const compiled = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'gateway', 'dist', 'server.js')
  try {
    const { startGatewayServer } = await import(pathToFileURL(compiled).href)
    return startGatewayServer()
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error('Gateway is not built. Run npm run gateway:build first.')
    }
    throw error
  }
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  : false

if (isMain) {
  startSelectedMode().catch(error => {
    console.error(`[codex-proxy] startup failed: ${safeErrorText(error)}`)
    process.exitCode = 1
  })
}
