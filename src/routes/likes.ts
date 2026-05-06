import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { notifyUser } from './notifications.js';

export const likesRouter = Router();

// POST /api/likes/:gridId — toggle like (like si absent, unlike si présent)
likesRouter.post('/:gridId', requireAuth, async (req, res, next) => {
  try {
    const { gridId } = req.params;
    const userId = req.user!.sub;

    const grid = await prisma.grid.findUnique({
      where: { id: gridId },
      select: { id: true, userId: true, visibility: true },
    });
    if (!grid) throw new HttpError(404, 'Grille introuvable');
    if (grid.visibility === 'PRIVATE' && grid.userId !== userId) {
      throw new HttpError(403, 'Grille privée');
    }

    const existing = await prisma.gridLike.findUnique({
      where: { gridId_userId: { gridId, userId } },
    });

    if (existing) {
      await prisma.gridLike.delete({ where: { id: existing.id } });
      const count = await prisma.gridLike.count({ where: { gridId } });
      return res.json({ liked: false, count });
    }

    await prisma.gridLike.create({ data: { gridId, userId } });
    const count = await prisma.gridLike.count({ where: { gridId } });

    // Notifier le propriétaire de la grille (sauf si c'est lui-même)
    if (grid.userId !== userId) {
      await notifyUser({
        userId: grid.userId,
        type: 'GRID_LIKE',
        actorId: userId,
        entityId: gridId,
      });
    }

    return res.json({ liked: true, count });
  } catch (err) {
    next(err);
  }
});

// GET /api/likes/:gridId — nombre de likes + si l'utilisateur a liké
likesRouter.get('/:gridId', requireAuth, async (req, res, next) => {
  try {
    const { gridId } = req.params;
    const userId = req.user!.sub;

    const [count, userLike] = await Promise.all([
      prisma.gridLike.count({ where: { gridId } }),
      prisma.gridLike.findUnique({ where: { gridId_userId: { gridId, userId } } }),
    ]);

    res.json({ count, liked: !!userLike });
  } catch (err) {
    next(err);
  }
});

// ─── COMMENTAIRES ────────────────────────────────────────────────────

export const commentsRouter = Router();

// GET /api/comments/:gridId — liste des commentaires d'une grille
commentsRouter.get('/:gridId', requireAuth, async (req, res, next) => {
  try {
    const comments = await prisma.gridComment.findMany({
      where: { gridId: req.params.gridId },
      include: { user: { select: { id: true, pseudo: true, avatarUrl: true } } },
      orderBy: { createdAt: 'asc' },
    });
    res.json(comments);
  } catch (err) {
    next(err);
  }
});

// POST /api/comments/:gridId — ajouter un commentaire
commentsRouter.post('/:gridId', requireAuth, async (req, res, next) => {
  try {
    const { text } = z.object({ text: z.string().min(1).max(500) }).parse(req.body);
    const { gridId } = req.params;
    const userId = req.user!.sub;

    const grid = await prisma.grid.findUnique({
      where: { id: gridId },
      select: { id: true, userId: true, visibility: true },
    });
    if (!grid) throw new HttpError(404, 'Grille introuvable');
    if (grid.visibility === 'PRIVATE' && grid.userId !== userId) {
      throw new HttpError(403, 'Grille privée');
    }

    const comment = await prisma.gridComment.create({
      data: { gridId, userId, text },
      include: { user: { select: { id: true, pseudo: true, avatarUrl: true } } },
    });

    if (grid.userId !== userId) {
      await notifyUser({
        userId: grid.userId,
        type: 'GRID_COMMENT',
        actorId: userId,
        entityId: gridId,
      });
    }

    res.status(201).json(comment);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/comments/:commentId — supprimer son commentaire
commentsRouter.delete('/:commentId', requireAuth, async (req, res, next) => {
  try {
    const comment = await prisma.gridComment.findUnique({ where: { id: req.params.commentId } });
    if (!comment) throw new HttpError(404, 'Commentaire introuvable');
    if (comment.userId !== req.user!.sub) throw new HttpError(403, 'Pas autorisé');
    await prisma.gridComment.delete({ where: { id: comment.id } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
