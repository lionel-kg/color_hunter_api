import { Router } from 'express';
import webpush from 'web-push';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';

export const pushRouter = Router();

webpush.setVapidDetails(
  `mailto:${process.env.VAPID_EMAIL ?? 'admin@colorhunt.app'}`,
  process.env.VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!,
);

const SubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string(),
    auth: z.string(),
  }),
});

// GET /api/push/vapid-public — renvoie la clé publique VAPID au client
pushRouter.get('/vapid-public', (_req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// POST /api/push/subscribe — enregistrer une subscription
pushRouter.post('/subscribe', requireAuth, async (req, res, next) => {
  try {
    const { endpoint, keys } = SubscriptionSchema.parse(req.body);
    await prisma.pushSubscription.upsert({
      where: { userId_endpoint: { userId: req.user!.sub, endpoint } },
      create: { userId: req.user!.sub, endpoint, p256dh: keys.p256dh, auth: keys.auth },
      update: { p256dh: keys.p256dh, auth: keys.auth },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/push/unsubscribe — supprimer une subscription
pushRouter.delete('/unsubscribe', requireAuth, async (req, res, next) => {
  try {
    const { endpoint } = z.object({ endpoint: z.string() }).parse(req.body);
    await prisma.pushSubscription.deleteMany({
      where: { userId: req.user!.sub, endpoint },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Utilitaire exporté : envoyer une notif push à un utilisateur
export async function sendPushToUser(userId: string, payload: {
  title: string;
  body: string;
  icon?: string;
  url?: string;
}) {
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  const json = JSON.stringify(payload);

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          json,
        );
      } catch (err: any) {
        // 404 ou 410 = subscription expirée → supprimer
        if (err.statusCode === 404 || err.statusCode === 410) {
          await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
        }
      }
    }),
  );
}
