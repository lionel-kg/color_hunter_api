import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import exifr from "exifr";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import { uploadFile, deleteFile } from "../lib/storage.js";

export const photosRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

function photoQuota(mode: string, teamSize: number): number {
  if (mode === "SOLO") return 9;
  if (teamSize === 3) return 3; // 3 joueurs × 3 = 9 (pile la grille)
  return 5; // 2 joueurs × 5 = 10 photos dans le pool, 9 utilisées (chacun en écarte une)
}

// Upload de plusieurs photos dans une partie
photosRouter.post(
  "/:gameId",
  requireAuth,
  upload.array("photos", 9),
  async (req, res, next) => {
    try {
      const files = req.files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0)
        throw new HttpError(400, "Aucun fichier reçu");

      const game = await prisma.game.findUnique({
        where: { id: req.params.gameId },
      });
      if (!game) throw new HttpError(404, "Partie introuvable");
      if (game.status !== "RUNNING")
        throw new HttpError(400, "La chasse n'est pas active");

      const participant = await prisma.gameParticipant.findUnique({
        where: { gameId_userId: { gameId: game.id, userId: req.user!.sub } },
      });
      if (!participant)
        throw new HttpError(403, "Tu ne participes pas à cette partie");

      const quota = photoQuota(game.mode, game.teamSize);
      const existing = await prisma.photo.count({
        where: { gameId: game.id, userId: req.user!.sub },
      });
      const slots = quota - existing;
      if (slots <= 0)
        throw new HttpError(400, `Quota atteint (${quota} photos max)`);
      if (files.length > slots)
        throw new HttpError(
          400,
          `Tu peux encore ajouter ${slots} photo${slots > 1 ? "s" : ""}`,
        );

      const created = await Promise.all(
        files.map(async (file) => {
          // EXIF — vérifier que la photo est dans la fenêtre du défi
          let takenAt: Date | undefined;
          try {
            const exif = await exifr.parse(file.buffer, [
              "DateTimeOriginal",
              "CreateDate",
            ]);
            const ts = exif?.DateTimeOriginal ?? exif?.CreateDate;
            if (ts) takenAt = new Date(ts);
          } catch {
            // EXIF illisible — on accepte mais on ne stocke pas de date
          }
          // if (takenAt && game.startedAt && takenAt < game.startedAt) {
          //   throw new HttpError(400, 'Une photo a été prise avant le début du défi');
          // }

          const { url, key } = await uploadFile(
            file.buffer,
            `color-hunt/${game.id}`,
          );
          return prisma.photo.create({
            data: {
              userId: req.user!.sub,
              gameId: game.id,
              cloudinaryUrl: url,
              cloudinaryPublicId: key,
              takenAt,
            },
          });
        }),
      );

      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  },
);

// Liste des photos disponibles pour construire sa grille :
// - mode solo : ses propres photos uniquement
// - mode équipe : ses photos + celles de ses coéquipiers (pool d'équipe partagé)
photosRouter.get("/:gameId", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.sub;
    const gameId = req.params.gameId;

    const me = await prisma.gameParticipant.findUnique({
      where: { gameId_userId: { gameId, userId } },
      select: { teamId: true },
    });

    let userIdFilter: { in: string[] } | string = userId;
    if (me?.teamId) {
      const teammates = await prisma.gameParticipant.findMany({
        where: { gameId, teamId: me.teamId },
        select: { userId: true },
      });
      userIdFilter = { in: teammates.map((t) => t.userId) };
    }

    const photos = await prisma.photo.findMany({
      where: { gameId, userId: userIdFilter },
      orderBy: { createdAt: "desc" },
    });
    res.json(photos);
  } catch (err) {
    next(err);
  }
});

// Sélection finale (9 photos pour la grille)
photosRouter.post("/:gameId/grid", requireAuth, async (req, res, next) => {
  try {
    const { photoIds } = z
      .object({
        photoIds: z.array(z.string()).length(9),
      })
      .parse(req.body);

    const photos = await prisma.photo.findMany({
      where: {
        id: { in: photoIds },
        userId: req.user!.sub,
        gameId: req.params.gameId,
      },
    });
    if (photos.length !== 9)
      throw new HttpError(400, "Sélection invalide (9 photos requises)");

    await prisma.$transaction([
      prisma.photo.updateMany({
        where: { gameId: req.params.gameId, userId: req.user!.sub },
        data: { isSelectedForGrid: false, gridPosition: null },
      }),
      ...photoIds.map((id, idx) =>
        prisma.photo.update({
          where: { id },
          data: { isSelectedForGrid: true, gridPosition: idx },
        }),
      ),
    ]);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Supprimer une photo
photosRouter.delete("/:photoId", requireAuth, async (req, res, next) => {
  try {
    const photo = await prisma.photo.findUnique({
      where: { id: req.params.photoId },
    });
    if (!photo) throw new HttpError(404, "Photo introuvable");
    if (photo.userId !== req.user!.sub)
      throw new HttpError(403, "Pas autorisé");
    await deleteFile(photo.cloudinaryPublicId);
    await prisma.photo.delete({ where: { id: photo.id } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
