import os from 'node:os';
import path from 'node:path';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

const app = await createApp({
  port,
  host,
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : undefined,
  ttlDays: Number(process.env.ROOM_TTL_DAYS ?? 30),
  trustProxy: process.env.TRUST_PROXY === '1',
  maxConnsPerRoom: process.env.MAX_CONNS_PER_ROOM ? Number(process.env.MAX_CONNS_PER_ROOM) : undefined,
});

console.log(`UN Code Sala lista en:\n  Local:  http://localhost:${app.port}`);
for (const addrs of Object.values(os.networkInterfaces())) {
  for (const a of addrs ?? []) {
    if (a.family === 'IPv4' && !a.internal) console.log(`  Red:    http://${a.address}:${app.port}`);
  }
}

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
