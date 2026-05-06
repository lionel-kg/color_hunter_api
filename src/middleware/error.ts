import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Validation', details: err.flatten() });
  }
  if (err instanceof Error) {
    console.error('[error]', err);
    const status = (err as Error & { status?: number }).status ?? 500;
    return res.status(status).json({ error: err.message });
  }
  console.error('[unknown error]', err);
  return res.status(500).json({ error: 'Erreur interne' });
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
