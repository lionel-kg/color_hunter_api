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
  teamSize: z.number().int().min(1).max(3).default(1),
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

// Liste des parties de l'utilisateur
gamesRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const games = await prisma.game.findMany({
      where: { participants: { some: { userId: req.user!.sub } } },
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
      include: { participants: true },
    });
    if (!game) throw new HttpError(404, 'Partie introuvable');
    if (game.creatorId !== req.user!.sub) throw new HttpError(403, 'Seul le créateur peut démarrer');
    if (game.status !== 'LOBBY') throw new HttpError(400, 'Déjà démarrée');

    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + game.durationMin * 60_000);

    if (game.mode === 'SOLO') {
      // Une couleur unique par participant
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
      // Mode équipe : on crée des équipes basées sur teamSize, chacune avec une couleur
      const totalTeams = Math.max(1, Math.ceil(game.participants.length / game.teamSize));
      const colors = pickDistinctColors(totalTeams);
      const shuffled = [...game.participants].sort(() => Math.random() - 0.5);

      const teams = await prisma.$transaction(
        colors.map((c) =>
          prisma.team.create({
            data: { gameId: game.id, name: `Équipe ${c.name}`, assignedColorHex: c.hex, assignedColorName: c.name },
          }),
        ),
      );

      await prisma.$transaction([
        ...shuffled.map((p, i) =>
          prisma.gameParticipant.update({
            where: { id: p.id },
            data: { teamId: teams[i % teams.length].id },
          }),
        ),
        prisma.game.update({
          where: { id: game.id },
          data: { status: 'RUNNING', startedAt, expiresAt },
        }),
      ]);
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
