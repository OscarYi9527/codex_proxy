// Thread route control endpoint: /control/threads/:id/route
import fs from 'fs'
import { sendJson, readJson } from '../server-utils.js'
import { normalizeRouteModel, getThreadRouteFile, readThreadRouteState, writeThreadRoute } from '../models.js'

export function handleThreadRouteReq(req, res, url) {
  const match = url.pathname.match(/^\/control\/threads\/([^/]+)\/route$/)
  if (!match) return sendJson(res, 400, { error: { type: 'invalid_request_error', message: 'Invalid route path' } })

  const threadId = decodeURIComponent(match[1])
  if (!threadId) {
    return sendJson(res, 400, { error: { type: 'invalid_request_error', message: 'threadId is required' } })
  }

  if (req.method === 'GET') {
    const state = readThreadRouteState(threadId)
    return sendJson(res, 200, {
      thread_id: threadId,
      model: state.model,
      reasoning_effort: state.reasoning_effort,
      file: getThreadRouteFile(threadId)
    })
  }

  if (req.method === 'DELETE') {
    const routeFile = getThreadRouteFile(threadId)
    try {
      if (routeFile && fs.existsSync(routeFile)) fs.unlinkSync(routeFile)
    } catch (error) {
      return sendJson(res, 500, { error: { type: 'server_error', message: error.message } })
    }
    return sendJson(res, 200, { thread_id: threadId, cleared: true })
  }

  if (req.method !== 'PUT' && req.method !== 'POST') {
    return sendJson(res, 405, { error: { type: 'invalid_request_error', message: 'Use GET, PUT, POST, or DELETE' } })
  }

  return readJson(req).then(body => {
    const model = normalizeRouteModel(body.model || body.route)
    if (!model) {
      return sendJson(res, 400, { error: { type: 'invalid_request_error', message: 'model is required' } })
    }
    const payload = writeThreadRoute(threadId, model, body.reasoning_effort || body.effort)
    return sendJson(res, 200, payload)
  }).catch(error => {
    return sendJson(res, 400, { error: { type: 'invalid_request_error', message: error.message } })
  })
}
