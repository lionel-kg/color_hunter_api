import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { createServer } from 'http';
import path from 'path';
import { Server as SocketServer } from 'socket.io';
import { authRouter } from './routes/auth.js';
import { gamesRouter } from './routes/games.js';
import { gridsRouter } from './routes/grids.js';
import { photosRouter } from './routes/photos.js';
import { usersRouter } from './routes/users.js';
import { errorHandler } from './middleware/error.js';
import { registerGameSockets } from './sockets/games.js';
import { prisma } from './lib/prisma.js';

const app = express();
const httpServer = createServer(app);

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';

app.use(morgan('dev'));
app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));
app.use(express.json({ limit: '2mb' }));

if ((process.env.STORAGE_MODE ?? 'local') === 'local') {
  app.use('/uploads', express.static(path.resolve(process.cwd(), 'uploads')));
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/games', gamesRouter);
app.use('/api/photos', photosRouter);
app.use('/api/grids', gridsRouter);

app.use(errorHandler);

const io = new SocketServer(httpServer, {
  cors: { origin: CLIENT_ORIGIN, credentials: true },
});
registerGameSockets(io);

// Expire les jeux dont le temps est écoulé et notifie les clients connectés
async function expireFinishedGames() {
  const expired = await prisma.game.findMany({
    where: { status: 'RUNNING', expiresAt: { lte: new Date() } },
    select: { id: true },
  });
  for (const game of expired) {
    await prisma.game.update({ where: { id: game.id }, data: { status: 'FINISHED' } });
    io.to(`game:${game.id}`).emit('game:finished', { gameId: game.id });
    console.log(`[expiry] game ${game.id} → FINISHED`);
  }
}

const PORT = Number(process.env.PORT ?? 4000);
httpServer.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  setInterval(expireFinishedGames, 15_000);
});
