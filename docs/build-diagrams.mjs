// Genera docs/un-code-sala.drawio (varias páginas) y docs/flujos.md (los mismos flujos en Mermaid).
// Uso: node docs/build-diagrams.mjs
// Las páginas de arquitectura y despliegue están en docs/src/*.xml; los flujos se describen aquí.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const readSrc = (name) => fs.readFileSync(path.join(here, 'src', name), 'utf8').trim();

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function wrap(text, width) {
  const lines = [];
  let cur = '';
  for (const word of text.split(' ')) {
    if (cur && (cur + ' ' + word).length > width) {
      lines.push(cur);
      cur = word;
    } else cur = cur ? cur + ' ' + word : word;
  }
  if (cur) lines.push(cur);
  return lines;
}
const html = (lines) => esc(lines.join('<br>'));

// ---------- Descripción de los flujos ----------
// Participantes: [id, texto, 'actor' opcional]. Pasos: [de, a, texto, 'reply' opcional] o ['note', [ids], texto].
const FLOWS = [
  {
    id: 'f1',
    page: '2. Flujo: crear sala y entrar',
    title: 'Flujo 1 · Crear una sala y entrar',
    participants: [['P', 'Profesor (navegador)', 'actor'], ['S', 'Servidor Node'], ['D', 'Disco /home/data']],
    steps: [
      ['P', 'S', 'POST /api/rooms con el lenguaje elegido'],
      ['S', 'S', 'Genera un id y un token de propietario aleatorios'],
      ['S', 'D', 'Guarda {id}.json con el hash SHA-256 del token y 1 bloque'],
      ['S', 'P', '201 con id y ownerToken', 'reply'],
      ['P', 'P', 'Guarda ownerToken en localStorage y abre /r/{id}'],
      ['P', 'S', 'WebSocket /ws con hello (clave privada, token, nombre)'],
      ['S', 'S', 'Compara el hash del token en tiempo constante'],
      ['S', 'P', 'welcome con el rol y la lista de personas', 'reply'],
      ['P', 'S', 'sync Yjs paso 1, pide el documento'],
      ['S', 'P', 'sync Yjs paso 2, documento con sus bloques', 'reply'],
      ['note', ['P', 'S'], 'Un invitado abre el mismo enlace sin token y entra como solo lectura'],
    ],
  },
  {
    id: 'f2',
    page: '3. Flujo: edición en tiempo real',
    title: 'Flujo 2 · Edición en tiempo real',
    participants: [['P', 'Profesor (propietario)', 'actor'], ['S', 'Servidor Node'], ['D', 'Disco /home/data'], ['E', 'Estudiantes (solo lectura)', 'actor']],
    steps: [
      ['P', 'S', 'update Yjs con texto, bloque nuevo, borrado o lenguaje'],
      ['S', 'S', 'Comprueba que sea propietario o editor y aplica el cambio'],
      ['S', 'E', 'Reenvía el update a todos menos a quien lo envió', 'reply'],
      ['S', 'D', 'Guarda el archivo 1,5 s después del último cambio'],
      ['E', 'S', 'update manipulado desde la consola del navegador'],
      ['S', 'S', 'No tiene permiso, descarta el mensaje sin aplicarlo'],
      ['note', ['P', 'E'], 'Medido con 200 estudiantes, el cambio llega en 13 ms o menos (p95) y no se pierde ninguno'],
    ],
  },
  {
    id: 'f3',
    page: '4. Flujo: permisos',
    title: 'Flujo 3 · Pedir, dar y quitar permiso de edición',
    participants: [['E', 'Estudiante', 'actor'], ['S', 'Servidor Node'], ['P', 'Profesor (propietario)', 'actor']],
    steps: [
      ['E', 'S', 'request, pide permiso para editar'],
      ['S', 'P', 'Lista de personas con «pide editar»', 'reply'],
      ['P', 'S', 'grant, da permiso a ese estudiante'],
      ['S', 'S', 'Guarda el permiso por identificador de navegador'],
      ['S', 'E', 'role editor, la sala pasa a ser editable', 'reply'],
      ['S', 'P', 'Lista de personas actualizada', 'reply'],
      ['P', 'S', 'revoke, quita el permiso'],
      ['S', 'E', 'role viewer, vuelve a solo lectura y se retira su cursor', 'reply'],
      ['note', ['E', 'P'], 'Solo el propietario puede dar o quitar permisos, el servidor rechaza esas órdenes de cualquier otra persona'],
    ],
  },
  {
    id: 'f4',
    page: '5. Flujo: clase de 200 personas',
    title: 'Flujo 4 · Entrada de una clase de 200 personas',
    participants: [['E', 'Estudiantes (200)', 'actor'], ['S', 'Servidor Node'], ['P', 'Profesor (propietario)', 'actor']],
    steps: [
      ['E', 'S', 'Abren el enlace y envían hello por WebSocket'],
      ['S', 'S', 'Agrupa los avisos de entrada durante 150 ms'],
      ['S', 'P', 'Lista completa de personas, con permisos y solicitudes', 'reply'],
      ['S', 'E', 'Lista reducida con propietario, editores, el propio estudiante y el total', 'reply'],
      ['note', ['E', 'P'], 'Antes de este diseño cada estudiante recibía 1,9 MB al entrar, ahora recibe 0,8 KB'],
    ],
  },
];

// ---------- XML de draw.io para un diagrama de secuencia ----------
const COLORS = [['#dae8fc', '#6c8ebf'], ['#d5e8d4', '#82b366'], ['#f5f5f5', '#666666'], ['#fff2cc', '#d6b656']];

function seqXml(f) {
  const colW = 380;
  const x0 = 30;
  const top = 56;
  const headH = 44;
  const cx = (i) => x0 + i * colW + 90;
  const idx = Object.fromEntries(f.participants.map((p, i) => [p[0], i]));
  const msgs = [];
  let y = top + headH + 24;
  let n = 0;

  for (const step of f.steps) {
    if (step[0] === 'note') {
      const [, ids, text] = step;
      const a = Math.min(...ids.map((id) => idx[id]));
      const b = Math.max(...ids.map((id) => idx[id]));
      const w = cx(b) - cx(a) + 220;
      const lines = wrap(text, Math.floor(w / 7));
      const h = 22 + lines.length * 16;
      msgs.push(
        `<mxCell id="${f.id}_note${y}" value="${html(lines)}" style="shape=note;whiteSpace=wrap;html=1;size=12;fillColor=#fff2cc;strokeColor=#d6b656;align=center;" vertex="1" parent="1"><mxGeometry x="${cx(a) - 110}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`,
      );
      y += h + 22;
      continue;
    }
    const [from, to, text, kind] = step;
    n += 1;
    const label = wrap(`${n}. ${text}`, 48);
    const ya = y + label.length * 16 + 8;
    const dash = kind === 'reply' ? 'dashed=1;' : '';
    if (from === to) {
      const x = cx(idx[from]);
      msgs.push(
        `<mxCell id="${f.id}_m${n}" value="" style="html=1;endArrow=block;endSize=8;strokeWidth=1.5;rounded=0;" edge="1" parent="1"><mxGeometry relative="1" as="geometry"><mxPoint x="${x}" y="${ya}" as="sourcePoint"/><mxPoint x="${x}" y="${ya + 26}" as="targetPoint"/><Array as="points"><mxPoint x="${x + 46}" y="${ya}"/><mxPoint x="${x + 46}" y="${ya + 26}"/></Array></mxGeometry></mxCell>`,
        `<mxCell id="${f.id}_t${n}" value="${html(label)}" style="text;html=1;whiteSpace=wrap;align=left;verticalAlign=top;" vertex="1" parent="1"><mxGeometry x="${x + 56}" y="${ya - 4}" width="${colW - 80}" height="${label.length * 16 + 4}" as="geometry"/></mxCell>`,
      );
      y = ya + 26 + 20;
    } else {
      msgs.push(
        `<mxCell id="${f.id}_m${n}" value="${html(label)}" style="html=1;verticalAlign=bottom;endArrow=block;endSize=8;strokeWidth=1.5;${dash}" edge="1" parent="1"><mxGeometry relative="1" as="geometry"><mxPoint x="${cx(idx[from])}" y="${ya}" as="sourcePoint"/><mxPoint x="${cx(idx[to])}" y="${ya}" as="targetPoint"/></mxGeometry></mxCell>`,
      );
      y = ya + 22;
    }
  }

  const lifeH = y + 10 - top;
  const lifelines = f.participants.map(([id, label], i) => {
    const [fill, stroke] = COLORS[i % COLORS.length];
    return `<mxCell id="${f.id}_L${id}" value="${esc(label)}" style="shape=umlLifeline;perimeter=lifelinePerimeter;whiteSpace=wrap;html=1;container=0;dropTarget=0;collapsible=0;recursiveResize=0;outlineConnect=0;portConstraint=eastwest;size=${headH};fillColor=${fill};strokeColor=${stroke};fontStyle=1;" vertex="1" parent="1"><mxGeometry x="${cx(i) - 90}" y="${top}" width="180" height="${lifeH}" as="geometry"/></mxCell>`;
  });
  const title = `<mxCell id="${f.id}_title" value="${esc(`<b>UN Code Sala</b> · ${f.title}`)}" style="text;html=1;fontSize=20;align=left;verticalAlign=middle;" vertex="1" parent="1"><mxGeometry x="20" y="0" width="900" height="34" as="geometry"/></mxCell>`;
  return `<mxGraphModel adaptiveColors="auto"><root><mxCell id="0"/><mxCell id="1" parent="0"/>\n${[title, ...lifelines, ...msgs].join('\n')}\n</root></mxGraphModel>`;
}

// ---------- Mermaid del mismo flujo ----------
function mermaid(f) {
  const out = ['sequenceDiagram', '  autonumber'];
  for (const [id, label, kind] of f.participants) out.push(`  ${kind === 'actor' ? 'actor' : 'participant'} ${id} as ${label}`);
  for (const step of f.steps) {
    if (step[0] === 'note') out.push(`  Note over ${step[1].join(',')}: ${step[2]}`);
    else out.push(`  ${step[0]}${step[3] === 'reply' ? '-->>' : '->>'}${step[1]}: ${step[2]}`);
  }
  return out.join('\n');
}

// ---------- Archivo .drawio con todas las páginas ----------
const pages = [
  ['1. Arquitectura', readSrc('01-arquitectura.xml')],
  ...FLOWS.map((f) => [f.page, seqXml(f)]),
  ['6. Despliegue en Azure', readSrc('05-despliegue.xml')],
];
const file = `<mxfile host="app.diagrams.net" agent="UN Code Sala" version="24.7.0">\n${pages
  .map(([name, xml], i) => `<diagram id="page${i + 1}" name="${esc(name)}">${xml}</diagram>`)
  .join('\n')}\n</mxfile>\n`;
fs.writeFileSync(path.join(here, 'un-code-sala.drawio'), file);

fs.writeFileSync(
  path.join(here, 'flujos.md'),
  FLOWS.map((f) => `## ${f.title}\n\n\`\`\`mermaid\n${mermaid(f)}\n\`\`\`\n`).join('\n'),
);
console.log(`docs/un-code-sala.drawio: ${pages.length} páginas, ${(file.length / 1024).toFixed(1)} KB`);
console.log('docs/flujos.md: ' + FLOWS.length + ' flujos en Mermaid');
