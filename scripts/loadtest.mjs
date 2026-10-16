// Prueba de carga: un profesor (propietario) y N estudiantes conectados a la misma sala.
//
//   node scripts/loadtest.mjs --url http://127.0.0.1:3000 --viewers 200 --pid <PID del servidor>
//
// Mide cuánto tarda la entrada masiva, cuánto tarda cada cambio del profesor en llegar a
// todos, si se pierde algo y cuánta CPU y memoria usa el servidor (si se indica --pid).
// Todos los clientes viven en este mismo proceso, así que las latencias incluyen el trabajo
// del propio generador de carga: son una cota superior de lo que vería un estudiante real.
import WebSocket from 'ws';
import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const URL_BASE = arg('url', 'http://127.0.0.1:3000').replace(/\/$/, '');
const VIEWERS = Number(arg('viewers', 200));
const EDITS = Number(arg('edits', 60));
const RATE = Number(arg('rate', 10)); // cambios del profesor por segundo
const CURSORS = Number(arg('cursors', Math.round(VIEWERS * 0.2))); // estudiantes que mueven el cursor
const PID = arg('pid', null);
const MAX_P95_MS = Number(arg('max-p95', 1000));
const SETTLE_MS = Number(arg('settle', 1500)); // pausa tras la entrada masiva, antes de que el profesor escriba

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : NaN);
const fmt = (n, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : 'n/d');

function serverStats() {
  if (!PID) return null;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `$p=Get-Process -Id ${PID}; "$($p.TotalProcessorTime.TotalSeconds) $($p.WorkingSet64)"`],
        { encoding: 'utf8' },
      ).trim();
      const [cpu, rss] = out.split(' ').map(Number);
      return { cpu, rssMB: rss / 1048576 };
    }
    const out = execFileSync('ps', ['-o', 'times=,rss=', '-p', PID], { encoding: 'utf8' }).trim().split(/\s+/).map(Number);
    return { cpu: out[0], rssMB: out[1] / 1024 };
  } catch {
    return null;
  }
}

/** Cliente simulado con el mismo protocolo que el navegador. */
class Bot {
  constructor(roomId, { owner, name }) {
    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);
    this.bytes = 0;
    this.msgs = 0;
    this.role = null;
    this.failure = null;
    this.arrivals = new Map(); // índice de cambio -> instante de llegada
    this.welcomed = deferred();
    this.synced = deferred();
    this.startedAt = performance.now();
    this.syncedAfter = NaN;

    const key = randomBytes(16).toString('hex');
    const ws = (this.ws = new WebSocket(`${URL_BASE.replace(/^http/, 'ws')}/ws?room=${roomId}`));
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', key, owner, name })));
    ws.on('message', (data, isBinary) => {
      this.bytes += data.length;
      this.msgs++;
      if (isBinary) this.onBinary(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      else this.onJson(JSON.parse(data.toString()));
    });
    ws.on('close', (code) => {
      this.failure ??= `cerrada (${code})`;
      this.welcomed.resolve(false);
      this.synced.resolve(false);
    });
    ws.on('error', (e) => {
      this.failure ??= e.message;
      this.welcomed.resolve(false);
      this.synced.resolve(false);
    });

    this.doc.on('update', (update, origin) => {
      if (origin === this || ws.readyState !== 1) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeUpdate(enc, update);
      ws.send(encoding.toUint8Array(enc));
    });
    this.awareness.on('update', ({ added, updated, removed }) => {
      if (ws.readyState !== 1 || ![...added, ...updated, ...removed].includes(this.doc.clientID)) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 1);
      encoding.writeVarUint8Array(enc, encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
      ws.send(encoding.toUint8Array(enc));
    });
    // Registra cuándo llega cada marcador "#n;" que escribe el profesor.
    this.doc.getMap('blocks').observeDeep((events) => {
      for (const e of events) {
        if (!(e.target instanceof Y.Text)) continue;
        for (const op of e.delta) {
          if (typeof op.insert !== 'string') continue;
          for (const m of op.insert.matchAll(/#(\d+);/g)) {
            if (!this.arrivals.has(+m[1])) this.arrivals.set(+m[1], performance.now());
          }
        }
      }
    });
  }

  onJson(msg) {
    if (msg.t === 'welcome') {
      this.role = msg.role;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeSyncStep1(enc, this.doc);
      this.ws.send(encoding.toUint8Array(enc));
      this.awareness.setLocalState({});
      this.welcomed.resolve(true);
    } else if (msg.t === 'error') {
      this.failure ??= `error: ${msg.code}`;
    }
  }

  onBinary(data) {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === 0) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      const t = syncProtocol.readSyncMessage(decoder, enc, this.doc, this);
      if (encoding.length(enc) > 1) this.ws.send(encoding.toUint8Array(enc));
      if (t === syncProtocol.messageYjsSyncStep2 && Number.isNaN(this.syncedAfter)) {
        this.syncedAfter = performance.now() - this.startedAt;
        this.synced.resolve(true);
      }
    } else if (type === 1) {
      applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
    }
  }

  get text() {
    const block = this.doc.getMap('blocks').values().next().value;
    return block?.get('text');
  }
}

// Modo "clase llena": --room <id> --hold <segundos> conecta estudiantes a una sala que ya existe
// (por ejemplo, abierta en tu navegador) y los mantiene conectados para que veas la interfaz.
async function holdRoom(roomId) {
  const seconds = Number(arg('hold', 30));
  const bots = Array.from({ length: VIEWERS }, (_, i) => new Bot(roomId, { name: `Estudiante ${i + 1}` }));
  await Promise.race([Promise.all(bots.map((b) => b.synced.promise)), sleep(30_000)]);
  const ok = bots.filter((b) => !Number.isNaN(b.syncedAfter)).length;
  console.log(`${ok}/${VIEWERS} estudiantes conectados a la sala ${roomId}; se mantienen ${seconds} s.`);
  await sleep(seconds * 1000);
  for (const b of bots) b.ws.terminate();
  process.exit(ok === VIEWERS ? 0 : 1);
}

async function main() {
  if (arg('room')) return holdRoom(arg('room'));
  console.log(`Servidor: ${URL_BASE} | estudiantes: ${VIEWERS} + profesor | cambios: ${EDITS} a ${RATE}/s | cursores activos: ${CURSORS}`);
  const res = await fetch(`${URL_BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language: 'python' }),
  });
  if (!res.ok) throw new Error(`No se pudo crear la sala: ${res.status}`);
  const { id, ownerToken } = await res.json();

  const stats0 = serverStats();
  const owner = new Bot(id, { owner: ownerToken, name: 'Profesor' });
  await owner.synced.promise;
  if (owner.failure) throw new Error(`El profesor no pudo conectarse: ${owner.failure}`);

  // 1) Entrada masiva: todos los estudiantes a la vez.
  const t0 = performance.now();
  const viewers = Array.from({ length: VIEWERS }, (_, i) => new Bot(id, { name: `Estudiante ${i + 1}` }));
  await Promise.race([Promise.all(viewers.map((v) => v.synced.promise)), sleep(60_000)]);
  const joinMs = performance.now() - t0;
  await sleep(SETTLE_MS); // deja asentar los avisos de "personas conectadas"
  const stats1 = serverStats();

  const ok = viewers.filter((v) => v.role === 'viewer' && !Number.isNaN(v.syncedAfter));
  const failed = viewers.filter((v) => !ok.includes(v));
  const syncTimes = ok.map((v) => v.syncedAfter).sort((a, b) => a - b);
  const joinBytes = ok.map((v) => v.bytes).sort((a, b) => a - b);
  const joinMsgs = ok.map((v) => v.msgs).sort((a, b) => a - b);

  // 2) Régimen normal: el profesor escribe y algunos estudiantes mueven el cursor.
  for (const v of ok) {
    v.bytes = 0;
    v.msgs = 0;
  }
  const ownerText = owner.text;
  const movers = ok.slice(0, CURSORS);
  const cursorTimer = setInterval(() => {
    for (const v of movers) {
      const t = v.text;
      if (!t) continue;
      const pos = Y.createRelativePositionFromTypeIndex(t, Math.floor(Math.random() * (t.length + 1)));
      v.awareness.setLocalStateField('cursor', { anchor: Y.relativePositionToJSON(pos), head: Y.relativePositionToJSON(pos) });
    }
  }, 1000);

  const sent = new Map();
  for (let i = 0; i < EDITS; i++) {
    sent.set(i, performance.now());
    ownerText.insert(ownerText.length, `#${i};`);
    await sleep(1000 / RATE);
  }
  const deadline = performance.now() + 8000;
  while (performance.now() < deadline && ok.some((v) => v.arrivals.size < EDITS)) await sleep(50);
  clearInterval(cursorTimer);
  const stats2 = serverStats();

  const latencies = [];
  let missing = 0;
  for (const v of ok) {
    for (let i = 0; i < EDITS; i++) {
      const at = v.arrivals.get(i);
      if (at === undefined) missing++;
      else latencies.push(at - sent.get(i));
    }
  }
  latencies.sort((a, b) => a - b);
  const steadyBytes = ok.map((v) => v.bytes).sort((a, b) => a - b);
  const steadyMsgs = ok.map((v) => v.msgs).sort((a, b) => a - b);
  const durationS = (EDITS / RATE);

  console.log('\n=== Entrada masiva ===');
  console.log(`Conectados con éxito: ${ok.length}/${VIEWERS}  (fallaron: ${failed.length}${failed.length ? `, motivo: ${[...new Set(failed.map((f) => f.failure))].join('; ')}` : ''})`);
  console.log(`Tiempo hasta que todos tienen el contenido: ${fmt(joinMs)} ms`);
  console.log(`Tiempo por estudiante hasta recibir el contenido: p50 ${fmt(pct(syncTimes, 50))} ms | p95 ${fmt(pct(syncTimes, 95))} ms | máx ${fmt(syncTimes.at(-1))} ms`);
  console.log(`Datos recibidos por estudiante al entrar: mediana ${fmt(pct(joinBytes, 50) / 1024, 1)} KB (${fmt(pct(joinMsgs, 50))} mensajes) | máx ${fmt(joinBytes.at(-1) / 1024, 1)} KB`);
  console.log('\n=== Clase en curso ===');
  console.log(`Cambios del profesor entregados: ${ok.length * EDITS - missing}/${ok.length * EDITS}  (perdidos: ${missing})`);
  console.log(`Latencia profesor -> estudiante: p50 ${fmt(pct(latencies, 50))} ms | p95 ${fmt(pct(latencies, 95))} ms | p99 ${fmt(pct(latencies, 99))} ms | máx ${fmt(latencies.at(-1))} ms`);
  console.log(`Tráfico por estudiante: mediana ${fmt(pct(steadyBytes, 50) / 1024 / durationS, 2)} KB/s (${fmt(pct(steadyMsgs, 50) / durationS, 1)} mensajes/s)`);
  if (stats0 && stats1 && stats2) {
    console.log('\n=== Servidor ===');
    console.log(`Memoria: ${fmt(stats0.rssMB)} MB en reposo -> ${fmt(stats1.rssMB)} MB con ${ok.length + 1} conectados -> ${fmt(stats2.rssMB)} MB tras la clase`);
    console.log(`CPU durante la entrada masiva: ${fmt(stats1.cpu - stats0.cpu, 2)} s | durante ${fmt(durationS + 8, 0)} s de clase: ${fmt(stats2.cpu - stats1.cpu, 2)} s`);
  }

  const pass = failed.length === 0 && missing === 0 && pct(latencies, 95) <= MAX_P95_MS;
  console.log(`\nResultado: ${pass ? 'OK' : 'FALLO'} (criterio: sin conexiones fallidas, sin cambios perdidos y p95 <= ${MAX_P95_MS} ms)`);

  for (const bot of [owner, ...viewers]) bot.ws.terminate();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
