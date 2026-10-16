# UN Code Sala

Salas de código en tiempo real, al estilo de [CodeShare](https://codeshare.io), pero **solo quien crea la sala puede editar** o decidir quién más puede hacerlo. Todos los demás ven los cambios al instante, en solo lectura. Pensada para que un profesor muestre código a una clase de hasta 200 personas.

## Características

- Cuaderno de **bloques de código** (hasta 30), cada uno con su lenguaje y su botón **Copiar**.
- 34 lenguajes con resaltado: JavaScript, TypeScript, Python, Java, C, C++, C#, Go, Rust, PHP, SQL, HTML, CSS, Bash y más ([lista](shared/languages.js)).
- Nombre de sala editable por el propietario y **código QR** para entrar desde el celular.
- Permisos por sala: propietario, editores y espectadores. Un espectador puede **pedir permiso** y el propietario lo concede o lo quita al instante.
- Descargar los bloques, tema claro u oscuro, sin cuentas ni registro.

## Inicio rápido

Requiere Node.js 20.14 o superior.

```bash
npm install    # instala dependencias y compila el cliente
npm start      # http://localhost:3000
```

1. En la portada elige un nombre (opcional) y un lenguaje, y pulsa **Crear sala**. Quedas como propietario.
2. **Copiar enlace** para invitar en solo lectura, o muestra el **QR**. Nunca incluyen el acceso de propietario.
3. Guarda el **enlace de propietario** (*Personas → Copiar enlace de propietario*). El control vive en tu navegador: sin ese enlace lo pierdes si borras sus datos o cambias de equipo.

## Cómo se garantiza que solo el propietario edita

La regla se aplica **en el servidor**, no en la interfaz.

- Al crear la sala se genera un token de propietario aleatorio; el servidor guarda solo su hash SHA-256 y lo compara en tiempo constante. El enlace de propietario lo lleva en el `#fragmento`, que nunca viaja al servidor.
- Cada navegador tiene una clave privada de la que el servidor deriva un `uid` público. Los permisos se guardan por `uid` y sobreviven a recargas.
- La sala es un documento [Yjs](https://yjs.dev). Los mensajes de escritura (`step2`, `update`) de quien no puede editar se descartan, sea texto, un bloque nuevo, un borrado o un cambio de lenguaje.
- Conceder o quitar permisos, y renombrar la sala, solo lo acepta el servidor si vienen del propietario.

Las [pruebas](test/permissions.test.mjs) cubren estos casos, incluido un visitante que manipula su copia local y la envía:

```bash
npm test
```

## Configuración

Variables de entorno opcionales:

| Variable | Por defecto | Descripción |
| --- | --- | --- |
| `PORT` | `3000` | Puerto HTTP |
| `HOST` | `0.0.0.0` | Interfaz de escucha |
| `DATA_DIR` | `./data` | Dónde se guardan las salas (un JSON por sala) |
| `ROOM_TTL_DAYS` | `30` | Las salas sin ediciones durante estos días se borran |
| `MAX_CONNS_PER_ROOM` | `500` | Máximo de personas conectadas a la vez en una sala |
| `TRUST_PROXY` | ninguno | `1` detrás de un proxy inverso, para limitar la creación de salas por IP |

Detrás de un proxy hay que reenviar las cabeceras de WebSocket en `/ws` y servir por HTTPS.

## Capacidad

Medido con [`scripts/loadtest.mjs`](scripts/loadtest.mjs) (un profesor escribiendo 10 cambios por segundo y estudiantes entrando a la vez):

| | 200 estudiantes (local) | 200 estudiantes (Azure B1) |
| --- | --- | --- |
| Conexiones logradas | 200 de 200 | 200 de 200 |
| Cambios perdidos | 0 | 0 |
| Latencia profesor a estudiantes (p95) | 13 ms | 269 a 383 ms |
| Tráfico por estudiante en clase | 0,24 KB/s | 0,24 KB/s |

```bash
npm run loadtest -- --url http://127.0.0.1:3000 --viewers 200
```

No cubre navegadores reales, redes móviles lentas ni muchos estudiantes detrás de una misma IP.

## Despliegue

Necesita un servidor Node con WebSockets y **una sola instancia**, porque las salas viven en memoria; GitHub Pages no sirve. La guía para Azure App Service está en [`deploy/AZURE.md`](deploy/AZURE.md):

```powershell
.\deploy\azure.ps1 -AppName <nombre> -Location <región>   # crea plan y app, y publica
.\deploy\publicar.ps1                                       # volver a publicar
.\deploy\clase.ps1 -Modo subir                              # plan B1 para la clase
.\deploy\clase.ps1 -Modo bajar                              # vuelve a F1 gratuito
```

En Azure for Students (sin tarjeta) el plan F1 es gratis pero solo admite unas 3 conexiones simultáneas; con B1 (~0,017 USD por hora) se cubre una clase y se vuelve a F1 al terminar.

## Estructura

```
server/    Servidor HTTP + WebSocket y lógica de salas, permisos y persistencia
client/    Editor (CodeMirror 6 + Yjs), conexión en tiempo real y portada
public/    HTML, CSS y recursos estáticos
shared/    Lista de lenguajes compartida
test/      Pruebas de permisos
scripts/   Prueba de carga
deploy/    Scripts y guía de Azure App Service
docs/      Diagramas (un-code-sala.drawio) y flujos en Mermaid
```

Desarrollo del cliente con recompilación automática: `node build.mjs --watch`.

## Límites conocidos

- Un editor autorizado puede borrar todo el contenido; no hay historial de versiones.
- Las salas se guardan en disco sin cifrar y cualquiera con el enlace puede leerlas: no pegues secretos.

---

Juan Pablo Pineda, 2026
