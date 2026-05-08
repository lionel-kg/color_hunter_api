import type { Server as SocketServer, Socket } from 'socket.io';
import { verifyAccessToken } from '../lib/jwt.js';
import { prisma } from '../lib/prisma.js';
import { notifyUser } from '../routes/notifications.js';

let _io: SocketServer;

export function getIO(): SocketServer {
  return _io;
}

export function registerGameSockets(io: SocketServer) {
  _io = io;
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('No token'));
    try {
      socket.data.user = verifyAccessToken(token);
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const user = socket.data.user as { sub: string; pseudo: string };

    // Chaque utilisateur rejoint automatiquement sa room personnelle pour les notifs
    socket.join(`user:${user.sub}`);

    socket.on('game:join', ({ gameId }: { gameId: string }) => {
      socket.join(`game:${gameId}`);
      socket.to(`game:${gameId}`).emit('game:presence', { userId: user.sub, pseudo: user.pseudo, status: 'joined' });
    });

    socket.on('game:leave', ({ gameId }: { gameId: string }) => {
      socket.leave(`game:${gameId}`);
      socket.to(`game:${gameId}`).emit('game:presence', { userId: user.sub, pseudo: user.pseudo, status: 'left' });
    });

    socket.on('game:photo', ({ gameId, photoId }: { gameId: string; photoId: string }) => {
      io.to(`game:${gameId}`).emit('game:photo', { userId: user.sub, photoId });
    });

    socket.on('game:chat', ({ gameId, message }: { gameId: string; message: string }) => {
      const trimmed = message?.slice(0, 500) ?? '';
      if (!trimmed) return;
      io.to(`game:${gameId}`).emit('game:chat', {
        userId: user.sub,
        pseudo: user.pseudo,
        message: trimmed,
        at: Date.now(),
      });
    });

    // Message direct entre amis
    socket.on('dm:send', async ({ receiverId, text }: { receiverId: string; text: string }) => {
      const trimmed = text?.trim().slice(0, 1000);
      if (!trimmed) return;
      try {
        const friendship = await prisma.friendship.findFirst({
          where: {
            status: 'ACCEPTED',
            OR: [
              { senderId: user.sub, receiverId },
              { senderId: receiverId, receiverId: user.sub },
            ],
          },
        });
        if (!friendship) return;

        const message = await prisma.directMessage.create({
          data: { senderId: user.sub, receiverId, text: trimmed },
          include: { sender: { select: { id: true, pseudo: true } } },
        });

        // Envoyer au destinataire et confirmer à l'expéditeur
        io.to(`user:${receiverId}`).emit('dm:message', message);
        socket.emit('dm:message', message);

        // Push notification si l'app est fermée
        notifyUser({
          userId: receiverId,
          type: 'DM',
          actorId: user.sub,
          actorPseudo: user.pseudo,
          entityId: user.sub,
        });
      } catch { /* ignore */ }
    });

    socket.on('disconnect', () => {
      // rooms get cleaned automatically
    });
  });
}
