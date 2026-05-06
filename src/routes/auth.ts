import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../lib/jwt.js';
import { HttpError } from '../middleware/error.js';

export const authRouter = Router();

const signupSchema = z.object({
  pseudo: z.string().min(2).max(40).regex(/^[a-zA-Z0-9._-]+$/),
  email: z.string().email(),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post('/signup', async (req, res, next) => {
  try {
    console.log('[signup] body reçu:', JSON.stringify({ ...req.body, password: '***' }));
    console.log('[signup] ip:', req.ip, '| origin:', req.headers.origin, '| user-agent:', req.headers['user-agent']);

    const { pseudo, email, password } = signupSchema.parse(req.body);
    console.log('[signup] validation ok — pseudo:', pseudo, 'email:', email);

    const exists = await prisma.user.findFirst({ where: { OR: [{ email }, { pseudo }] } });
    if (exists) {
      console.log('[signup] conflit — email ou pseudo déjà utilisé');
      throw new HttpError(409, 'Email ou pseudo déjà utilisé');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { pseudo, email, passwordHash },
      select: { id: true, pseudo: true, email: true },
    });
    console.log('[signup] utilisateur créé — id:', user.id);

    const access = signAccessToken({ sub: user.id, pseudo: user.pseudo });
    const refresh = signRefreshToken({ sub: user.id, pseudo: user.pseudo });
    await prisma.refreshToken.create({
      data: { token: refresh, userId: user.id, expiresAt: new Date(Date.now() + 30 * 86400_000) },
    });

    console.log('[signup] succès — 201');
    res.status(201).json({ user, access, refresh });
  } catch (err) {
    console.error('[signup] erreur:', err);
    next(err);
  }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    console.log('[login] body reçu:', JSON.stringify({ ...req.body, password: '***' }));
    console.log('[login] ip:', req.ip, '| origin:', req.headers.origin, '| user-agent:', req.headers['user-agent']);

    const { email, password } = loginSchema.parse(req.body);
    console.log('[login] validation ok — email:', email);

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      console.log('[login] utilisateur introuvable pour:', email);
      throw new HttpError(401, 'Identifiants invalides');
    }
    if (user.status === 'SUPPRIME') throw new HttpError(403, 'Utilisateur supprimé');
    if (user.status === 'DESACTIVATE') throw new HttpError(403, 'Utilisateur désactivé');

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      console.log('[login] mot de passe incorrect pour:', email);
      throw new HttpError(401, 'Identifiants invalides');
    }

    const access = signAccessToken({ sub: user.id, pseudo: user.pseudo });
    const refresh = signRefreshToken({ sub: user.id, pseudo: user.pseudo });
    await prisma.refreshToken.create({
      data: { token: refresh, userId: user.id, expiresAt: new Date(Date.now() + 30 * 86400_000) },
    });

    console.log('[login] succès — id:', user.id);
    res.json({
      user: { id: user.id, pseudo: user.pseudo, email: user.email, status: user.status, demandStatus: user.demandStatus },
      access,
      refresh,
    });
  } catch (err) {
    console.error('[login] erreur:', err);
    next(err);
  }
});

authRouter.post('/refresh', async (req, res, next) => {
  try {
    const { refresh } = z.object({ refresh: z.string() }).parse(req.body);
    const stored = await prisma.refreshToken.findUnique({ where: { token: refresh } });
    if (!stored || stored.expiresAt < new Date()) throw new HttpError(401, 'Refresh invalide');
    const payload = verifyRefreshToken(refresh);
    const access = signAccessToken({ sub: payload.sub, pseudo: payload.pseudo });
    res.json({ access });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', async (req, res, next) => {
  try {
    const { refresh } = z.object({ refresh: z.string() }).parse(req.body);
    await prisma.refreshToken.deleteMany({ where: { token: refresh } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
