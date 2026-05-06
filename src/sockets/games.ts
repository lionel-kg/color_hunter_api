import type { Server as SocketServer, Socket } from 'socket.io';
import { verifyAccessToken } from '../lib/jwt.js';

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

    socket.on('disconnect', () => {
      // rooms get cleaned automatically
    });
  });
}
