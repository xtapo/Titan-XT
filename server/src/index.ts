import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import { Registry } from './registry';
import { Signaling } from './signaling';

const PORT = parseInt(process.env.PORT || '3456', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// === Express App ===
const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// === HTTP Server ===
const server = http.createServer(app);

// === Socket.io ===
const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST'],
  },
  pingInterval: 10_000,
  pingTimeout: 5_000,
});

// === Initialize Registry & Signaling ===
const registry = new Registry();
const signaling = new Signaling(io, registry);
signaling.setup();

// === REST Endpoints ===

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: Date.now(),
  });
});

// Stats
app.get('/api/stats', (_req, res) => {
  res.json({
    registry: registry.getStats(),
    signaling: signaling.getStats(),
  });
});

// Check if machine is online
app.get('/api/online/:machineId', (req, res) => {
  const { machineId } = req.params;
  res.json({
    machineId,
    online: registry.isOnline(machineId),
  });
});

// === Start Server ===
server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║                                          ║');
  console.log('  ║   ◆ TITAN-XT Signal Server               ║');
  console.log('  ║   Remote Desktop Support                 ║');
  console.log('  ║                                          ║');
  console.log(`  ║   🌐 HTTP:   http://localhost:${PORT}       ║`);
  console.log(`  ║   🔌 WS:     ws://localhost:${PORT}         ║`);
  console.log('  ║                                          ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');
  io.close();
  server.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  io.close();
  server.close();
  process.exit(0);
});
