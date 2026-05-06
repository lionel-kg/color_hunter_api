import { Router } from 'express';
import type { NotificationType } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { getIO } from '../sockets/games.js';

export const notificationsRouter = Router();

// Utilitaire interne : créer une notif + la pousser via socket
export async function notifyUser(params: {
  userId: string;
  type: NotificationType;
  actorId?: string;
  entityId?: string;
}) {
  try {
    const notif = await prisma.notification.create({
      data: {
        userId: params.userId,
        type: params.type,
        actorId: params.actorId ?? null,
        entityId: params.entityId ?? null,
      },
      include: {
        actor: { select: { id: true, pseudo: true, avatarUrl: true } },
      },
    });
    getIO().to(`user:${params.userId}`).emit('notification:new', notif);
    return notif;
  } catch {
    // Ne jamais bloquer l'action principale si la notif échoue
  }
}

// GET /api/notifications — notifs de l'utilisateur (50 dernières)
notificationsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user!.sub },
      include: {
        actor: { select: { id: true, pseudo: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const unreadCount = await prisma.notification.count({
      where: { userId: req.user!.sub, readAt: null },
    });

    res.json({ notifications, unreadCount });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/notifications/read-all — marquer toutes comme lues
notificationsRouter.patch('/read-all', requireAuth, async (req, res, next) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user!.sub, readAt: null },
      data: { readAt: new Date() },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/notifications/:id/read — marquer une notif comme lue
notificationsRouter.patch('/:id/read', requireAuth, async (req, res, next) => {
  try {
    await prisma.notification.updateMany({
      where: { id: req.params.id, userId: req.user!.sub },
      data: { readAt: new Date() },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
