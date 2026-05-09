import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { generateInviteCode, pickDistinctColors } from '../lib/colors.js';
import { getIO } from '../sockets/games.js';

export const gamesRouter = Router();

const createSchema = z.object({
  mode: z.enum(['SOLO', 'TEAM']).default('SOLO'),
  teamSize: z.number().int().min(1).max(5).default(2),
  numTeams: z.number().int().min(2).max(8).default(2),
  maxPlayers: z.number().int().min(2).max(20).default(6),
  durationMin: z.number().int().min(60).max(60 * 24 * 7).default(60 * 24),
  visibility: z.enum(['PUBLIC', 'PRIVATE']).default('PRIVATE'),
});

async function uniqueInviteCode(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = generateInviteCode();
    const exists = await prisma.game.findUnique({ where: { inviteCode: code } });
    if (!exists) return code;
  }
  throw new HttpError(500, 'Impossible de générer un code unique');
}

// Créer une partie
gamesRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const data = createSchema.parse(req.body);
    const inviteCode = await uniqueInviteCode();
    const game = await prisma.game.create({
      data: {
        ...data,
        inviteCode,
        creatorId: req.user!.sub,
        participants: { create: { userId: req.user!.sub } },
      },
      include: { participants: { include: { user: { select: { id: true, pseudo: true } } } }, teams: true },
    });
    res.status(201).json(game);
  } catch (err) {
    next(err);
  }
});

// Modifier les paramètres du lobby (hôte uniquement, statut LOBBY)
gamesRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const game = await prisma.game.findUnique({
      where: { id: req.params.id },
      include: { teams: { orderBy: { id: 'asc' } } },
    });
    if (!game) throw new HttpError(404, 'Partie introuvable');
    if (game.creatorId !== req.user!.sub) throw new HttpError(403, 'Seul le créateur peut modifier les paramètres');
    if (game.status !== 'LOBBY') throw new HttpError(400, 'Impossible de modifier une partie déjà démarrée');

    const updateSchema = z.object({
      teamSize: z.number().int().min(2).max(5).optional(),
      numTeams: z.number().int().min(2).max(8).optional(),
      maxPlayers: z.number().int().min(2).max(40).optional(),
      durationMin: z.number().int().min(60).max(60 * 24 * 7).optional(),
      visibility: z.enum(['PUBLIC', 'PRIVATE']).optional(),
      colorPalettes: z.array(z.enum(['PRIMARY', 'SECONDARY', 'TERTIARY'])).min(1).optional(),
    });
    const data = updateSchema.parse(req.body);

    // Si on réduit numTeams et que des Team existent déjà, supprimer les Team excédentaires
    // (les participants assignés sont automatiquement désassignés via onDelete: SetNull)
    if (data.numTeams !== undefined && game.teams.length > data.numTeams) {
      const toDelete = game.teams.slice(data.numTeams).map(t => t.id);
      await prisma.team.deleteMany({ where: { id: { in: toDelete } } });
    }

    await prisma.game.update({ where: { id: game.id }, data });

    const fresh = await prisma.game.findUnique({
      where: { id: game.id },
      include: {
        participants: { include: { user: { select: { id: true, pseudo: true } }, team: true } },
        teams: { orderBy: { id: 'asc' } },
      },
    });

    getIO().to(`game:${game.id}`).emit('game:joined', fresh);
    res.json(fresh);
  } catch (err) {
    next(err);
  }
});

// Liste des parties de l'utilisateur
gamesRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const games = await prisma.game.findMany({
      where: { participants: { some: { userId: req.user!.sub } }, status: { not: 'CANCELLED' } },
      include: {
        participants: { include: { user: { select: { id: true, pseudo: true, avatarUrl: true } } } },
        teams: true,
        _count: { select: { photos: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    res.json(games);
  } catch (err) {
    next(err);
  }
});

// Détail d'une partie
gamesRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const game = await prisma.game.findUnique({
      where: { id: req.params.id },
      include: {
        participants: { include: { user: { select: { id: true, pseudo: true, avatarUrl: true } }, team: true } },
        teams: true,
      },
    });
    if (!game) throw new HttpError(404, 'Partie introuvable');
    const me = game.participants.find(p => p.userId === req.user!.sub);
    if (!me && game.visibility === 'PRIVATE') throw new HttpError(403, 'Partie privée');
    res.json(game);
  } catch (err) {
    next(err);
  }
});

// Rejoindre via code d'invitation
gamesRouter.post('/join', requireAuth, async (req, res, next) => {
  try {
    const { inviteCode } = z.object({ inviteCode: z.string().min(4).max(8) }).parse(req.body);
    const game = await prisma.game.findUnique({
      where: { inviteCode: inviteCode.toUpperCase() },
      include: { _count: { select: { participants: true } } },
    });
    if (!game) throw new HttpError(404, 'Code invalide');
    if (game.status !== 'LOBBY') throw new HttpError(400, 'La chasse a déjà commencé');
    if (game._count.participants >= game.maxPlayers) throw new HttpError(400, 'Salon plein');

    await prisma.gameParticipant.upsert({
      where: { gameId_userId: { gameId: game.id, userId: req.user!.sub } },
      create: { gameId: game.id, userId: req.user!.sub },
      update: {},
    });

    const fresh = await prisma.game.findUnique({
      where: { id: game.id },
      include: { participants: { include: { user: { select: { id: true, pseudo: true } } } }, teams: true },
    });

    getIO().to(`game:${game.id}`).emit('game:joined', fresh);
    res.json(fresh);
  } catch (err) {
    next(err);
  }
});

// Assigner les équipes manuellement ou aléatoirement (hôte uniquement, pendant le lobby)
gamesRouter.post('/:id/teams', requireAuth, async (req, res, next) => {
  try {
    const game = await prisma.game.findUnique({
      where: { id: req.params.id },
      include: { participants: true, teams: true },
    });
    if (!game) throw new HttpError(404, 'Partie introuvable');
    if (game.creatorId !== req.user!.sub) throw new HttpError(403, 'Seul le créateur peut gérer les équipes');
    if (game.status !== 'LOBBY') throw new HttpError(400, 'La partie a déjà commencé');
    if (game.mode !== 'TEAM') throw new HttpError(400, 'Mode solo — pas d\'équipes');

    const { random, assignments } = z.object({
      random: z.boolean().optional(),
      // assignments: [{ userId, teamIndex }] pour l'assignation manuelle
      assignments: z.array(z.object({ userId: z.string(), teamIndex: z.number().int().min(0) })).optional(),
    }).parse(req.body);

    // Supprimer les équipes existantes et recréer
    await prisma.team.deleteMany({ where: { gameId: game.id } });
    const colors = pickDistinctColors(game.numTeams);
    const teams = await prisma.$transaction(
      colors.map((c) =>
        prisma.team.create({
          data: { gameId: game.id, name: `Équipe ${c.name}`, assignedColorHex: c.hex, assignedColorName: c.name },
        }),
      ),
    );

    if (random) {
      const shuffled = [...game.participants].sort(() => Math.random() - 0.5);
      await prisma.$transaction(
        shuffled.map((p, i) =>
          prisma.gameParticipant.update({
            where: { id: p.id },
            data: { teamId: teams[i % teams.length].id },
          }),
        ),
      );
    } else if (assignments?.length) {
      await prisma.$transaction(
        assignments.map(({ userId, teamIndex }) => {
          const participant = game.participants.find(p => p.userId === userId);
          if (!participant) return prisma.$queryRaw`SELECT 1`;
          const team = teams[teamIndex];
          if (!team) return prisma.$queryRaw`SELECT 1`;
          return prisma.gameParticipant.update({
            where: { id: participant.id },
            data: { teamId: team.id },
          });
        }),
      );
    }

    const fresh = await prisma.game.findUnique({
      where: { id: game.id },
      include: {
        participants: { include: { user: { select: { id: true, pseudo: true } }, team: true } },
        teams: true,
      },
    });

    getIO().to(`game:${game.id}`).emit('game:joined', fresh);
    res.json(fresh);
  } catch (err) {
    next(err);
  }
});

// Démarrer la chasse — tirage des couleurs
gamesRouter.post('/:id/start', requireAuth, async (req, res, next) => {
  try {
    const game = await prisma.game.findUnique({
      where: { id: req.params.id },
      include: { participants: true, teams: true },
    });
    if (!game) throw new HttpError(404, 'Partie introuvable');
    if (game.creatorId !== req.user!.sub) throw new HttpError(403, 'Seul le créateur peut démarrer');
    if (game.status !== 'LOBBY') throw new HttpError(400, 'Déjà démarrée');

    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + game.durationMin * 60_000);

    if (game.mode === 'SOLO') {
      const colors = pickDistinctColors(game.participants.length);
      await prisma.$transaction([
        ...game.participants.map((p, i) =>
          prisma.gameParticipant.update({
            where: { id: p.id },
            data: { colorHex: colors[i].hex, colorName: colors[i].name },
          }),
        ),
        prisma.game.update({
          where: { id: game.id },
          data: { status: 'RUNNING', startedAt, expiresAt },
        }),
      ]);
    } else {
      // Si les équipes ont déjà été formées manuellement, on les conserve
      if (game.teams.length === 0) {
        const colors = pickDistinctColors(game.numTeams);
        const shuffled = [...game.participants].sort(() => Math.random() - 0.5);
        const teams = await prisma.$transaction(
          colors.map((c) =>
            prisma.team.create({
              data: { gameId: game.id, name: `Équipe ${c.name}`, assignedColorHex: c.hex, assignedColorName: c.name },
            }),
          ),
        );
        await prisma.$transaction(
          shuffled.map((p, i) =>
            prisma.gameParticipant.update({
              where: { id: p.id },
              data: { teamId: teams[i % teams.length].id },
            }),
          ),
        );
      }
      await prisma.game.update({
        where: { id: game.id },
        data: { status: 'RUNNING', startedAt, expiresAt },
      });
    }

    const fresh = await prisma.game.findUnique({
      where: { id: game.id },
      include: {
        participants: { include: { user: { select: { id: true, pseudo: true } }, team: true } },
        teams: true,
      },
    });

    getIO().to(`game:${game.id}`).emit('game:started', fresh);
    res.json(fresh);
  } catch (err) {
    next(err);
  }
});

// Dissoudre le lobby (hôte uniquement, statut LOBBY)
gamesRouter.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const game = await prisma.game.findUnique({ where: { id: req.params.id } });
    if (!game) throw new HttpError(404, 'Partie introuvable');
    if (game.creatorId !== req.user!.sub) throw new HttpError(403, 'Seul le créateur peut dissoudre le lobby');
    if (game.status !== 'LOBBY') throw new HttpError(400, 'Impossible de dissoudre une partie déjà démarrée');

    await prisma.game.update({ where: { id: game.id }, data: { status: 'CANCELLED' } });
    getIO().to(`game:${game.id}`).emit('game:dissolved', { gameId: game.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Quitter le lobby (participant non-hôte)
gamesRouter.delete('/:id/leave', requireAuth, async (req, res, next) => {
  try {
    const game = await prisma.game.findUnique({ where: { id: req.params.id } });
    if (!game) throw new HttpError(404, 'Partie introuvable');
    if (game.status !== 'LOBBY') throw new HttpError(400, 'Impossible de quitter une partie déjà démarrée');
    if (game.creatorId === req.user!.sub) throw new HttpError(400, 'L\'hôte ne peut pas quitter — dissolvez le lobby');

    await prisma.gameParticipant.deleteMany({
      where: { gameId: game.id, userId: req.user!.sub },
    });

    const fresh = await prisma.game.findUnique({
      where: { id: game.id },
      include: {
        participants: { include: { user: { select: { id: true, pseudo: true } }, team: true } },
        teams: true,
      },
    });
    getIO().to(`game:${game.id}`).emit('game:joined', fresh);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Terminer la partie manuellement (créateur uniquement)
gamesRouter.post('/:id/end', requireAuth, async (req, res, next) => {
  try {
    const game = await prisma.game.findUnique({ where: { id: req.params.id } });
    if (!game) throw new HttpError(404, 'Partie introuvable');
    if (game.creatorId !== req.user!.sub) throw new HttpError(403, 'Seul le créateur peut terminer la partie');
    if (game.status !== 'RUNNING') throw new HttpError(400, 'La partie n\'est pas en cours');

    await prisma.game.update({ where: { id: game.id }, data: { status: 'FINISHED' } });
    getIO().to(`game:${game.id}`).emit('game:finished', { gameId: game.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
