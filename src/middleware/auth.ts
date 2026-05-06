import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, type AccessPayload } from '../lib/jwt.js';

declare global {
  namespace Express {
    interface Request {
      user?: AccessPayload;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant' });
  }
  try {
    const token = header.slice('Bearer '.length);
    req.user = verifyAccessToken(token);
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}
