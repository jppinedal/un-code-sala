import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager, ROOM_ID_RE } from './rooms.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DIST_DIR = path.join(ROOT, 'dist');

// Identificador de la publicación (lo escribe deploy/publicar.ps1); "dev" al ejecutar desde el código fuente.
const BUILD_ID = (() => {
  try {
    return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim() || 'dev';
  } catch {
    return 'dev';
  }
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // CodeMirror inyecta sus estilos en tiempo de ejecución
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const RATE_LIMIT = { max: 30, windowMs: 3600_000 }; // salas nuevas por IP y hora

export async function createApp({
  port = 3000,
  host = '0.0.0.0',
  dataDir = path.join(ROOT, 'data'),
  ttlDays = 30,
  trustProxy = false,
  maxConnsPerRoom,
} = {}) {
  const rooms = new RoomManager({ dataDir, ttlDays, maxConnsPerRoom });
  rooms.init();

  const hits = new Map(); // ip -> timestamps
  const clientIp = (req) =>
    (trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;
  const rateLimited = (ip) => {
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT.windowMs);
    recent.push(now);
    hits.set(ip, recent);
    return recent.length > RATE_LIMIT.max;
  };

  function reply(res, status, body, type = 'text/plain; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  }

  function serveFile(req, res, file, status = 200) {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return reply(res, 404, 'No encontrado');
      res.writeHead(status, {
        'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  function serveStatic(req, res, root, rel) {
    let decoded;
    try {
      decoded = decodeURIComponent(rel);
    } catch {
      return reply(res, 400, 'Solicitud inválida');
    }
    const file = path.join(root, path.normalize(decoded));
    if (!file.startsWith(root + path.sep)) return reply(res, 403, 'Prohibido');
    serveFile(req, res, file);
  }

  function readJson(req, limit = 2048) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const { pathname } = new URL(req.url, 'http://localhost');

      if (req.method === 'POST' && pathname === '/api/rooms') {
        if (rateLimited(clientIp(req))) return reply(res, 429, 'Demasiadas salas creadas, intenta más tarde');
        const body = await readJson(req).catch(() => null);
        if (body === null) return reply(res, 400, 'Solicitud inválida');
        return reply(res, 201, JSON.stringify(rooms.create(body.language, body.name)), MIME['.json']);
      }
      // Eliminar una sala: solo con el token de propietario (cabecera Authorization: Bearer ...)
      const del = req.method === 'DELETE' && pathname.match(/^\/api\/rooms\/([a-z0-9]+)$/);
      if (del) {
        const auth = req.headers.authorization ?? '';
        const result = rooms.remove(del[1], auth.startsWith('Bearer ') ? auth.slice(7).trim() : '');
        if (result === 'ok') return reply(res, 204, '');
        return result === 'forbidden' ? reply(res, 403, 'Sin permiso para eliminar esta sala') : reply(res, 404, 'Sala no encontrada');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, 'Método no permitido');

      if (pathname === '/version') return reply(res, 200, JSON.stringify({ version: BUILD_ID }), MIME['.json']);
      if (pathname === '/') return serveFile(req, res, path.join(PUBLIC_DIR, 'index.html'));
      const m = pathname.match(/^\/r\/([a-z0-9]+)\/?$/);
      if (m) {
        return rooms.exists(m[1])
          ? serveFile(req, res, path.join(PUBLIC_DIR, 'room.html'))
          : serveFile(req, res, path.join(PUBLIC_DIR, '404.html'), 404);
      }
      if (pathname.startsWith('/dist/')) return serveStatic(req, res, DIST_DIR, pathname.slice(6));
      return serveStatic(req, res, PUBLIC_DIR, pathname.slice(1));
    } catch (err) {
      console.error(err);
      if (!res.headersSent) reply(res, 500, 'Error interno');
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') return socket.destroy();
    const id = url.searchParams.get('room') ?? '';
    const room = ROOM_ID_RE.test(id) ? rooms.get(id) : null;
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!room) {
        ws.send(JSON.stringify({ t: 'error', code: 'not-found' }));
        return ws.close(4404, 'not found');
      }
      room.accept(ws);
    });
  });

  // Elimina conexiones muertas (cierre de tapa, pérdida de red, etc.).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  return {
    server,
    rooms,
    port: server.address().port,
    async close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      rooms.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
