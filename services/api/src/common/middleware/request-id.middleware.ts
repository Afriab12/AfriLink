import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('X-Request-Id');
  // A client-supplied ID is only trusted if it looks like a UUID — otherwise
  // generate our own rather than reflect arbitrary client input back out.
  const requestId = incoming && /^[0-9a-f-]{8,64}$/i.test(incoming) ? incoming : randomUUID();
  (req as Request & { requestId: string }).requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}
