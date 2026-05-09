import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { getIO } from '../sockets/games.js';

export const usersRouter = Router();

usersRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: {
        id: true, pseudo: true, email: true, avatarUrl: true, city: true,
        cameraModel: true, status: true, demandStatus: true, isProfilePrivate: true, createdAt: true,
      },
    });
    if (!user) throw new HttpError(404, 'Utilisateur introuvable');
    res.json(user);
  } catch (err) {
    next(err);
  }
});

usersRouter.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const data = z.object({
      pseudo: z.string().min(2).max(40).optional(),
      city: z.string().max(80).nullable().optional(),
      isProfilePrivate: z.boolean().optional(),
      avatarUrl: z.string().url().nullable().optional(),
      cameraModel: z.string().max(120).nullable().optional(),
    }).parse(req.body);

    const user = await prisma.user.update({
      where: { id: req.user!.sub },
      data,
      select: { id: true, pseudo: true, email: true, isProfilePrivate: true, city: true, avatarUrl: true, cameraModel: true },
    });
    res.json(user);
  } catch (err) {
    next(err);
  }
});

// Demande de suppression (cahier des charges §A — Système de Statuts)
usersRouter.post('/me/deletion-request', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.sub } });
    if (!user) throw new HttpError(404, 'Utilisateur introuvable');
    if (user.demandStatus === 'EN_COURS') throw new HttpError(409, 'Demande déjà en cours');
    if (user.demandStatus === 'VALIDEE') throw new HttpError(409, 'Demande déjà validée');

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { demandStatus: 'EN_COURS', status: 'DEPART' },
      select: { id: true, status: true, demandStatus: true },
    });
    res.json({ ...updated, message: 'Demande de suppression en cours' });
  } catch (err) {
    next(err);
  }
});

usersRouter.delete('/me/deletion-request', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.sub } });
    if (!user) throw new HttpError(404, 'Utilisateur introuvable');
    if (user.demandStatus !== 'EN_COURS') throw new HttpError(400, 'Aucune demande en cours');

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { demandStatus: 'NONE', status: 'ACTIVE' },
      select: { id: true, status: true, demandStatus: true },
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// Profil public d'un utilisateur
usersRouter.get('/:userId/profile', requireAuth, async (req, res, next) => {
  try {
    const meId = req.user!.sub;
    const targetId = req.params.userId;

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, pseudo: true, avatarUrl: true, city: true, cameraModel: true, isProfilePrivate: true, createdAt: true },
    });
    if (!target) throw new HttpError(404, 'Utilisateur introuvable');

    const isFriend = meId !== targetId && !!(await prisma.friendship.findFirst({
      where: {
        status: 'ACCEPTED',
        OR: [
          { senderId: meId, receiverId: targetId },
          { senderId: targetId, receiverId: meId },
        ],
      },
    }));

    const canSeePrivate = meId === targetId || isFriend;

    const [grids, friendCount] = await Promise.all([
      target.isProfilePrivate && !canSeePrivate
        ? Promise.resolve([])
        : prisma.grid.findMany({
            where: {
              userId: target.id,
              ...(meId !== targetId ? { visibility: 'PUBLIC' } : {}),
            },
            include: {
              game: { select: { inviteCode: true, mode: true } },
              _count: { select: { comments: true, likes: true } },
            },
            orderBy: { createdAt: 'desc' },
          }),
      prisma.friendship.count({
        where: { status: 'ACCEPTED', OR: [{ senderId: target.id }, { receiverId: target.id }] },
      }),
    ]);

    res.json({ ...target, grids, friendCount });
  } catch (err) {
    next(err);
  }
});

// ─── AMIS ────────────────────────────────────────────────────────────

// Envoyer une demande d'ami
usersRouter.post('/friends/request/:userId', requireAuth, async (req, res, next) => {
  try {
    const targetId = req.params.userId;
    const meId = req.user!.sub;
    if (targetId === meId) throw new HttpError(400, 'Tu ne peux pas t\'ajouter toi-même');

    const target = await prisma.user.findUnique({ where: { id: targetId } });
    if (!target) throw new HttpError(404, 'Utilisateur introuvable');

    // Vérifie qu'une relation n'existe pas déjà dans un sens ou l'autre
    const existing = await prisma.friendship.findFirst({
      where: {
        OR: [
          { senderId: meId, receiverId: targetId },
          { senderId: targetId, receiverId: meId },
        ],
      },
    });
    if (existing) throw new HttpError(409, 'Une relation existe déjà');

    const friendship = await prisma.friendship.create({
      data: { senderId: meId, receiverId: targetId },
      include: {
        sender: { select: { id: true, pseudo: true, avatarUrl: true } },
        receiver: { select: { id: true, pseudo: true, avatarUrl: true } },
      },
    });

    // Notifier le destinataire en temps réel
    getIO().to(`user:${targetId}`).emit('friend:request', friendship);

    res.status(201).json(friendship);
  } catch (err) {
    next(err);
  }
});

// Accepter une demande d'ami
usersRouter.post('/friends/accept/:friendshipId', requireAuth, async (req, res, next) => {
  try {
    const friendship = await prisma.friendship.findUnique({ where: { id: req.params.friendshipId } });
    if (!friendship) throw new HttpError(404, 'Demande introuvable');
    if (friendship.receiverId !== req.user!.sub) throw new HttpError(403, 'Pas autorisé');
    if (friendship.status !== 'PENDING') throw new HttpError(400, 'Demande déjà traitée');

    const updated = await prisma.friendship.update({
      where: { id: friendship.id },
      data: { status: 'ACCEPTED' },
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// Refuser ou supprimer une relation
usersRouter.delete('/friends/:friendshipId', requireAuth, async (req, res, next) => {
  try {
    const friendship = await prisma.friendship.findUnique({ where: { id: req.params.friendshipId } });
    if (!friendship) throw new HttpError(404, 'Relation introuvable');
    if (friendship.senderId !== req.user!.sub && friendship.receiverId !== req.user!.sub) {
      throw new HttpError(403, 'Pas autorisé');
    }
    await prisma.friendship.delete({ where: { id: friendship.id } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Récupérer mes amis + demandes reçues + demandes envoyées
usersRouter.get('/friends', requireAuth, async (req, res, next) => {
  try {
    const meId = req.user!.sub;
    const friendships = await prisma.friendship.findMany({
      where: {
        OR: [{ senderId: meId }, { receiverId: meId }],
      },
      include: {
        sender: { select: { id: true, pseudo: true, avatarUrl: true } },
        receiver: { select: { id: true, pseudo: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(friendships);
  } catch (err) {
    next(err);
  }
});

// Récupérer le statut d'amitié avec un utilisateur spécifique
usersRouter.get('/friends/status/:userId', requireAuth, async (req, res, next) => {
  try {
    const meId = req.user!.sub;
    const targetId = req.params.userId;
    const friendship = await prisma.friendship.findFirst({
      where: {
        OR: [
          { senderId: meId, receiverId: targetId },
          { senderId: targetId, receiverId: meId },
        ],
      },
    });
    res.json(friendship ?? null);
  } catch (err) {
    next(err);
  }
});
