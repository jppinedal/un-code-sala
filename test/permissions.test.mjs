import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { createApp } from '../server/app.js';

let app;
let dataDir;
const base = () => `http://127.0.0.1:${app.port}`;
const roomsDir = () => path.join(dataDir, 'rooms');

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codesala-test-'));
  app = await createApp({ port: 0, host: '127.0.0.1', dataDir });
});
after(async () => {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return;
    await wait(15);
  }
  assert.fail(`Tiempo agotado esperando: ${label}`);
}

async function createRoom(language, name) {
  const res = await fetch(`${base()}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language, name }),
  });
  assert.equal(res.status, 201);
  return res.json();
}

/** Cliente mínimo: mismo protocolo que el navegador (un documento con bloques). */
class Client {
  constructor(roomId, { owner, name = 'Test', key, port = app.port } = {}) {
    this.key = key ?? randomBytes(16).toString('hex');
    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);
    this.uid = null;
    this.role = null;
    this.members = [];
    this.total = 0;
    this.errors = [];
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${roomId}`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', key: this.key, owner, name })));
    this.ws.on('message', (data, isBinary) => (isBinary ? this.onBinary(data) : this.onJson(JSON.parse(data.toString()))));
    this.doc.on('update', (update, origin) => {
      if (origin === this || this.ws.readyState !== 1) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeUpdate(enc, update);
      this.ws.send(encoding.toUint8Array(enc));
    });
  }
  onJson(msg) {
    if (msg.t === 'welcome') {
      this.uid = msg.uid;
      this.role = msg.role;
      this.roomName = msg.name;
      this.members = msg.members;
      this.total = msg.total;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeSyncStep1(enc, this.doc);
      this.ws.send(encoding.toUint8Array(enc));
    } else if (msg.t === 'role') this.role = msg.role;
    else if (msg.t === 'room') this.roomName = msg.name;
    else if (msg.t === 'members') {
      this.members = msg.members;
      this.total = msg.total;
    } else if (msg.t === 'error') this.errors.push(msg.code);
  }
  /** Publica nuestra presencia (cursor/nombre) como lo hace el navegador. */
  publishPresence() {
    this.awareness.setLocalStateField('user', { name: 'x' });
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 1);
    encoding.writeVarUint8Array(enc, encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
    this.ws.send(encoding.toUint8Array(enc));
  }
  sees(other) {
    return this.awareness.getStates().has(other.doc.clientID);
  }
  onBinary(data) {
    const decoder = decoding.createDecoder(new Uint8Array(data));
    const type = decoding.readVarUint(decoder);
    if (type === 1) return applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
    if (type !== 0) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.readSyncMessage(decoder, enc, this.doc, this);
    if (encoding.length(enc) > 1) this.ws.send(encoding.toUint8Array(enc));
  }
  json(obj) {
    this.ws.send(JSON.stringify(obj));
  }
  close() {
    this.awareness.destroy();
    this.ws.close();
  }

  // Vista de los bloques, en el orden en que se muestran.
  blocks() {
    return [...this.doc.getMap('blocks').entries()]
      .map(([id, m]) => ({ id, lang: m.get('lang'), order: m.get('order'), text: m.get('text')?.toString() ?? '' }))
      .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  }
  summary() {
    return this.blocks().map((b) => `${b.lang}:${b.text}`);
  }
  text(id) {
    return this.doc.getMap('blocks').get(id).get('text');
  }
  addBlock(lang, text = '') {
    const blocks = this.doc.getMap('blocks');
    this.doc.transact(() => {
      const block = new Y.Map();
      blocks.set('n' + randomBytes(3).toString('hex'), block);
      block.set('lang', lang);
      block.set('order', blocks.size);
      const t = new Y.Text();
      block.set('text', t);
      if (text) t.insert(0, text);
    });
  }
}

const closeAll = (...clients) => clients.forEach((c) => c.close());
const ready = (...clients) => until(() => clients.every((c) => c.role && c.blocks().length), 'welcome y bloques');

test('una sala nueva trae un bloque con el lenguaje elegido, y el visitante ve lo que escribe el propietario', async () => {
  const { id, ownerToken } = await createRoom('python');
  const owner = new Client(id, { owner: ownerToken, name: 'Dueño' });
  const guest = new Client(id, { name: 'Visitante' });
  await ready(owner, guest);
  assert.equal(owner.role, 'owner');
  assert.equal(guest.role, 'viewer');
  assert.deepEqual(guest.summary(), ['python:']);

  const first = owner.blocks()[0].id;
  owner.text(first).insert(0, 'print("hola")');
  owner.addBlock('sql', 'SELECT 1;');
  await until(() => guest.summary().join('|') === 'python:print("hola")|sql:SELECT 1;', 'el visitante recibe ambos bloques');
  closeAll(owner, guest);
});

test('un visitante NO puede cambiar nada: ni texto, ni bloques, ni lenguajes', async () => {
  const { id, ownerToken } = await createRoom('python');
  const owner = new Client(id, { owner: ownerToken });
  const guest = new Client(id);
  await ready(owner, guest);
  const first = owner.blocks()[0].id;
  owner.text(first).insert(0, 'original');
  await until(() => guest.text(first).toString() === 'original', 'sincronización inicial');

  // El visitante manipula su copia local y la envía al servidor.
  guest.text(first).insert(0, 'HACK ');
  guest.doc.getMap('blocks').get(first).set('lang', 'rust');
  guest.addBlock('plaintext', 'bloque intruso');
  guest.doc.getMap('blocks').delete(first);
  await wait(300);
  assert.deepEqual(owner.summary(), ['python:original'], 'el propietario no recibe nada');

  const late = new Client(id);
  await until(() => late.role && late.blocks().length, 'cliente tardío sincroniza');
  assert.deepEqual(late.summary(), ['python:original']);
  closeAll(owner, guest, late);
});

test('solo el propietario puede dar y quitar permisos', async () => {
  const { id, ownerToken } = await createRoom();
  const owner = new Client(id, { owner: ownerToken });
  const guest = new Client(id);
  await ready(owner, guest);

  guest.json({ t: 'grant', uid: guest.uid });
  guest.json({ t: 'revoke', uid: owner.uid });
  guest.json({ t: 'dismiss', uid: guest.uid });
  await until(() => guest.errors.length === 3, 'tres rechazos');
  assert.deepEqual(guest.errors, ['forbidden', 'forbidden', 'forbidden']);
  assert.equal(guest.role, 'viewer');
  closeAll(owner, guest);
});

test('el propietario concede y revoca permiso; el editor puede escribir y manejar bloques', async () => {
  const { id, ownerToken } = await createRoom('javascript');
  const owner = new Client(id, { owner: ownerToken, name: 'Dueño' });
  const guest = new Client(id, { name: 'Ana' });
  await ready(owner, guest);
  const first = owner.blocks()[0].id;

  // El visitante pide permiso y el propietario lo ve.
  guest.json({ t: 'request' });
  await until(() => owner.members.some((m) => m.uid === guest.uid && m.requesting), 'solicitud visible');

  owner.json({ t: 'grant', uid: guest.uid });
  await until(() => guest.role === 'editor', 'rol editor');
  await until(() => owner.members.find((m) => m.uid === guest.uid)?.requesting === false, 'la solicitud deja de estar pendiente');

  guest.text(first).insert(0, 'escrito por Ana');
  guest.addBlock('python', 'x = 1');
  await until(() => owner.summary().join('|') === 'javascript:escrito por Ana|python:x = 1', 'edición y bloque nuevo del editor llegan');

  owner.json({ t: 'revoke', uid: guest.uid });
  await until(() => guest.role === 'viewer', 'rol viewer tras revocar');
  guest.text(first).insert(0, 'otra vez ');
  guest.addBlock('plaintext', 'no debe llegar');
  await wait(300);
  assert.deepEqual(owner.summary(), ['javascript:escrito por Ana', 'python:x = 1'], 'tras revocar, sus cambios se descartan');
  closeAll(owner, guest);
});

test('un token de propietario falso se trata como visitante', async () => {
  const { id } = await createRoom();
  const fake = new Client(id, { owner: 'token-falso' });
  await until(() => fake.role, 'welcome');
  assert.equal(fake.role, 'viewer');
  fake.close();
});

test('el permiso de editor y los bloques sobreviven a reconexiones y a recargar desde disco', async () => {
  const { id, ownerToken } = await createRoom('go');
  const owner = new Client(id, { owner: ownerToken });
  const guest = new Client(id, { name: 'Luis' });
  await ready(owner, guest);
  owner.json({ t: 'grant', uid: guest.uid });
  await until(() => guest.role === 'editor', 'editor');
  owner.text(owner.blocks()[0].id).insert(0, 'persistente');
  owner.addBlock('sql', 'SELECT 2;');
  await wait(100);

  // Reconexión con la misma clave: mantiene el permiso.
  const key = guest.key;
  guest.close();
  const again = new Client(id, { name: 'Luis', key });
  await until(() => again.role, 'welcome de reconexión');
  assert.equal(again.role, 'editor');

  closeAll(owner, again);
  await wait(100);
  app.rooms.unload(app.rooms.get(id));
  assert.ok(!app.rooms.rooms.has(id), 'sala descargada de memoria');

  const reloaded = new Client(id, { owner: ownerToken });
  await until(() => reloaded.role && reloaded.blocks().length === 2, 'contenido restaurado');
  assert.deepEqual(reloaded.summary(), ['go:persistente', 'sql:SELECT 2;']);
  assert.ok(reloaded.members.some((m) => m.role === 'editor' && m.name === 'Luis'));
  reloaded.close();
});

const sha = (s) => createHash('sha256').update(s).digest('hex');
const b64 = (doc) => Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');

test('migra una sala del primer formato (un solo texto) a un bloque, y conserva una copia', async () => {
  const ydoc = new Y.Doc();
  ydoc.getText('code').insert(0, 'código antiguo');
  const id = 'oldroom1';
  const file = path.join(roomsDir(), `${id}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      id,
      ownerHash: sha('tok-viejo-1234'),
      language: 'python',
      editors: { abcdef0123456789: 'Marta' },
      createdAt: 1,
      updatedAt: 1,
      doc: b64(ydoc),
    }),
  );
  const original = fs.readFileSync(file, 'utf8');

  const owner = new Client(id, { owner: 'tok-viejo-1234' });
  await until(() => owner.role && owner.blocks().length, 'welcome');
  assert.deepEqual(owner.summary(), ['python:código antiguo']);
  const marta = owner.members.find((m) => m.name === 'Marta');
  assert.ok(marta && marta.role === 'editor', 'el editor antiguo conserva su permiso');
  assert.equal(fs.readFileSync(file + '.premigration', 'utf8'), original, 'copia del archivo original');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 3, 'archivo ya en el formato actual');
  owner.close();
});

test('migra una sala con secciones: cada sección pasa a ser un bloque, solo "todas" conserva permiso', async () => {
  const section = (name, language, text) => {
    const d = new Y.Doc();
    d.getText('code').insert(0, text);
    return { id: name.toLowerCase().replace(/\W/g, ''), name, language, doc: b64(d) };
  };
  const id = 'sectroom';
  fs.writeFileSync(
    path.join(roomsDir(), `${id}.json`),
    JSON.stringify({
      version: 2,
      id,
      ownerHash: sha('tok-secciones'),
      createdAt: 1,
      updatedAt: 1,
      grants: {
        aaaaaaaaaaaaaaaa: { name: 'Todas', all: true, sections: [] },
        bbbbbbbbbbbbbbbb: { name: 'Parcial', all: false, sections: ['consultas'] },
      },
      sections: [
        section('Sección 1', 'python', 'def f(): pass'),
        section('Consultas', 'sql', 'SELECT 1;'),
        section('Notas', 'markdown', '# hola'),
      ],
    }),
  );

  const owner = new Client(id, { owner: 'tok-secciones' });
  await until(() => owner.role && owner.blocks().length === 3, 'bloques migrados');
  assert.deepEqual(owner.summary(), ['python:def f(): pass', 'sql:SELECT 1;', 'markdown:# hola']);
  assert.deepEqual(owner.members.filter((m) => m.role === 'editor').map((m) => m.name), ['Todas']);
  assert.ok(fs.existsSync(path.join(roomsDir(), `${id}.json.premigration`)));
  owner.close();
});

test('con muchos asistentes, los estudiantes reciben una lista reducida y el propietario la completa', async () => {
  const { id, ownerToken } = await createRoom();
  const owner = new Client(id, { owner: ownerToken, name: 'Profe' });
  const editor = new Client(id, { name: 'Ayudante' });
  const students = Array.from({ length: 6 }, (_, i) => new Client(id, { name: `Est ${i}` }));
  await ready(owner, editor, ...students);
  owner.json({ t: 'grant', uid: editor.uid });
  await until(() => editor.role === 'editor', 'ayudante autorizado');

  await until(() => owner.members.length === 8 && students.every((s) => s.total === 8), 'listas actualizadas');
  assert.equal(owner.total, 8);
  assert.deepEqual(
    owner.members.map((m) => m.name).sort(),
    ['Ayudante', 'Est 0', 'Est 1', 'Est 2', 'Est 3', 'Est 4', 'Est 5', 'Profe'],
    'el propietario ve a todos',
  );
  const seen = students[2].members.map((m) => m.name).sort();
  assert.deepEqual(seen, ['Ayudante', 'Est 2', 'Profe'], 'un estudiante ve al propietario, a los editores y a sí mismo');
  assert.equal(students[2].total, 8, 'pero conoce cuántas personas hay conectadas');
  closeAll(owner, editor, ...students);
});

test('solo quien puede editar muestra su cursor; los estudiantes lo ven pero no publican el suyo', async () => {
  const { id, ownerToken } = await createRoom();
  const owner = new Client(id, { owner: ownerToken });
  const student = new Client(id);
  const other = new Client(id);
  await ready(owner, student, other);

  student.publishPresence();
  owner.publishPresence();
  await until(() => student.sees(owner) && other.sees(owner), 'el cursor del propietario llega a los estudiantes');
  await wait(300);
  assert.equal(owner.sees(student), false, 'el cursor de un estudiante no se reenvía al propietario');
  assert.equal(other.sees(student), false, 'ni a los demás estudiantes');

  // Al dar permiso, su cursor sí se publica; al quitarlo, desaparece.
  owner.json({ t: 'grant', uid: student.uid });
  await until(() => student.role === 'editor', 'estudiante autorizado');
  student.publishPresence();
  await until(() => owner.sees(student) && other.sees(student), 'cursor del nuevo editor visible');
  owner.json({ t: 'revoke', uid: student.uid });
  await until(() => !owner.sees(student) && !other.sees(student), 'cursor retirado al quitar el permiso');
  closeAll(owner, student, other);
});

test('el tope de conexiones por sala se puede configurar', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codesala-cap-'));
  const small = await createApp({ port: 0, host: '127.0.0.1', dataDir: dir, maxConnsPerRoom: 3 });
  try {
    const res = await fetch(`http://127.0.0.1:${small.port}/api/rooms`, { method: 'POST', body: '{}' });
    const { id, ownerToken } = await res.json();
    const opts = { port: small.port };
    const a = new Client(id, { ...opts, owner: ownerToken });
    const b = new Client(id, opts);
    const c = new Client(id, opts);
    await until(() => a.role && b.role && c.role, 'tres conexiones admitidas');
    const d = new Client(id, opts);
    await until(() => d.errors.includes('full'), 'la cuarta se rechaza');
    assert.equal(d.role, null);
    closeAll(a, b, c, d);
  } finally {
    await small.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('el nombre de la sala se puede poner al crearla y solo el propietario lo cambia', async () => {
  const created = await createRoom('python', '  Métodos   numéricos  ');
  assert.equal(created.name, 'Métodos numéricos', 'el servidor limpia espacios al crear');
  const { id, ownerToken } = created;
  const owner = new Client(id, { owner: ownerToken });
  const guest = new Client(id);
  await ready(owner, guest);
  assert.equal(owner.roomName, 'Métodos numéricos');
  assert.equal(guest.roomName, 'Métodos numéricos', 'todos ven el nombre');

  // Un visitante no puede cambiarlo.
  guest.json({ t: 'room-name', name: 'Intruso' });
  await until(() => guest.errors.includes('forbidden'), 'rechazo al visitante');
  await wait(100);
  assert.equal(owner.roomName, 'Métodos numéricos');
  assert.equal(guest.roomName, 'Métodos numéricos');

  // El propietario sí, y el cambio llega a todos.
  owner.json({ t: 'room-name', name: 'Cálculo 2' });
  await until(() => guest.roomName === 'Cálculo 2' && owner.roomName === 'Cálculo 2', 'nombre nuevo para todos');

  // Se limpia el texto: sin saltos de línea ni espacios sobrantes y con tope de 60 caracteres.
  owner.json({ t: 'room-name', name: `  Taller\n\t5   ${'x'.repeat(100)}  ` });
  await until(() => guest.roomName.startsWith('Taller 5 xxx'), 'nombre limpio');
  assert.equal(guest.roomName.length, 60);
  assert.ok(!/[\n\t]|\s\s/.test(guest.roomName));

  // Se puede quitar el nombre.
  owner.json({ t: 'room-name', name: '   ' });
  await until(() => guest.roomName === '', 'nombre borrado');
  owner.json({ t: 'room-name', name: 'Persistente' });
  await until(() => guest.roomName === 'Persistente', 'nombre final');
  closeAll(owner, guest);
  await wait(100);

  // El nombre sobrevive a descargar la sala y recargarla desde el disco.
  app.rooms.unload(app.rooms.get(id));
  const again = new Client(id);
  await until(() => again.role, 'welcome tras recargar');
  assert.equal(again.roomName, 'Persistente');
  again.close();
});

test('una sala sin nombre lo informa vacío', async () => {
  const { id } = await createRoom('go');
  const guest = new Client(id);
  await until(() => guest.role, 'welcome');
  assert.equal(guest.roomName, '');
  guest.close();
});

test('el servidor informa su versión de publicación', async () => {
  const res = await fetch(`${base()}/version`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.version, 'string');
  assert.equal(body.version, 'dev', 'sin archivo VERSION se identifica como desarrollo');
});

test('salas inexistentes e ids maliciosos no se sirven', async () => {
  const miss = await fetch(`${base()}/r/zzzzzzzz`);
  assert.equal(miss.status, 404);
  const trav = await fetch(`${base()}/%2e%2e/package.json`);
  assert.notEqual(trav.status, 200);
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws?room=../../etc`);
  const msg = await new Promise((resolve) => ws.on('message', (d) => resolve(JSON.parse(d.toString()))));
  assert.equal(msg.code, 'not-found');
});
