import jwt, { type SignOptions } from 'jsonwebtoken';

const ACCESS_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'dev-refresh-secret';
const ACCESS_EXPIRES = (process.env.JWT_ACCESS_EXPIRES ?? '15m') as SignOptions['expiresIn'];
const REFRESH_EXPIRES = (process.env.JWT_REFRESH_EXPIRES ?? '30d') as SignOptions['expiresIn'];

export type AccessPayload = { sub: string; pseudo: string };

export function signAccessToken(payload: AccessPayload): string {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_EXPIRES });
}

export function signRefreshToken(payload: AccessPayload): string {
  return jwt.sign(payload, REFRESH_SECRET, { expiresIn: REFRESH_EXPIRES });
}

export function verifyAccessToken(token: string): AccessPayload {
  return jwt.verify(token, ACCESS_SECRET) as AccessPayload;
}

export function verifyRefreshToken(token: string): AccessPayload {
  return jwt.verify(token, REFRESH_SECRET) as AccessPayload;
}
