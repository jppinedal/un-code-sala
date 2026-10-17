import { LANGUAGES } from '../shared/languages.js';

const $ = (sel) => document.querySelector(sel);

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
  remove: (k) => {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};

const select = $('#lang');
for (const l of LANGUAGES) select.append(new Option(l.label, l.id));
select.value = store.get('codesala:lang') || 'javascript';

function mineRooms() {
  try {
    return JSON.parse(store.get('codesala:mine') || '[]');
  } catch {
    return [];
  }
}

function trashIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ico');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-trash');
  svg.append(use);
  return svg;
}

/** Elimina la sala en el servidor (con el token de propietario) y la quita de la lista. */
async function deleteRoom(room, btn) {
  const err = $('#error');
  err.hidden = true;
  btn.disabled = true;
  try {
    const token = store.get(`codesala:owner:${room.id}`);
    if (token) {
      const res = await fetch(`/api/rooms/${room.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
      if (!res.ok && res.status !== 404) throw new Error(await res.text());
    }
    store.remove(`codesala:owner:${room.id}`);
    store.set('codesala:mine', JSON.stringify(mineRooms().filter((r) => r.id !== room.id)));
    renderMine();
  } catch (ex) {
    err.textContent = `No se pudo eliminar la sala: ${ex.message}`;
    err.hidden = false;
    btn.disabled = false;
  }
}

function renderMine() {
  const rooms = mineRooms();
  $('#mine').hidden = rooms.length === 0;
  const ul = $('#mine-list');
  ul.replaceChildren();
  for (const r of rooms) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `/r/${r.id}`;
    a.textContent = r.name || r.id;
    const meta = document.createElement('span');
    // El lenguaje es el del primer bloque (la sala lo actualiza al abrirla), no el elegido al crearla.
    const lang = LANGUAGES.find((l) => l.id === r.language)?.label;
    meta.textContent = [r.name ? r.id : null, lang, new Date(r.createdAt).toLocaleDateString('es')].filter(Boolean).join(' · ');
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'mine-del';
    del.title = 'Eliminar sala';
    del.setAttribute('aria-label', `Eliminar la sala ${r.name || r.id}`);
    del.append(trashIcon());
    del.onclick = () => deleteRoom(r, del);
    const side = document.createElement('div');
    side.className = 'mine-side';
    side.append(meta, del);
    li.append(a, side);
    ul.append(li);
  }
}
renderMine();

$('#create-form').onsubmit = async (e) => {
  e.preventDefault();
  const btn = $('#create-btn');
  const err = $('#error');
  err.hidden = true;
  btn.disabled = true;
  try {
    const language = select.value;
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language, name: $('#room-name').value }),
    });
    if (!res.ok) throw new Error(await res.text());
    const { id, ownerToken, name } = await res.json();
    store.set(`codesala:owner:${id}`, ownerToken);
    store.set('codesala:lang', language);
    store.set('codesala:mine', JSON.stringify([{ id, name, language, createdAt: Date.now() }, ...mineRooms()].slice(0, 20)));
    location.href = `/r/${id}`;
  } catch (ex) {
    err.textContent = `No se pudo crear la sala: ${ex.message}`;
    err.hidden = false;
    btn.disabled = false;
  }
};

$('#join-form').onsubmit = (e) => {
  e.preventDefault();
  const raw = $('#join-input').value.trim();
  const id = raw.match(/\/r\/([a-z0-9]+)/i)?.[1] ?? raw.match(/^[a-z0-9]{6,16}$/i)?.[0];
  if (id) location.href = `/r/${id.toLowerCase()}`;
  else $('#join-input').setCustomValidity('Escribe un enlace o código de sala válido'), $('#join-input').reportValidity();
};
$('#join-input').oninput = (e) => e.target.setCustomValidity('');
