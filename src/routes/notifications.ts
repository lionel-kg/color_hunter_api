import { Router } from 'express';
import type { NotificationType } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { getIO } from '../sockets/games.js';
import { sendPushToUser } from './push.js';

export const notificationsRouter = Router();

const PUSH_TITLES: Record<NotificationType, string> = {
  FRIEND_REQUEST:     '👋 Nouvelle demande d\'ami',
  FRIEND_ACCEPTED:    '✅ Demande acceptée',
  GRID_LIKE:          '♥ Quelqu\'un a aimé ta grille',
  GRID_COMMENT:       '💬 Nouveau commentaire',
  GRID_COMMENT_REPLY: '↩️ Réponse à ton commentaire',
  GAME_STARTED:       '🎨 La partie a démarré',
  DM:                 '✉️ Nouveau message',
};

// Utilitaire interne : créer une notif + la pousser via socket + push
export async function notifyUser(params: {
  userId: string;
  type: NotificationType;
  actorId?: string;
  entityId?: string;
  actorPseudo?: string;
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

    // Socket in-app (app ouverte)
    getIO().to(`user:${params.userId}`).emit('notification:new', notif);

    // Push web (app fermée)
    const actor = params.actorPseudo ?? notif.actor?.pseudo ?? 'Color Hunt';
    const url = params.type === 'DM' && params.entityId
      ? `/chat/${params.entityId}`
      : '/';
    await sendPushToUser(params.userId, {
      title: PUSH_TITLES[params.type],
      body: actor,
      icon: '/icons/icon-192.png',
      url,
    });

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

// DELETE /api/notifications/:id — supprimer une notif
notificationsRouter.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    await prisma.notification.deleteMany({
      where: { id: req.params.id, userId: req.user!.sub },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
