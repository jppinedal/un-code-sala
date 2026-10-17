import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LANGUAGE_IDS, DEFAULT_LANGUAGE } from '../shared/languages.js';

// Tipos de mensaje binario (mismo esquema que y-websocket).
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const ROOM_ID_RE = /^[a-z0-9]{6,16}$/;
const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const FORMAT_VERSION = 3;

const DEFAULT_MAX_CONNS_PER_ROOM = 500;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024; // cliente que no da abasto: se desconecta y se resincroniza solo
const MEMBERS_DEBOUNCE_MS = 150; // agrupa avisos de entradas/salidas (p. ej. toda la clase entrando a la vez)
const HELLO_TIMEOUT_MS = 10_000;
const SAVE_DEBOUNCE_MS = 1_500;
const IDLE_UNLOAD_MS = 2 * 60_000;
const TOUCH_INTERVAL_MS = 24 * 3600_000;

const sha256 = (s) => createHash('sha256').update(s).digest();
const toU8 = (buf) => new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
const randomId = (n) => Array.from({ length: n }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join('');

/** Identificador público (no secreto) derivado de la clave privada del navegador. */
export const uidFromKey = (key) => sha256('uid:' + key).toString('hex').slice(0, 16);

function cleanName(raw) {
  const s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
  return s || 'Invitado';
}

/** Nombre de la sala: texto libre de hasta 60 caracteres, o vacío si no tiene nombre. */
function cleanRoomName(raw) {
  return String(raw ?? '')
    .replace(/\s+/g, ' ') // saltos de línea y tabuladores cuentan como espacios
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 60);
}

function colorFor(uid) {
  const hue = parseInt(uid.slice(0, 4), 16) % 360;
  return { color: `hsl(${hue}, 75%, 55%)`, colorLight: `hsla(${hue}, 75%, 55%, 0.25)` };
}

function cleanCursor(c) {
  if (!c || typeof c !== 'object' || !c.anchor || !c.head) return null;
  return JSON.stringify(c).length < 2000 ? { anchor: c.anchor, head: c.head } : null;
}

const send = (conn, data) => {
  const ws = conn.ws;
  if (ws.readyState !== 1) return;
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return ws.terminate();
  if (typeof data === 'string') ws.send(data);
  else ws.send(data, { binary: true });
};
const sendJson = (conn, obj) => send(conn, JSON.stringify(obj));

// ---------- Bloques ----------
// El documento Yjs de la sala contiene un mapa "blocks": id -> Y.Map { lang, order, text: Y.Text }.
// Quien puede escribir en la sala puede añadir, mover, borrar y editar bloques.

/** Añade bloques al final del documento (usado al crear salas y al migrar formatos antiguos). */
function addBlocks(doc, items) {
  doc.transact(() => {
    const blocks = doc.getMap('blocks');
    const base = blocks.size;
    items.forEach((item, i) => {
      const block = new Y.Map();
      blocks.set(randomId(8), block);
      block.set('lang', LANGUAGE_IDS.has(item.lang) ? item.lang : DEFAULT_LANGUAGE);
      block.set('order', base + i);
      const text = new Y.Text();
      block.set('text', text);
      if (item.text) text.insert(0, item.text);
    });
  });
}

/**
 * Reconstruye el documento de la sala a partir de lo guardado en disco.
 *  - v1: un solo texto ("code") + lenguaje de la sala  -> un bloque.
 *  - v2: varias secciones, cada una con su documento   -> un bloque por sección.
 *    (los permisos por sección no existen ya: solo conservan permiso quienes lo tenían en "todas").
 *  - v3: documento con bloques (formato actual).
 */
function loadRoomData(data) {
  const doc = new Y.Doc();
  let editors = data.editors ?? {};

  if (data.sections) {
    editors = {};
    for (const [uid, g] of Object.entries(data.grants ?? {})) if (g.all) editors[uid] = g.name;
    const items = data.sections.map((s) => {
      const tmp = new Y.Doc();
      if (s.doc) Y.applyUpdate(tmp, Buffer.from(s.doc, 'base64'));
      const item = { lang: s.language, text: tmp.getText('code').toString() };
      tmp.destroy();
      return item;
    });
    addBlocks(doc, items);
  } else {
    if (data.doc) Y.applyUpdate(doc, Buffer.from(data.doc, 'base64'));
    // Solo el primer formato guardaba un único texto. En el actual, una sala sin bloques es una sala limpiada.
    if (data.version !== FORMAT_VERSION && doc.getMap('blocks').size === 0) {
      const legacy = doc.getText('code');
      addBlocks(doc, [{ lang: data.language, text: legacy.toString() }]);
      if (legacy.length) legacy.delete(0, legacy.length);
    }
  }
  return { doc, editors, migrated: data.version !== FORMAT_VERSION };
}

export class Room {
  constructor(manager, data) {
    this.manager = manager;
    this.id = data.id;
    this.ownerHash = Buffer.from(data.ownerHash, 'hex');
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt ?? data.createdAt;
    this.name = cleanRoomName(data.name); // nombre de la sala, lo cambia solo el propietario
    this.conns = new Set();
    this.requests = new Set(); // uids que piden permiso (solo en memoria)
    this.saveTimer = null;
    this.idleTimer = null;
    this.membersTimer = null;
    this.deleted = false; // la eliminó su propietario: ya no se guarda ni se acepta nada

    const loaded = loadRoomData(data);
    this.doc = loaded.doc;
    this.migrated = loaded.migrated;
    this.editors = new Map(Object.entries(loaded.editors)); // uid -> nombre
    this.awareness = new Awareness(this.doc);
    this.awareness.setLocalState(null);

    this.doc.on('update', (update, origin) => {
      this.touch();
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.broadcast(encoding.toUint8Array(enc), origin);
    });
    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(
        enc,
        encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]),
      );
      this.broadcast(encoding.toUint8Array(enc), origin);
    });
  }

  // ---------- Permisos ----------
  roleOf(conn) {
    if (conn.isOwner) return 'owner';
    return this.editors.has(conn.uid) ? 'editor' : 'viewer';
  }
  canEdit(conn) {
    return conn.isOwner || this.editors.has(conn.uid);
  }

  // ---------- Conexiones ----------
  accept(ws) {
    const conn = { ws, ready: false, uid: null, name: '', isOwner: false, awarenessId: null };
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    const helloTimer = setTimeout(() => ws.close(4408, 'hello timeout'), HELLO_TIMEOUT_MS);

    ws.on('message', (data, isBinary) => {
      if (this.deleted) return;
      try {
        if (!conn.ready) {
          const msg = isBinary ? null : JSON.parse(data.toString());
          if (msg?.t !== 'hello') return ws.close(4400, 'expected hello');
          clearTimeout(helloTimer);
          this.onHello(conn, msg);
        } else if (isBinary) {
          this.onBinary(conn, toU8(data));
        } else {
          this.onJson(conn, JSON.parse(data.toString()));
        }
      } catch {
        // Mensaje mal formado: se ignora.
      }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      this.leave(conn);
    });
    ws.on('error', () => {});
  }

  onHello(conn, msg) {
    if (typeof msg.key !== 'string' || !KEY_RE.test(msg.key)) return conn.ws.close(4400, 'bad key');
    if (this.conns.size >= this.manager.maxConns) {
      sendJson(conn, { t: 'error', code: 'full' });
      return conn.ws.close(4429, 'room full');
    }
    conn.uid = uidFromKey(msg.key);
    conn.name = cleanName(msg.name);
    conn.isOwner =
      typeof msg.owner === 'string' &&
      msg.owner.length <= 200 &&
      timingSafeEqual(sha256(msg.owner), this.ownerHash);
    conn.ready = true;
    this.conns.add(conn);
    clearTimeout(this.idleTimer);
    if (this.editors.has(conn.uid)) this.editors.set(conn.uid, conn.name);
    if (Date.now() - this.updatedAt > TOUCH_INTERVAL_MS) this.touch();

    sendJson(conn, {
      t: 'welcome',
      uid: conn.uid,
      role: this.roleOf(conn),
      name: this.name,
      ...this.membersPayload(conn),
    });

    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    send(conn, encoding.toUint8Array(enc));

    const ids = [...this.awareness.getStates().keys()];
    if (ids.length) {
      const aenc = encoding.createEncoder();
      encoding.writeVarUint(aenc, MSG_AWARENESS);
      encoding.writeVarUint8Array(aenc, encodeAwarenessUpdate(this.awareness, ids));
      send(conn, encoding.toUint8Array(aenc));
    }
    this.broadcastMembers();
  }

  leave(conn) {
    if (!this.conns.delete(conn)) return;
    if (conn.awarenessId != null) removeAwarenessStates(this.awareness, [conn.awarenessId], null);
    if (![...this.conns].some((c) => c.uid === conn.uid)) this.requests.delete(conn.uid);
    this.broadcastMembers();
    if (this.conns.size === 0) {
      this.idleTimer = setTimeout(() => this.manager.unload(this), IDLE_UNLOAD_MS);
    }
  }

  broadcast(msg, except = null) {
    for (const c of this.conns) if (c !== except) send(c, msg);
  }

  // ---------- Mensajes de control (JSON) ----------
  onJson(conn, msg) {
    const forbidden = () => sendJson(conn, { t: 'error', code: 'forbidden' });
    switch (msg.t) {
      case 'name': {
        const name = cleanName(msg.name);
        for (const c of this.conns) if (c.uid === conn.uid) c.name = name;
        if (this.editors.has(conn.uid)) {
          this.editors.set(conn.uid, name);
          this.touch();
        }
        this.broadcastMembers();
        break;
      }
      case 'grant': {
        if (!conn.isOwner) return forbidden();
        const target = [...this.conns].find((c) => c.uid === msg.uid);
        if (!target || target.isOwner) return;
        this.editors.set(target.uid, target.name);
        this.requests.delete(target.uid);
        this.touch();
        this.refreshRoles(target.uid);
        this.broadcastMembers();
        break;
      }
      case 'revoke':
        if (!conn.isOwner) return forbidden();
        if (this.editors.delete(msg.uid)) {
          this.touch();
          this.refreshRoles(msg.uid);
          this.broadcastMembers();
        }
        break;
      case 'request':
        if (this.canEdit(conn)) return;
        if (msg.on === false) this.requests.delete(conn.uid);
        else this.requests.add(conn.uid);
        this.broadcastMembers();
        break;
      case 'dismiss':
        if (!conn.isOwner) return forbidden();
        if (this.requests.delete(msg.uid)) this.broadcastMembers();
        break;
      case 'room-name': {
        if (!conn.isOwner) return forbidden();
        const name = cleanRoomName(msg.name);
        if (name === this.name) break;
        this.name = name;
        this.touch();
        this.broadcast(JSON.stringify({ t: 'room', name }));
        break;
      }
    }
  }

  refreshRoles(uid) {
    for (const c of this.conns) {
      if (c.uid !== uid) continue;
      sendJson(c, { t: 'role', role: this.roleOf(c) });
      // Quien deja de poder editar también deja de mostrar su cursor.
      if (!this.canEdit(c) && c.awarenessId != null) {
        removeAwarenessStates(this.awareness, [c.awarenessId], null);
        c.awarenessId = null;
      }
    }
  }

  membersList() {
    const online = new Map();
    for (const c of this.conns) {
      const m = online.get(c.uid) ?? { name: c.name, owner: false };
      m.name = c.name;
      m.owner ||= c.isOwner;
      online.set(c.uid, m);
    }
    const rank = { owner: 0, editor: 1, viewer: 2 };
    const list = [];
    for (const [uid, m] of online) {
      const role = m.owner ? 'owner' : this.editors.has(uid) ? 'editor' : 'viewer';
      list.push({ uid, name: m.name, role, online: true, requesting: this.requests.has(uid), color: colorFor(uid).color });
    }
    for (const [uid, name] of this.editors) {
      if (!online.has(uid)) list.push({ uid, name, role: 'editor', online: false, requesting: false, color: colorFor(uid).color });
    }
    return list.sort(
      (a, b) => rank[a.role] - rank[b.role] || b.online - a.online || a.name.localeCompare(b.name),
    );
  }

  /**
   * Lo que cada persona necesita saber de la sala. El propietario recibe la lista completa
   * (la usa para dar permisos); los demás solo reciben al propietario, a los editores y a sí
   * mismos, más el total de conectados. Con una clase de 200 personas, enviar a todos la lista
   * completa en cada entrada crece con el cuadrado de los asistentes.
   */
  membersPayload(conn, ctx = this.membersContext()) {
    if (conn.isOwner) return { members: ctx.full, total: ctx.total };
    const self = ctx.byUid.get(conn.uid);
    const members = self && self.role === 'viewer' ? [...ctx.light, self] : ctx.light;
    return { members, total: ctx.total };
  }

  membersContext() {
    const full = this.membersList();
    return {
      full,
      total: full.filter((m) => m.online).length,
      light: full.filter((m) => m.role !== 'viewer'),
      byUid: new Map(full.map((m) => [m.uid, m])),
    };
  }

  /** Avisa de cambios en las personas conectadas, agrupando los que ocurren casi a la vez. */
  broadcastMembers() {
    if (this.membersTimer) return;
    this.membersTimer = setTimeout(() => {
      this.membersTimer = null;
      const ctx = this.membersContext();
      const shared = new Map(); // propietario y editores reciben el mismo mensaje
      for (const c of this.conns) {
        const isViewer = !c.isOwner && !this.editors.has(c.uid);
        const key = c.isOwner ? 'owner' : isViewer ? c.uid : 'editor';
        if (!shared.has(key)) shared.set(key, JSON.stringify({ t: 'members', ...this.membersPayload(c, ctx) }));
        send(c, shared.get(key));
      }
    }, MEMBERS_DEBOUNCE_MS);
  }

  // ---------- Mensajes binarios (Yjs) ----------
  onBinary(conn, data) {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);

    if (type === MSG_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      const syncType = decoding.readVarUint(decoder);
      if (syncType === syncProtocol.messageYjsSyncStep1) {
        // Cualquiera puede LEER: pedir el estado del documento.
        syncProtocol.readSyncStep1(decoder, enc, this.doc);
      } else if (
        (syncType === syncProtocol.messageYjsSyncStep2 || syncType === syncProtocol.messageYjsUpdate) &&
        this.canEdit(conn)
      ) {
        // Solo el propietario y los editores autorizados pueden ESCRIBIR (texto, bloques o lenguajes).
        // Para los demás, step2/update se descartan sin aplicarse.
        syncProtocol.readSyncStep2(decoder, this.doc, conn);
      }
      if (encoding.length(enc) > 1) send(conn, encoding.toUint8Array(enc));
    } else if (type === MSG_AWARENESS) {
      this.onAwareness(conn, decoding.readVarUint8Array(decoder));
    }
  }

  /**
   * Presencia (cursores): se aceptan solo los datos del propio cliente y el
   * nombre/color los fija el servidor, para que nadie suplante a otra persona.
   */
  onAwareness(conn, update) {
    // Solo quien puede editar muestra su cursor: así los estudiantes ven dónde escribe el
    // profesor, y no reciben (ni ven) los cursores de las otras 199 personas.
    if (!this.canEdit(conn)) return;
    const dec = decoding.createDecoder(update);
    const len = decoding.readVarUint(dec);
    const body = encoding.createEncoder();
    let kept = 0;
    for (let i = 0; i < len; i++) {
      const clientID = decoding.readVarUint(dec);
      const clock = decoding.readVarUint(dec);
      const state = JSON.parse(decoding.readVarString(dec));
      if (conn.awarenessId == null) conn.awarenessId = clientID;
      if (clientID !== conn.awarenessId) continue;
      const cleaned =
        state === null
          ? null
          : { cursor: cleanCursor(state.cursor), user: { name: conn.name, ...colorFor(conn.uid) } };
      encoding.writeVarUint(body, clientID);
      encoding.writeVarUint(body, clock);
      encoding.writeVarString(body, JSON.stringify(cleaned));
      kept++;
    }
    if (!kept) return;
    const out = encoding.createEncoder();
    encoding.writeVarUint(out, kept);
    encoding.writeUint8Array(out, encoding.toUint8Array(body));
    applyAwarenessUpdate(this.awareness, encoding.toUint8Array(out), conn);
  }

  // ---------- Persistencia ----------
  touch() {
    if (this.deleted) return;
    this.updatedAt = Date.now();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), SAVE_DEBOUNCE_MS);
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.deleted) return;
    this.manager.write({
      version: FORMAT_VERSION,
      id: this.id,
      ownerHash: this.ownerHash.toString('hex'),
      name: this.name,
      editors: Object.fromEntries(this.editors),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      doc: Buffer.from(Y.encodeStateAsUpdate(this.doc)).toString('base64'),
    });
  }

  destroy() {
    clearTimeout(this.saveTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.membersTimer);
    this.awareness.destroy();
    this.doc.destroy();
  }

  /** Cierra la sala para siempre: avisa a quienes están dentro (código 4410, no reintentan) y deja de guardar. */
  dispose() {
    this.deleted = true;
    const conns = [...this.conns];
    this.conns.clear();
    for (const conn of conns) {
      sendJson(conn, { t: 'error', code: 'deleted' });
      conn.ws.close(4410, 'deleted');
    }
    this.destroy();
  }
}

export class RoomManager {
  constructor({ dataDir, ttlDays = 30, maxConnsPerRoom = DEFAULT_MAX_CONNS_PER_ROOM }) {
    this.dir = path.join(dataDir, 'rooms');
    this.ttlMs = ttlDays * 24 * 3600_000;
    this.maxConns = maxConnsPerRoom;
    this.rooms = new Map();
    this.sweepTimer = null;
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    this.sweep();
    this.sweepTimer = setInterval(() => this.sweep(), 3600_000);
    this.sweepTimer.unref();
  }

  file(id) {
    return path.join(this.dir, `${id}.json`);
  }

  write(data) {
    const file = this.file(data.id);
    try {
      fs.writeFileSync(file + '.tmp', JSON.stringify(data));
      fs.renameSync(file + '.tmp', file);
    } catch (err) {
      console.error(`No se pudo guardar la sala ${data.id}:`, err.message);
    }
  }

  exists(id) {
    return ROOM_ID_RE.test(id) && (this.rooms.has(id) || fs.existsSync(this.file(id)));
  }

  create(language, name) {
    let id;
    do id = randomId(8);
    while (this.exists(id));
    const ownerToken = randomBytes(24).toString('base64url');
    const now = Date.now();
    const doc = new Y.Doc();
    addBlocks(doc, [{ lang: language, text: '' }]);
    this.write({
      version: FORMAT_VERSION,
      id,
      ownerHash: sha256(ownerToken).toString('hex'),
      name: cleanRoomName(name),
      editors: {},
      createdAt: now,
      updatedAt: now,
      doc: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
    });
    doc.destroy();
    return { id, ownerToken, name: cleanRoomName(name) };
  }

  get(id) {
    if (!ROOM_ID_RE.test(id)) return null;
    let room = this.rooms.get(id);
    if (room) return room;
    const file = this.file(id);
    try {
      room = new Room(this, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return null;
    }
    if (room.migrated) {
      // La conversión de formatos antiguos no es reversible: se conserva una copia del original.
      try {
        fs.copyFileSync(file, file + '.premigration', fs.constants.COPYFILE_EXCL);
      } catch {}
      room.save();
      room.migrated = false;
    }
    this.rooms.set(id, room);
    return room;
  }

  /** Elimina una sala si `token` es el de su propietario. Devuelve 'ok', 'forbidden' o 'not-found'. */
  remove(id, token) {
    const room = this.get(id);
    if (!room) return 'not-found';
    if (typeof token !== 'string' || token.length > 200 || !timingSafeEqual(sha256(token), room.ownerHash)) return 'forbidden';
    this.rooms.delete(id);
    room.dispose();
    for (const suffix of ['', '.premigration', '.tmp']) {
      try {
        fs.unlinkSync(this.file(id) + suffix);
      } catch {}
    }
    return 'ok';
  }

  unload(room) {
    if (room.conns.size > 0 || this.rooms.get(room.id) !== room) return;
    room.save();
    this.rooms.delete(room.id);
    room.destroy();
  }

  sweep() {
    const now = Date.now();
    for (const name of fs.readdirSync(this.dir)) {
      const id = name.replace(/\.json$/, '');
      if (!name.endsWith('.json') || this.rooms.has(id)) continue;
      try {
        if (now - fs.statSync(path.join(this.dir, name)).mtimeMs > this.ttlMs) {
          fs.unlinkSync(path.join(this.dir, name));
        }
      } catch {}
    }
  }

  close() {
    clearInterval(this.sweepTimer);
    for (const room of this.rooms.values()) {
      room.save();
      room.destroy();
    }
    this.rooms.clear();
  }
}
