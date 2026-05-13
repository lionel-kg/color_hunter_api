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

const USER_SELECT = { id: true, pseudo: true, avatarUrl: true } as const;

type CommentRow = {
  id: string;
  gridId: string;
  userId: string;
  text: string;
  createdAt: Date;
  parentCommentId: string | null;
  user: { id: string; pseudo: string; avatarUrl: string | null };
  _count: { replies: number; likes: number };
};

function serializeComment(c: CommentRow, likedIds: Set<string>) {
  return {
    id: c.id,
    gridId: c.gridId,
    userId: c.userId,
    text: c.text,
    createdAt: c.createdAt,
    parentCommentId: c.parentCommentId,
    user: c.user,
    repliesCount: c._count.replies,
    likesCount: c._count.likes,
    liked: likedIds.has(c.id),
  };
}

// GET /api/comments/:gridId — liste des commentaires de premier niveau d'une grille
commentsRouter.get('/:gridId', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.sub;
    const comments = await prisma.gridComment.findMany({
      where: { gridId: req.params.gridId, parentCommentId: null },
      include: {
        user: { select: USER_SELECT },
        _count: { select: { replies: true, likes: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const ids = comments.map((c) => c.id);
    const myLikes = ids.length
      ? await prisma.gridCommentLike.findMany({
          where: { userId, commentId: { in: ids } },
          select: { commentId: true },
        })
      : [];
    const likedIds = new Set(myLikes.map((l) => l.commentId));

    res.json(comments.map((c) => serializeComment(c as CommentRow, likedIds)));
  } catch (err) {
    next(err);
  }
});

// GET /api/comments/:commentId/replies — liste paginée des réponses
commentsRouter.get('/:commentId/replies', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.sub;
    const { commentId } = req.params;
    const take = Math.min(Math.max(parseInt(String(req.query.take ?? '5'), 10) || 5, 1), 50);
    const skip = Math.max(parseInt(String(req.query.skip ?? '0'), 10) || 0, 0);

    const [replies, total] = await Promise.all([
      prisma.gridComment.findMany({
        where: { parentCommentId: commentId },
        include: {
          user: { select: USER_SELECT },
          _count: { select: { replies: true, likes: true } },
        },
        orderBy: { createdAt: 'asc' },
        skip,
        take,
      }),
      prisma.gridComment.count({ where: { parentCommentId: commentId } }),
    ]);

    const ids = replies.map((c) => c.id);
    const myLikes = ids.length
      ? await prisma.gridCommentLike.findMany({
          where: { userId, commentId: { in: ids } },
          select: { commentId: true },
        })
      : [];
    const likedIds = new Set(myLikes.map((l) => l.commentId));

    res.json({
      total,
      replies: replies.map((c) => serializeComment(c as CommentRow, likedIds)),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/comments/:gridId — ajouter un commentaire ou une réponse (parentCommentId optionnel)
commentsRouter.post('/:gridId', requireAuth, async (req, res, next) => {
  try {
    const { text, parentCommentId } = z
      .object({
        text: z.string().min(1).max(500),
        parentCommentId: z.string().optional().nullable(),
      })
      .parse(req.body);
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

    let parentAuthorId: string | null = null;
    let normalizedParentId: string | null = null;
    if (parentCommentId) {
      const parent = await prisma.gridComment.findUnique({
        where: { id: parentCommentId },
        select: { id: true, gridId: true, parentCommentId: true, userId: true },
      });
      if (!parent || parent.gridId !== gridId) {
        throw new HttpError(404, 'Commentaire parent introuvable');
      }
      // Profondeur max = 1 : si le parent est déjà une réponse, on rattache au commentaire racine
      normalizedParentId = parent.parentCommentId ?? parent.id;
      parentAuthorId = parent.userId;
    }

    const comment = await prisma.gridComment.create({
      data: { gridId, userId, text, parentCommentId: normalizedParentId },
      include: {
        user: { select: USER_SELECT },
        _count: { select: { replies: true, likes: true } },
      },
    });

    if (normalizedParentId) {
      if (parentAuthorId && parentAuthorId !== userId) {
        await notifyUser({
          userId: parentAuthorId,
          type: 'GRID_COMMENT',
          actorId: userId,
          entityId: gridId,
        });
      }
    } else if (grid.userId !== userId) {
      await notifyUser({
        userId: grid.userId,
        type: 'GRID_COMMENT',
        actorId: userId,
        entityId: gridId,
      });
    }

    res.status(201).json(serializeComment(comment as CommentRow, new Set()));
  } catch (err) {
    next(err);
  }
});

// POST /api/comments/:commentId/like — toggle like sur un commentaire
commentsRouter.post('/:commentId/like', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.sub;
    const { commentId } = req.params;

    const comment = await prisma.gridComment.findUnique({
      where: { id: commentId },
      select: { id: true },
    });
    if (!comment) throw new HttpError(404, 'Commentaire introuvable');

    const existing = await prisma.gridCommentLike.findUnique({
      where: { commentId_userId: { commentId, userId } },
    });

    if (existing) {
      await prisma.gridCommentLike.delete({ where: { id: existing.id } });
    } else {
      await prisma.gridCommentLike.create({ data: { commentId, userId } });
    }

    const count = await prisma.gridCommentLike.count({ where: { commentId } });
    res.json({ liked: !existing, count });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/comments/:commentId — supprimer son commentaire (et ses réponses via cascade)
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
