import type { FastifyInstance } from 'fastify'
import { safeErrorBody, toSafeError } from '../../common/errors.js'
import type { SafeLogger } from '../../common/logging.js'

export function registerSafeErrors(app: FastifyInstance, logger: SafeLogger): void {
  app.setErrorHandler((error, request, reply) => {
    const safe = toSafeError(error)
    logger.error('gateway.request.failed', {
      requestId: request.safeRequestId || request.id,
      code: safe.code,
      statusCode: safe.statusCode,
      internalError: error
    })
    void reply
      .status(safe.statusCode)
      .send(safeErrorBody(safe, request.safeRequestId || request.id))
  })
}
