import { Router } from "express";
import { z } from "zod";
import sharp from "sharp";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import { uploadFile, deleteFile } from "../lib/storage.js";
import { getIO } from "../sockets/games.js";

export const gridsRouter = Router();

const TILE_SIZE = 400; // px par cellule
const COLS = 3;

async function fetchImageBuffer(url: string): Promise<Buffer> {
  // URL locale (mode local storage) ou URL distante (Cloudinary)
  if (url.startsWith("http")) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Impossible de télécharger l'image: ${url}`);
    return Buffer.from(await res.arrayBuffer());
  }
  // URL relative /uploads/... → lire depuis le disque via fetch local
  const fullUrl = `http://localhost:${process.env.PORT ?? 4000}${url}`;
  const res = await fetch(fullUrl);
  if (!res.ok) throw new Error(`Impossible de télécharger l'image: ${fullUrl}`);
  return Buffer.from(await res.arrayBuffer());
}

async function buildCompositeImage(photoUrls: string[]): Promise<Buffer> {
  const tiles = await Promise.all(
    photoUrls.map((url) =>
      fetchImageBuffer(url).then((buf) =>
        sharp(buf).resize(TILE_SIZE, TILE_SIZE, { fit: "cover" }).toBuffer(),
      ),
    ),
  );

  const rows = COLS;
  const totalW = TILE_SIZE * COLS;
  const totalH = TILE_SIZE * rows;

  const composites = tiles.map((buf, i) => ({
    input: buf,
    left: (i % COLS) * TILE_SIZE,
    top: Math.floor(i / COLS) * TILE_SIZE,
  }));

  return sharp({
    create: {
      width: totalW,
      height: totalH,
      channels: 3,
      background: "#F5F0EB",
    },
  })
    .composite(composites)
    .jpeg({ quality: 88 })
    .toBuffer();
}

// POST /api/grids/:gameId — créer une grille
gridsRouter.post("/:gameId", requireAuth, async (req, res, next) => {
  try {
    const { photoIds, visibility } = z
      .object({
        photoIds: z.array(z.string()).length(9),
        visibility: z.enum(["PUBLIC", "PRIVATE"]).default("PRIVATE"),
      })
      .parse(req.body);

    const game = await prisma.game.findUnique({
      where: { id: req.params.gameId },
    });
    if (!game) throw new HttpError(404, "Partie introuvable");
    if (game.status !== "FINISHED")
      throw new HttpError(400, "La partie n'est pas encore terminée");

    const participant = await prisma.gameParticipant.findUnique({
      where: { gameId_userId: { gameId: game.id, userId: req.user!.sub } },
    });
    if (!participant)
      throw new HttpError(403, "Tu ne participes pas à cette partie");

    const existing = await prisma.grid.findUnique({
      where: { gameId_userId: { gameId: game.id, userId: req.user!.sub } },
    });
    if (existing)
      throw new HttpError(400, "Tu as déjà créé une grille pour cette partie");

    const photos = await prisma.photo.findMany({
      where: { id: { in: photoIds }, userId: req.user!.sub, gameId: game.id },
    });
    if (photos.length !== 9)
      throw new HttpError(
        400,
        "Sélection invalide — 9 photos requises et elles doivent t'appartenir",
      );

    // Ordre imposé par photoIds (position drag & drop)
    const photoMap = new Map(photos.map((p) => [p.id, p]));
    const orderedUrls = photoIds.map((id) => photoMap.get(id)!.cloudinaryUrl);

    const compositeBuffer = await buildCompositeImage(orderedUrls);
    const { url: imageUrl, key: imageKey } = await uploadFile(
      compositeBuffer,
      `color-hunt/grids/${game.id}`,
    );

    const grid = await prisma.grid.create({
      data: {
        gameId: game.id,
        userId: req.user!.sub,
        imageUrl,
        imageKey,
        visibility,
        photos: {
          create: photoIds.map((photoId, idx) => ({
            photoId,
            gridPosition: idx,
          })),
        },
      },
      include: {
        photos: { include: { photo: true }, orderBy: { gridPosition: "asc" } },
      },
    });

    getIO().to(`game:${game.id}`).emit("game:grid", { gameId: game.id });
    res.status(201).json(grid);
  } catch (err) {
    next(err);
  }
});

// GET /api/grids/game/:gameId — toutes les grilles d'une partie
gridsRouter.get("/game/:gameId", requireAuth, async (req, res, next) => {
  try {
    const grids = await prisma.grid.findMany({
      where: { gameId: req.params.gameId },
      include: {
        user: { select: { id: true, pseudo: true, avatarUrl: true, cameraModel: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    res.json(grids);
  } catch (err) {
    next(err);
  }
});

// GET /api/grids/feed?cursor=&friendsOnly=true — grilles publiques récentes (infinite scroll)
gridsRouter.get("/feed", requireAuth, async (req, res, next) => {
  try {
    const cursor = req.query.cursor as string | undefined;
    const friendsOnly = req.query.friendsOnly === "true";
    const limit = 1; // TODO: remettre à 10 en prod

    let userIdFilter: { in: string[] } | undefined;
    if (friendsOnly) {
      const friendships = await prisma.friendship.findMany({
        where: {
          status: "ACCEPTED",
          OR: [{ senderId: req.user!.sub }, { receiverId: req.user!.sub }],
        },
        select: { senderId: true, receiverId: true },
      });
      const friendIds = friendships.map((f) =>
        f.senderId === req.user!.sub ? f.receiverId : f.senderId,
      );
      userIdFilter = { in: friendIds };
    }

    const grids = await prisma.grid.findMany({
      where: {
        visibility: "PUBLIC",
        ...(userIdFilter ? { userId: userIdFilter } : {}),
        ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
      },
      include: {
        user: { select: { id: true, pseudo: true, avatarUrl: true, cameraModel: true } },
        game: { select: { inviteCode: true, mode: true } },
        _count: { select: { comments: true, likes: true } },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const nextCursor =
      grids.length === limit
        ? grids[grids.length - 1].createdAt.toISOString()
        : null;
    res.json({ grids, nextCursor });
  } catch (err) {
    next(err);
  }
});

// GET /api/grids/me — toutes les grilles de l'utilisateur connecté
gridsRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    const grids = await prisma.grid.findMany({
      where: { userId: req.user!.sub },
      include: {
        photos: { include: { photo: true }, orderBy: { gridPosition: "asc" } },
        game: { select: { inviteCode: true, mode: true } },
        _count: { select: { comments: true, likes: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(grids);
  } catch (err) {
    next(err);
  }
});

// GET /api/grids/user/:userId — grilles d'un utilisateur (PUBLIC toujours, PRIVATE si ami)
gridsRouter.get("/user/:userId", requireAuth, async (req, res, next) => {
  try {
    const meId = req.user!.sub;
    const targetId = req.params.userId;

    const visibilityFilter =
      meId === targetId
        ? undefined // propriétaire voit tout
        : { visibility: "PUBLIC" as const };

    const grids = await prisma.grid.findMany({
      where: { userId: targetId, ...visibilityFilter },
      include: {
        photos: { include: { photo: true }, orderBy: { gridPosition: "asc" } },
        game: { select: { inviteCode: true, mode: true } },
        _count: { select: { comments: true, likes: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(grids);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/grids/:gridId/visibility — changer la visibilité
gridsRouter.patch(
  "/:gridId/visibility",
  requireAuth,
  async (req, res, next) => {
    try {
      const { visibility } = z
        .object({
          visibility: z.enum(["PUBLIC", "PRIVATE"]),
        })
        .parse(req.body);

      const grid = await prisma.grid.findUnique({
        where: { id: req.params.gridId },
      });
      if (!grid) throw new HttpError(404, "Grille introuvable");
      if (grid.userId !== req.user!.sub)
        throw new HttpError(403, "Pas autorisé");

      const updated = await prisma.grid.update({
        where: { id: grid.id },
        data: { visibility },
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /api/grids/:gridId — supprimer une grille
gridsRouter.delete("/:gridId", requireAuth, async (req, res, next) => {
  try {
    const grid = await prisma.grid.findUnique({
      where: { id: req.params.gridId },
    });
    if (!grid) throw new HttpError(404, "Grille introuvable");
    if (grid.userId !== req.user!.sub) throw new HttpError(403, "Pas autorisé");
    await deleteFile(grid.imageKey);
    await prisma.grid.delete({ where: { id: grid.id } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
