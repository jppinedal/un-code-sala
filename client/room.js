import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { EditorState, Compartment } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
} from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import {
  indentOnInput,
  bracketMatching,
  foldGutter,
  foldKeymap,
  syntaxHighlighting,
  defaultHighlightStyle,
} from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { oneDark } from '@codemirror/theme-one-dark';
import qrcode from 'qrcode-generator';
import { LANGUAGES, LANGUAGE_IDS, DEFAULT_LANGUAGE } from '../shared/languages.js';
import { loadLanguage } from './languages.js';
import { RoomConnection } from './connection.js';

const $ = (sel) => document.querySelector(sel);
const roomId = location.pathname.split('/')[2];
const MAX_BLOCKS = 30;

// ---------- Almacenamiento local (identidad del navegador) ----------
const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};
const randomHex = (bytes) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');

let userKey = store.get('codesala:key');
if (!userKey) store.set('codesala:key', (userKey = randomHex(24)));

let myName = store.get('codesala:name');
if (!myName) store.set('codesala:name', (myName = `Invitado ${Math.floor(1000 + Math.random() * 9000)}`));

// El enlace de propietario trae el token en el fragmento (#owner=...), que nunca viaja al servidor.
const hashToken = new URLSearchParams(location.hash.slice(1)).get('owner');
if (hashToken) {
  store.set(`codesala:owner:${roomId}`, hashToken);
  history.replaceState(null, '', location.pathname);
}
const ownerToken = store.get(`codesala:owner:${roomId}`) || undefined;

// Pegar un enlace de propietario en una pestaña con la sala ya abierta solo cambia el hash.
window.addEventListener('hashchange', () => {
  if (new URLSearchParams(location.hash.slice(1)).get('owner')) location.reload();
});

// ---------- Estado ----------
const state = {
  uid: null,
  role: 'viewer', // owner | editor | viewer
  members: [],
  total: 0, // personas conectadas (puede ser mayor que la lista, que los estudiantes reciben recortada)
  roomName: '', // nombre de la sala (vacío si no tiene); solo el propietario lo cambia
  requested: false,
  synced: false, // ya recibimos el contenido de la sala
  catchUp: false, // tras una desconexión, hasta recibir lo que pasó mientras no estábamos
  theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
};
const canEdit = () => state.role === 'owner' || state.role === 'editor';

// ---------- Utilidades de UI ----------
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ico');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/** Aviso temporal; con `action` ({ label, run }) muestra un botón y dura más. */
function toast(text, kind = 'info', action = null) {
  const node = el('div', `toast ${kind}`, text);
  if (action) {
    const btn = el('button', 'toast-action', action.label);
    btn.onclick = () => {
      node.remove();
      action.run();
    };
    node.append(btn);
  }
  const ms = action ? 8000 : 3600;
  $('#toasts').append(node);
  setTimeout(() => node.classList.add('out'), ms);
  setTimeout(() => node.remove(), ms + 400);
}

/** Copia al portapapeles; devuelve true si lo logró. */
async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

async function copyWithToast(text, okMsg) {
  if (await writeClipboard(text)) toast(okMsg, 'ok');
  else toast('No se pudo copiar al portapapeles', 'error');
}

function showOverlay(title, text) {
  $('#overlay-title').textContent = title;
  $('#overlay-text').textContent = text;
  $('#overlay').hidden = false;
}

// ---------- Documento: un mapa de bloques ----------
// blocks: id -> Y.Map { lang: string, order: number, text: Y.Text }
const doc = new Y.Doc();
const blocksMap = doc.getMap('blocks');
const awareness = new Awareness(doc);

const validLang = (l) => (typeof l === 'string' && LANGUAGE_IDS.has(l) ? l : DEFAULT_LANGUAGE);
const orderOf = (m) => (typeof m.get('order') === 'number' ? m.get('order') : 0);

/** Bloques válidos, en el orden en que se muestran. */
function blockEntries() {
  return [...blocksMap.entries()]
    .filter(([, m]) => m instanceof Y.Map && m.get('text') instanceof Y.Text)
    .sort((a, b) => orderOf(a[1]) - orderOf(b[1]) || (a[0] < b[0] ? -1 : 1));
}
const orderedIds = () => blockEntries().map(([id]) => id);

const randomId = () => randomHex(4);

/** Renumera los bloques según `ids` (una sola transacción). */
function applyOrder(ids) {
  doc.transact(() => {
    ids.forEach((id, i) => {
      const m = blocksMap.get(id);
      if (m && m.get('order') !== i) m.set('order', i);
    });
  });
}

let pendingFocus = null;

function addBlock(afterId = null) {
  const ids = orderedIds();
  if (ids.length >= MAX_BLOCKS) return toast(`Máximo ${MAX_BLOCKS} bloques por sala`, 'error');
  const id = randomId();
  const lang = validLang(blocksMap.get(afterId ?? ids.at(-1))?.get('lang'));
  ids.splice(afterId ? ids.indexOf(afterId) + 1 : ids.length, 0, id);
  pendingFocus = id; // debe fijarse antes: el observador se ejecuta al cerrar la transacción
  doc.transact(() => {
    const block = new Y.Map();
    blocksMap.set(id, block);
    block.set('lang', lang);
    block.set('text', new Y.Text());
    applyOrder(ids);
  });
}

function moveBlock(id, delta) {
  const ids = orderedIds();
  const i = ids.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  applyOrder(ids);
}

function deleteBlock(id) {
  const ids = orderedIds();
  if (ids.length <= 1) return;
  doc.transact(() => {
    blocksMap.delete(id);
    applyOrder(ids.filter((x) => x !== id));
  });
}

/** Elimina todos los bloques. Sin confirmación, pero el aviso permite deshacer durante unos segundos. */
function clearBlocks() {
  const saved = blockEntries().map(([, m]) => ({ lang: validLang(m.get('lang')), text: m.get('text').toString() }));
  if (!saved.length || !canEdit()) return;
  doc.transact(() => blocksMap.clear());
  toast('Sala limpiada', 'info', { label: 'Deshacer', run: () => restoreBlocks(saved) });
}

function restoreBlocks(saved) {
  if (!canEdit()) return;
  const base = orderedIds().length;
  doc.transact(() => {
    saved.slice(0, MAX_BLOCKS - base).forEach((b, i) => {
      const block = new Y.Map();
      blocksMap.set(randomId(), block);
      block.set('lang', b.lang);
      block.set('order', base + i);
      const text = new Y.Text();
      block.set('text', text);
      if (b.text) text.insert(0, b.text);
    });
  });
}

// ---------- Editores (uno por bloque) ----------
const lightTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#ffffff', color: '#1f2328' },
    '.cm-gutters': { backgroundColor: '#f6f8fa', color: '#8c959f', border: 'none', borderRight: '1px solid #d8dee4' },
    '.cm-activeLine': { backgroundColor: '#f3f6e9' },
    '.cm-activeLineGutter': { backgroundColor: '#e8eed3' },
    '.cm-cursor': { borderLeftColor: '#1f2328' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: '#90ae3a55',
    },
  },
  { dark: false },
);

// Cursor y selección en el verde de acento (oneDark los trae azules). Va antes de oneDark para que prevalezca.
const darkAccent = EditorView.theme(
  {
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#90ae3a' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: 'rgba(144, 174, 58, 0.32)',
    },
  },
  { dark: true },
);

const themeExt = (t) =>
  t === 'dark' ? [darkAccent, oneDark] : [lightTheme, syntaxHighlighting(defaultHighlightStyle, { fallback: true })];

// Solo quien puede editar tiene contenido editable y teclas de deshacer.
const editExt = (allowed) => [
  EditorState.readOnly.of(!allowed),
  EditorView.editable.of(allowed),
  allowed ? keymap.of(yUndoManagerKeymap) : [],
];

const baseTheme = EditorView.theme({
  '&': { fontSize: '14px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: "ui-monospace, 'Cascadia Code', 'JetBrains Mono', Consolas, 'SF Mono', Menlo, monospace",
    lineHeight: '1.6',
  },
  '.cm-content': { padding: '10px 0', minHeight: '3.4em' },
});

const baseExtensions = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  foldGutter(),
  drawSelection(),
  dropCursor(),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  rectangularSelection(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...foldKeymap,
    ...completionKeymap,
    indentWithTab,
  ]),
  baseTheme,
];

/**
 * Todos los bloques comparten una sola presencia (Awareness) y cada editor solo debe
 * ocuparse del cursor que cae en SU texto; si no, al editar un bloque se borraría
 * el cursor que tienes en otro.
 */
function awarenessFor(ytext) {
  const ownsCursor = (cursor) => {
    try {
      const pos = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor.anchor), doc);
      return pos?.type === ytext;
    } catch {
      return false;
    }
  };
  return new Proxy(awareness, {
    get(target, prop) {
      if (prop === 'getLocalState') {
        return () => {
          const s = target.getLocalState();
          return s?.cursor && !ownsCursor(s.cursor) ? { ...s, cursor: null } : s;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const cards = new Map(); // id -> { id, el, view, comps, undoManager, ymap, ytext, language, ui }

function createCard(id, ymap) {
  const ytext = ymap.get('text');
  const undoManager = new Y.UndoManager(ytext);
  const comps = { lang: new Compartment(), edit: new Compartment(), theme: new Compartment() };

  const section = el('section', 'block');
  section.dataset.id = id;

  const num = el('span', 'block-num');
  const langSel = el('select', 'block-lang');
  langSel.title = 'Lenguaje del bloque';
  langSel.setAttribute('aria-label', 'Lenguaje del bloque');
  for (const l of LANGUAGES) langSel.append(new Option(l.label, l.id));
  langSel.onchange = () => ymap.set('lang', langSel.value);

  const copyBtn = el('button', 'btn small copy');
  copyBtn.title = 'Copiar el código de este bloque';
  copyBtn.append(icon('copy'), el('span', 'copy-label', 'Copiar'));
  copyBtn.onclick = () => copyBlock(card);

  const tool = (name, title, onclick, extra = '') => {
    const b = el('button', `btn small ${extra}`);
    b.title = title;
    b.setAttribute('aria-label', title);
    b.append(icon(name));
    b.onclick = onclick;
    return b;
  };
  const upBtn = tool('up', 'Subir bloque', () => moveBlock(id, -1));
  const downBtn = tool('down', 'Bajar bloque', () => moveBlock(id, 1));
  const addBtn = tool('plus', 'Insertar un bloque debajo', () => addBlock(id));
  const delBtn = tool('trash', 'Eliminar bloque', () => deleteBlock(id), 'danger');
  const tools = el('div', 'block-tools edit-only');
  tools.append(upBtn, downBtn, addBtn, delBtn);

  const dot = el('span', 'new-dot');
  dot.title = 'Cambios nuevos';
  dot.setAttribute('role', 'img');
  dot.setAttribute('aria-label', 'Cambios nuevos');

  const head = el('header', 'block-head');
  head.append(dot, num, langSel, el('span', 'spacer'), copyBtn, tools);
  const host = el('div', 'block-editor');
  section.append(head, host);

  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: ytext.toString(),
      extensions: [
        baseExtensions,
        yCollab(ytext, awarenessFor(ytext), { undoManager }),
        comps.lang.of([]),
        comps.edit.of(editExt(canEdit())),
        comps.theme.of(themeExt(state.theme)),
      ],
    }),
  });

  const card = {
    id,
    el: section,
    view,
    comps,
    undoManager,
    ymap,
    ytext,
    language: null,
    isNew: false, // tiene cambios que esta persona aún no ha visto
    visible: false, // está a la vista en el cuaderno
    seenTimer: null,
    ui: { num, langSel, copyBtn, upBtn, downBtn, delBtn },
  };
  cards.set(id, card);
  section.addEventListener('pointerdown', () => card.isNew && noteSeen(card));
  section.addEventListener('focusin', () => card.isNew && noteSeen(card));
  seenObserver.observe(section);
  return card;
}

function destroyCard(card) {
  seenObserver.unobserve(card.el);
  clearTimeout(card.seenTimer);
  card.view.destroy();
  card.undoManager.destroy();
  card.el.remove();
  cards.delete(card.id);
}

async function setCardLanguage(card, lang) {
  card.language = lang;
  const ext = await loadLanguage(lang);
  if (card.language === lang && cards.get(card.id) === card) {
    card.view.dispatch({ effects: card.comps.lang.reconfigure(ext) });
  }
}

function updateCard(card, index, total) {
  const lang = validLang(card.ymap.get('lang'));
  card.ui.num.textContent = String(index + 1);
  card.ui.langSel.value = lang;
  card.ui.langSel.disabled = !canEdit();
  card.ui.upBtn.disabled = index === 0;
  card.ui.downBtn.disabled = index === total - 1;
  card.ui.delBtn.disabled = total === 1;
  card.ui.delBtn.title = total === 1 ? 'No se puede eliminar el único bloque' : 'Eliminar bloque';
  if (card.language !== lang) setCardLanguage(card, lang);
}

function reconfigureEditing(card) {
  const allowed = canEdit();
  card.view.dispatch({ effects: card.comps.edit.reconfigure(editExt(allowed)) });
  if (!allowed) card.undoManager.clear();
}

// ---------- Cambios nuevos (puntito verde) ----------
// Un bloque se marca como nuevo si otra persona lo creó o lo modificó y esta persona no lo vio:
// estaba fuera de pantalla, con la pestaña oculta o sin conexión. Se quita al tocarlo o al verlo unos segundos.
// Lo que ya se vio se recuerda en este navegador, para marcar también lo que cambió mientras no se estaba en la sala.
const SEEN_KEY = `codesala:seen:${roomId}`;
const SEEN_AFTER_MS = 3000;
let seen = {}; // id de bloque -> huella de lo último que se vio
let seenSaveTimer = null;

function blockHash(card) {
  const text = `${validLang(card.ymap.get('lang'))}\0${card.ytext.toString()}`;
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}.${text.length}`;
}

function saveSeen() {
  clearTimeout(seenSaveTimer);
  seenSaveTimer = null;
  store.set(SEEN_KEY, JSON.stringify(seen));
}
window.addEventListener('pagehide', saveSeen);

function noteSeen(card) {
  clearTimeout(card.seenTimer);
  card.isNew = false;
  card.el.classList.remove('is-new');
  seen[card.id] = blockHash(card);
  seenSaveTimer ??= setTimeout(saveSeen, 800);
}

function markNew(card) {
  card.isNew = true;
  card.el.classList.add('is-new');
  watchIfVisible(card);
}

/** Si el bloque nuevo está a la vista, se da por visto tras unos segundos. */
function watchIfVisible(card) {
  clearTimeout(card.seenTimer);
  if (card.isNew && card.visible && document.visibilityState === 'visible') {
    card.seenTimer = setTimeout(() => noteSeen(card), SEEN_AFTER_MS);
  }
}

const seenObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const card = cards.get(entry.target.dataset.id);
      if (!card) continue;
      card.visible = entry.intersectionRatio >= 0.4;
      watchIfVisible(card);
    }
  },
  { root: $('#scroll'), threshold: [0, 0.4] },
);
document.addEventListener('visibilitychange', () => cards.forEach(watchIfVisible));

/** Al abrir la sala: marca lo que cambió desde la última visita. En la primera visita nada es nuevo. */
function initSeen() {
  let previous = null;
  try {
    previous = JSON.parse(store.get(SEEN_KEY) ?? 'null');
  } catch {}
  if (!previous || typeof previous !== 'object') previous = null;
  seen = {};
  for (const card of cards.values()) {
    if (!previous || previous[card.id] === blockHash(card)) noteSeen(card);
    else {
      if (previous[card.id]) seen[card.id] = previous[card.id]; // lo último que vio, por si recarga antes de verlo
      markNew(card);
    }
  }
  saveSeen();
}

/** Revisa quién cambió qué: lo propio y lo que se ve en vivo cuenta como visto; el resto, como nuevo. */
function trackChanges(events, transaction) {
  if (!state.synced) return;
  const ids = new Set();
  for (const e of events) {
    if (e.target === blocksMap) {
      for (const [key, change] of e.keys) if (change.action === 'add') ids.add(key);
    } else if (e.target instanceof Y.Text) ids.add(e.path[0]);
    else if (e.keys?.has('lang')) ids.add(e.path[0]); // los cambios de orden no cuentan
  }
  const watching = !state.catchUp && document.visibilityState === 'visible';
  for (const id of ids) {
    const card = cards.get(id);
    if (!card) continue;
    if (transaction.local || (watching && card.visible)) noteSeen(card);
    else markNew(card);
  }
}

/** Reconcilia las tarjetas con el contenido del documento (altas, bajas y orden). */
function syncBlocks() {
  const entries = blockEntries();
  const ids = new Set(entries.map(([id]) => id));
  for (const card of [...cards.values()]) if (!ids.has(card.id)) destroyCard(card);

  const container = $('#blocks');
  entries.forEach(([id, ymap], i) => {
    const card = cards.get(id) ?? createCard(id, ymap);
    if (container.children[i] !== card.el) container.insertBefore(card.el, container.children[i] ?? null);
    updateCard(card, i, entries.length);
  });

  const empty = $('#blocks-empty');
  empty.hidden = entries.length > 0;
  empty.textContent = state.synced ? 'Esta sala no tiene bloques.' : 'Cargando…';
  $('#btn-add-block').hidden = !state.synced;
  $('#btn-clear').hidden = entries.length === 0;
  $('#sb-blocks').textContent = `${entries.length} ${entries.length === 1 ? 'bloque' : 'bloques'}`;
  if (state.synced) rememberRoom();

  if (pendingFocus && cards.has(pendingFocus)) {
    cards.get(pendingFocus).view.focus();
    pendingFocus = null;
  }
}

// Se ignoran los cambios que solo son texto: cada editor ya se actualiza solo.
blocksMap.observeDeep((events, transaction) => {
  if (events.some((e) => !(e.target instanceof Y.Text))) syncBlocks();
  trackChanges(events, transaction);
});

async function copyBlock(card) {
  const ok = await writeClipboard(card.ytext.toString());
  if (!ok) return toast('No se pudo copiar al portapapeles', 'error');
  const label = card.ui.copyBtn.querySelector('.copy-label');
  card.ui.copyBtn.classList.add('done');
  label.textContent = '¡Copiado!';
  clearTimeout(card.copyTimer);
  card.copyTimer = setTimeout(() => {
    card.ui.copyBtn.classList.remove('done');
    label.textContent = 'Copiar';
  }, 1400);
}

// ---------- Rol y personas ----------
const ROLE_TEXT = { owner: 'Propietario', editor: 'Puedes editar', viewer: 'Lectura' };

function applyRole(role, announce = false) {
  const previous = state.role;
  state.role = role;
  document.body.dataset.role = role;
  for (const card of cards.values()) reconfigureEditing(card);
  syncBlocks();

  // Los estudiantes no publican cursor; al pasar a editor, se publica el actual.
  connection.presence = canEdit();
  if (connection.presence) {
    awareness.setLocalState(awareness.getLocalState() ?? {});
    awareness.setLocalState(awareness.getLocalState());
  }

  const badge = $('#role-badge');
  badge.textContent = ROLE_TEXT[role];
  badge.dataset.role = role;
  $('#sb-role').textContent = ROLE_TEXT[role];
  badge.title = role === 'viewer' ? 'Solo la persona que creó la sala (y quienes ella autorice) puede editar. Puedes copiar cada bloque.' : '';
  $('#btn-request').hidden = canEdit();
  if (canEdit()) state.requested = false;
  renderRequestButton();
  renderRoomName();

  if (announce && previous !== role) {
    if (canEdit()) toast('El propietario te dio permiso para editar', 'ok');
    else toast('Ya no tienes permiso de edición');
  }
}

// ---------- Nombre de la sala ----------
const roomNameInput = $('#room-name');

/** Muestra el nombre en la cabecera y en la pestaña; el propietario puede editarlo, los demás solo lo ven. */
function renderRoomName() {
  const owner = state.role === 'owner';
  if (document.activeElement !== roomNameInput) roomNameInput.value = state.roomName;
  roomNameInput.readOnly = !owner;
  roomNameInput.hidden = !owner && !state.roomName; // sin nombre, solo se ve el código
  roomNameInput.title = owner ? 'Haz clic para cambiar el nombre de la sala' : '';
  document.title = `${state.roomName || `Sala ${roomId}`} | UN Code Sala`;
}

/**
 * Guarda el nombre y el lenguaje en la lista «Mis salas» de la portada (solo en el navegador del propietario).
 * El lenguaje es el del primer bloque, no el elegido al crear la sala.
 */
function rememberRoom() {
  if (state.role !== 'owner') return;
  try {
    const list = JSON.parse(store.get('codesala:mine') || '[]');
    let entry = list.find((r) => r.id === roomId);
    if (!entry) list.unshift((entry = { id: roomId, createdAt: Date.now() }));
    entry.name = state.roomName;
    if (state.synced) {
      const first = blockEntries()[0];
      entry.language = first ? validLang(first[1].get('lang')) : null;
    }
    store.set('codesala:mine', JSON.stringify(list.slice(0, 20)));
  } catch {}
}

/** La sala ya no existe: se quita de «Mis salas». */
function forgetRoom() {
  try {
    store.set('codesala:mine', JSON.stringify(JSON.parse(store.get('codesala:mine') || '[]').filter((r) => r.id !== roomId)));
  } catch {}
}

function applyRoomName(name) {
  state.roomName = name ?? '';
  renderRoomName();
  rememberRoom();
}

roomNameInput.onchange = () => {
  const name = roomNameInput.value.replace(/\s+/g, ' ').trim().slice(0, 60);
  roomNameInput.value = name;
  if (name !== state.roomName) connection.sendJson({ t: 'room-name', name });
};
roomNameInput.onkeydown = (e) => {
  if (e.key === 'Enter') roomNameInput.blur();
  else if (e.key === 'Escape') {
    roomNameInput.value = state.roomName;
    roomNameInput.blur();
  }
};

function renderRequestButton() {
  $('#btn-request').textContent = state.requested ? 'Solicitud enviada (cancelar)' : 'Solicitar rol de edición';
}

function renderMembers() {
  const ul = $('#members');
  ul.replaceChildren();
  const isOwner = state.role === 'owner';
  for (const m of state.members) {
    const li = el('li', `member ${m.online ? 'on' : 'off'}`);

    const dot = el('span', 'dot');
    dot.style.background = m.online ? m.color : 'transparent';
    dot.style.borderColor = m.color;

    const info = el('div', 'member-info');
    const tag = el('span', `tag ${m.role}`, m.requesting ? 'Pide editar' : ROLE_TEXT[m.role]);
    if (m.requesting) tag.classList.add('requesting');
    info.append(el('span', 'member-name', m.name + (m.uid === state.uid ? ' (tú)' : '')), tag);
    li.append(dot, info);

    if (isOwner && m.role !== 'owner') {
      const actions = el('div', 'member-actions');
      const act = (label, type, cls = '') => {
        const b = el('button', `btn small ${cls}`, label);
        b.onclick = () => connection.sendJson({ t: type, uid: m.uid });
        actions.append(b);
      };
      if (m.role === 'editor') act('Quitar permiso', 'revoke');
      else if (m.online) act(m.requesting ? 'Permitir' : 'Dar permiso', 'grant', 'primary');
      if (m.requesting) act('Ignorar', 'dismiss');
      li.append(actions);
    }
    ul.append(li);
  }
  // El servidor solo envía a los estudiantes al propietario, los editores y a ellos mismos.
  const listed = state.members.filter((m) => m.online).length;
  const hidden = Math.max(0, state.total - listed);
  if (hidden > 0) ul.append(el('li', 'member-more', `y ${hidden} ${hidden === 1 ? 'persona más' : 'personas más'} viendo`));
  $('#people-count').textContent = Math.max(state.total, listed);
}

function applyMembers(members, total = members.filter((m) => m.online).length) {
  state.total = total;
  if (state.role === 'owner') {
    const before = new Set(state.members.filter((m) => m.requesting).map((m) => m.uid));
    for (const m of members) {
      if (m.requesting && !before.has(m.uid)) toast(`${m.name} pide permiso para editar`);
    }
  }
  state.members = members;
  renderMembers();
}

// ---------- Conexión ----------
const STATUS_TEXT = { connecting: 'Conectando…', online: 'Conectado', offline: 'Sin conexión, reintentando…' };

const connection = new RoomConnection({
  roomId,
  userKey,
  ownerToken,
  getName: () => myName,
  doc,
  awareness,
  handlers: {
    status(s) {
      if (s === 'offline' && state.synced) state.catchUp = true;
      const pill = $('#status');
      pill.dataset.state = s;
      pill.textContent = STATUS_TEXT[s];
    },
    synced() {
      if (state.synced) {
        state.catchUp = false; // ya llegó lo ocurrido durante la desconexión
        return;
      }
      state.synced = true;
      syncBlocks();
      initSeen();
    },
    message(msg) {
      switch (msg.t) {
        case 'welcome':
          state.uid = msg.uid;
          state.requested = false; // el servidor olvida las solicitudes al desconectarnos
          applyRole(msg.role);
          applyRoomName(msg.name);
          applyMembers(msg.members, msg.total);
          break;
        case 'room':
          applyRoomName(msg.name);
          break;
        case 'role':
          applyRole(msg.role, true);
          renderMembers();
          break;
        case 'members':
          applyMembers(msg.members, msg.total);
          break;
        case 'error':
          if (msg.code === 'not-found') showOverlay('Sala no encontrada', 'La sala no existe o ya expiró.');
          else if (msg.code === 'deleted') {
            showOverlay('Sala eliminada', 'El propietario eliminó esta sala.');
            forgetRoom();
          } else if (msg.code === 'full') showOverlay('Sala llena', 'Esta sala alcanzó el máximo de conexiones.');
          else if (msg.code === 'forbidden') toast('Solo el propietario puede hacer eso', 'error');
          break;
      }
    },
  },
});

// ---------- Eventos de la interfaz ----------
$('#room-code').textContent = roomId;
renderRoomName();

/** Nombre de archivo para las descargas: el nombre de la sala si lo tiene, o su código. */
function downloadBase() {
  const slug = state.roomName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || `un-code-sala-${roomId}`;
}

$('#btn-add-block').onclick = () => addBlock();
$('#btn-clear').onclick = clearBlocks;

$('#btn-link').onclick = () => copyWithToast(`${location.origin}/r/${roomId}`, 'Enlace copiado (los invitados entran en solo lectura)');

const allBlocks = () => blockEntries().map(([, m]) => ({ lang: validLang(m.get('lang')), text: m.get('text').toString() }));

$('#btn-copy-all').onclick = () => {
  if (!blockEntries().length) return toast('No hay bloques para copiar');
  copyWithToast(allBlocks().map((b) => b.text).join('\n\n'), 'Todos los bloques copiados');
};

$('#btn-download').onclick = () => {
  const blocks = allBlocks();
  if (!blocks.length) return;
  let content;
  let name;
  if (blocks.length === 1) {
    const ext = LANGUAGES.find((l) => l.id === blocks[0].lang)?.ext ?? 'txt';
    content = blocks[0].text;
    name = ext === 'Dockerfile' ? 'Dockerfile' : `${downloadBase()}.${ext}`;
  } else {
    // Con varios bloques (posiblemente de lenguajes distintos), Markdown conserva cada uno.
    content =
      blocks
        .map((b) => `\`\`\`${b.lang === DEFAULT_LANGUAGE ? '' : b.lang}\n${b.text.replace(/\n$/, '')}\n\`\`\``)
        .join('\n\n') + '\n';
    name = `${downloadBase()}.md`;
  }
  const a = el('a');
  a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// Código QR con el enlace de invitados (solo lectura), para proyectarlo en clase.
// Nunca incluye el token de propietario: es el mismo enlace que copia «Copiar enlace».
const qrOverlay = $('#qr-overlay');
function toggleQr(open) {
  qrOverlay.hidden = !open;
  if (!open) return;
  const url = `${location.origin}/r/${roomId}`;
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  $('#qr-box').innerHTML = qr.createSvgTag({ cellSize: 4, scalable: true, alt: 'Código QR con el enlace de la sala' });
  $('#qr-title').textContent = state.roomName || 'Entrar a la sala';
  $('#qr-url').textContent = url;
  $('#btn-qr-close').focus();
}
$('#btn-qr').onclick = () => toggleQr(true);
$('#btn-qr-close').onclick = () => toggleQr(false);
qrOverlay.onclick = (e) => {
  if (e.target === qrOverlay) toggleQr(false);
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !qrOverlay.hidden) toggleQr(false);
});

const people = $('#people');
const togglePeople = (open = people.hidden) => {
  people.hidden = !open;
  $('#btn-people').setAttribute('aria-expanded', String(open));
};
$('#btn-people').onclick = () => togglePeople();
$('#btn-people-close').onclick = () => togglePeople(false);

const nameInput = $('#name-input');
nameInput.value = myName;
nameInput.onchange = () => {
  myName = nameInput.value.trim().slice(0, 24) || myName;
  nameInput.value = myName;
  store.set('codesala:name', myName);
  connection.sendJson({ t: 'name', name: myName });
};

$('#btn-request').onclick = () => {
  state.requested = !state.requested;
  connection.sendJson({ t: 'request', on: state.requested });
  renderRequestButton();
  toast(state.requested ? 'Solicitud enviada al propietario' : 'Solicitud cancelada');
};

$('#btn-owner-link').onclick = () => {
  const token = store.get(`codesala:owner:${roomId}`);
  if (token) copyWithToast(`${location.origin}/r/${roomId}#owner=${token}`, 'Enlace de propietario copiado. Guárdalo en un lugar privado');
};

function setTheme(t) {
  state.theme = t;
  document.documentElement.dataset.theme = t;
  store.set('codesala:theme', t);
  $('#btn-theme use').setAttribute('href', t === 'dark' ? '#i-sun' : '#i-moon');
  for (const card of cards.values()) card.view.dispatch({ effects: card.comps.theme.reconfigure(themeExt(t)) });
}
$('#btn-theme').onclick = () => setTheme(state.theme === 'dark' ? 'light' : 'dark');
setTheme(state.theme);

syncBlocks();
connection.connect();
