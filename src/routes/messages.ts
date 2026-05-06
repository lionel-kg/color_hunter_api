import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { getIO } from '../sockets/games.js';

export const messagesRouter = Router();

// Vérifie que les deux utilisateurs sont amis
async function assertFriends(meId: string, otherId: string) {
  const friendship = await prisma.friendship.findFirst({
    where: {
      status: 'ACCEPTED',
      OR: [
        { senderId: meId, receiverId: otherId },
        { senderId: otherId, receiverId: meId },
      ],
    },
  });
  if (!friendship) throw new HttpError(403, 'Vous n\'êtes pas amis');
}

// GET /api/messages/:friendId — historique de la conversation
messagesRouter.get('/:friendId', requireAuth, async (req, res, next) => {
  try {
    const meId = req.user!.sub;
    const friendId = req.params.friendId;
    await assertFriends(meId, friendId);

    const messages = await prisma.directMessage.findMany({
      where: {
        OR: [
          { senderId: meId, receiverId: friendId },
          { senderId: friendId, receiverId: meId },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });

    // Marquer les messages reçus comme lus
    await prisma.directMessage.updateMany({
      where: { senderId: friendId, receiverId: meId, readAt: null },
      data: { readAt: new Date() },
    });

    res.json(messages);
  } catch (err) {
    next(err);
  }
});

// POST /api/messages/:friendId — envoyer un message (fallback REST)
messagesRouter.post('/:friendId', requireAuth, async (req, res, next) => {
  try {
    const meId = req.user!.sub;
    const friendId = req.params.friendId;
    const { text } = z.object({ text: z.string().min(1).max(1000) }).parse(req.body);

    await assertFriends(meId, friendId);

    const message = await prisma.directMessage.create({
      data: { senderId: meId, receiverId: friendId, text },
      include: { sender: { select: { id: true, pseudo: true } } },
    });

    getIO().to(`user:${friendId}`).emit('dm:message', message);

    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});

// GET /api/messages — nombre de messages non lus par ami
messagesRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const meId = req.user!.sub;
    const unread = await prisma.directMessage.groupBy({
      by: ['senderId'],
      where: { receiverId: meId, readAt: null },
      _count: { id: true },
    });
    const result: Record<string, number> = {};
    for (const u of unread) result[u.senderId] = u._count.id;
    res.json(result);
  } catch (err) {
    next(err);
  }
});
