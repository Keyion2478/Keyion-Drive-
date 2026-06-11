import type { NextFunction, Request, Response } from 'express'

export function errorMiddleware(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  const message = error instanceof Error ? error.message : 'Internal server error'
  return res.status(500).json({ code: 'INTERNAL_SERVER_ERROR', message })
}
