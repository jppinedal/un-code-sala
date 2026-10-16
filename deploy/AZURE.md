# Desplegar en Azure for Students sin sorpresas de costo

## Qué te protege y qué no

- Una suscripción **Azure for Students** no tiene tarjeta asociada. Cuando el crédito (100 USD) se agota o pasan 12 meses, Azure **deshabilita la suscripción** en lugar de cobrarte ([Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/5924367/azure-student-account-credit-expired)).
- Lo único que te expone a cobros reales es **pasar la suscripción a pago por uso** o agregar una tarjeta. No lo hagas mientras esto esté desplegado.
- Un presupuesto en Cost Management **solo avisa**, no corta el gasto, y los datos de costo llegan con 8 a 24 horas de retraso. El freno real es no tener tarjeta.

## Cuánto cuesta

Se crean solo dos recursos: un plan de App Service **B1 Linux** (1 núcleo, 1,75 GB) con una instancia, y la app web.

- El portal estimó **12,41 USD al mes** para B1 en East US (otras fuentes citan 13,14 USD; confírmalo en la [calculadora de Azure](https://azure.microsoft.com/pricing/calculator/)).
- Encendido todo el tiempo, 100 USD duran unos **8 meses**. Un semestre de 5 meses cuesta unos 62 USD.
- **Para gastar casi nada:** el plan se factura por hora, así que puedes dejarlo en el nivel gratuito F1 y subirlo a B1 solo durante la clase (ver «Pagar solo las horas de clase»).
- B1 no admite autoescalado, así que no puede crecer sola. Siempre encendida (*Always On*) no tiene cargo extra.
- El tráfico es mínimo: cada estudiante descarga unos 0,6 MB al entrar (medido, sin compresión) y luego unos 0,24 KB/s.
- **No se crea** nada más: ni registro de contenedores, ni base de datos, ni cuenta de almacenamiento, ni Application Insights. Si usas el asistente del portal en lugar del script, desmarca Application Insights.

Para dejar de gastar: `az group delete -n codesala-rg --yes` borra todo. Detener la app **no** detiene el cobro del plan; hay que borrar el plan o el grupo.

## Pagar solo las horas de clase

El plan de App Service se factura **por hora, prorrateado al segundo**, según su nivel, y el nivel gratuito F1 no cobra (según varias guías; confírmalo en la [calculadora de Azure](https://azure.microsoft.com/pricing/calculator/)). F1 no aguanta una clase (unos 5 WebSockets y 60 minutos de CPU al día), pero sirve para dejar la app aparcada:

```powershell
.\deploy\clase.ps1 -Modo subir    # antes de la clase: pasa a B1
.\deploy\clase.ps1 -Modo bajar    # al terminar: vuelve a F1, sin cobro
```

- Con B1 a ~0,017 USD por hora, dos clases de 2 horas a la semana cuestan **menos de 0,40 USD al mes**.
- Las salas se guardan en `/home/data` y **sobreviven al cambio de nivel** (comprobado: las salas creadas antes de bajar seguían ahí en F1).
- **La dirección no cambia** al bajar ni al subir (comprobado).
- **En F1 la app abre, pero solo admite unas 3 conexiones simultáneas**: de 10 estudiantes entraron 2 y el resto recibió un 429. Sirve para dejarla aparcada, no para una clase.
- **No olvides bajar el plan**: si se queda en B1 se factura ~12 USD al mes. El presupuesto de aviso te alerta si pasa.
- Bajar tardó unos 40 s y subir unos 35 s, sin errores de cuota. Tras subir, la app tarda un poco en estar a pleno rendimiento: en la primera prueba de 200 estudiantes tras subir, el p95 fue de 940 ms, y con la app ya caliente volvió a 330 ms. Sube el plan y abre la sala **unos minutos antes** de que lleguen los estudiantes.
- Justo después de cambiar de nivel Azure sustituye el contenedor y la app puede responder **503 durante uno o dos minutos** (lo vi al bajar). `clase.ps1` ahora espera a que la app responda antes de terminar; esa espera se probó solo con un `az` simulado.
- Probado contra Azure real: `clase.ps1 -Modo bajar` y `-Modo subir` funcionaron, dejaron *Always On* y WebSockets como estaban y el plan terminó en el nivel pedido.
- Si hay un dominio propio, no se puede usar F1 (no admite dominios propios).

## Pasos

1. **Instala la CLI de Azure** (https://learn.microsoft.com/cli/azure/install-azure-cli) y entra: `az login`.
2. **Averigua tu región permitida.** Las suscripciones de estudiante tienen una política que limita las regiones, y la lista cambia de persona a persona. En el portal: *Policy → Authoring → Assignments → «Allowed resource deployment regions» → Parameters*. Prueba con una de esas.
3. **Despliega**, desde la carpeta `codesala`:

   ```powershell
   .\deploy\azure.ps1 -AppName uncodesala-tunombre -Location <region permitida>
   ```

   El script muestra al final el plan creado, los recursos y la dirección pública.
4. **Crea un presupuesto de aviso** (3 minutos): portal → *Cost Management + Billing → Budgets → Add*. Alcance: tu suscripción; monto 20 USD; alertas al 50 %, 80 % y 100 %. El saldo real de tu crédito se consulta en el portal de Azure Sponsorships; la [guía de Microsoft](https://learn.microsoft.com/en-us/azure/education-hub/navigate-costs) explica cómo entrar.
5. **Prueba antes de la clase:**

   ```bash
   npm run loadtest -- --url https://uncodesala-tunombre.azurewebsites.net --viewers 200
   ```

## Límites a tener en cuenta

- El plan B1 admite unos **350 WebSockets por instancia** (dato antiguo de Microsoft Q&A, verifícalo), sumando todas las salas. Para una clase de 200 sobra; dos clases de 200 al mismo tiempo no cabrían. El script limita cada sala a 300.
- La app debe tener **una sola instancia**: las salas viven en memoria. No escales a 2 o 3 instancias.
- Las salas se guardan en `/home/data`, que persiste entre reinicios mientras exista la app.
- **No se compila en Azure ni se usa la tubería de despliegue de Kudu.** Los dos primeros intentos con `az webapp deploy` terminaron en HTTP 502 y con el despliegue «en curso» sin que hubiera ningún proceso: la tubería lanzó su compilación interna de Node 22 y se colgó en el mismo paso las dos veces, incluso con el paquete ya compilado. Por eso `deploy\publicar.ps1` compila en tu equipo, vacía la carpeta de la app y descomprime el zip (2,5 MB: servidor, cliente compilado y 4 librerías) directamente con la API de archivos de Kudu, y reinicia la app. Funcionó a la primera.
- Para volver a publicar tras cambiar el código: `.\deploy\publicar.ps1`. Con `-SoloEmpaquetar` solo crea el `.zip` sin tocar Azure.
- La dirección de la app lleva un sufijo aleatorio (nombre de host único); se ve en la página de la app, en **Dominio predeterminado**, y al final de `publicar.ps1`.
- `publicar.ps1` espera hasta ver su identificador de versión en `/version`. Hace falta porque el reinicio de Azure es un relevo: el contenedor nuevo tarda 1 o 2 minutos en estar listo y, mientras tanto, sigue respondiendo el viejo (una prueba hecha en ese intervalo daba resultados del código anterior).
- `publicar.ps1` y `clase.ps1` se han ejecutado contra Azure real y funcionan; `azure.ps1` (crear los recursos desde cero) solo se probó con un `az` simulado, porque los recursos ya se habían creado a mano en el portal.
