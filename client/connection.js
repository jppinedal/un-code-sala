import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

/**
 * Conexión WebSocket a una sala: sincroniza el documento Yjs y la presencia,
 * y entrega los mensajes de control (rol, miembros) a `handlers`.
 * Se reconecta sola; las ediciones hechas sin conexión se fusionan al volver.
 */
export class RoomConnection {
  constructor({ roomId, userKey, ownerToken, getName, doc, awareness, handlers }) {
    Object.assign(this, { roomId, userKey, ownerToken, getName, doc, awareness, handlers });
    this.ws = null;
    this.ready = false; // true tras recibir "welcome"
    this.presence = false; // solo quien puede editar publica su cursor (lo fija room.js según el rol)
    this.retries = 0;
    this.closed = false;
    this.retryTimer = null;

    this.onDocUpdate = (update, origin) => {
      if (origin === this || !this.ready) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.sendBinary(enc);
    };
    this.onAwarenessUpdate = ({ added, updated, removed }) => {
      const mine = this.doc.clientID;
      if (!this.ready || !this.presence || ![...added, ...updated, ...removed].includes(mine)) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [mine]));
      this.sendBinary(enc);
    };
    doc.on('update', this.onDocUpdate);
    awareness.on('update', this.onAwarenessUpdate);
    window.addEventListener('online', () => this.connectNow());
    window.addEventListener('beforeunload', () =>
      awarenessProtocol.removeAwarenessStates(awareness, [doc.clientID], 'unload'),
    );
  }

  connect() {
    if (this.closed || (this.ws && this.ws.readyState <= 1)) return;
    clearTimeout(this.retryTimer);
    this.handlers.status('connecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws?room=${encodeURIComponent(this.roomId)}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () =>
      this.sendJson({ t: 'hello', key: this.userKey, owner: this.ownerToken, name: this.getName() });
    ws.onmessage = (ev) => {
      try {
        if (typeof ev.data === 'string') this.onJson(JSON.parse(ev.data));
        else this.onBinary(new Uint8Array(ev.data));
      } catch (err) {
        console.error('Mensaje inválido', err);
      }
    };
    ws.onclose = (ev) => {
      this.ready = false;
      this.handlers.status('offline');
      // Los cursores remotos ya no son fiables sin conexión.
      const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
      awarenessProtocol.removeAwarenessStates(this.awareness, others, this);
      if (this.closed || ev.code === 4404 || ev.code === 4410) return; // sala inexistente o eliminada: no reintentar
      this.retryTimer = setTimeout(() => this.connect(), Math.min(10_000, 500 * 2 ** this.retries++));
    };
  }

  connectNow() {
    if (this.ws && this.ws.readyState <= 1) return;
    this.retries = 0;
    this.connect();
  }

  onJson(msg) {
    if (msg.t === 'welcome') {
      this.ready = true;
      this.retries = 0;
      this.handlers.status('online');
      // Pide el estado del documento y publica la presencia propia. El servidor
      // incrementa el reloj de presencia al desconectarnos, así que lo subimos dos veces.
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeSyncStep1(enc, this.doc);
      this.sendBinary(enc);
      this.awareness.setLocalState(this.awareness.getLocalState() ?? {});
      this.awareness.setLocalState(this.awareness.getLocalState());
    }
    this.handlers.message(msg);
  }

  onBinary(data) {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MSG_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      const syncType = syncProtocol.readSyncMessage(decoder, enc, this.doc, this);
      if (encoding.length(enc) > 1) this.sendBinary(enc);
      if (syncType === syncProtocol.messageYjsSyncStep2) this.handlers.synced?.();
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
    }
  }

  sendJson(obj) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  sendBinary(enc) {
    if (this.ws?.readyState === 1) this.ws.send(encoding.toUint8Array(enc));
  }
}
