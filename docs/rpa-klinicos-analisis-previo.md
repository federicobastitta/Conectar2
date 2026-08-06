# Análisis previo — Módulo de envío de prestaciones a KLINICOS (RPA)

Fecha: 31/07/2026. Estado: **solo análisis, sin cambios de código**.
Fuentes: prompt de desarrollo (attached_assets/Pasted-Quiero-incorporar…), documento de
documentación funcional obligatoria (attached_assets/Pasted-DOCUMENTACI-N…), código actual,
docs/robot-klinicos.md, docs/robot-openapi/, docs/klinicos-flujo-administrativo.md.

⚠️ **El `manual de facturacion.pdf` (v1.0, 30/07/2026) NO está subido a este proyecto.**
El documento obliga a leerlo completo antes de diseñar. Falta subirlo.

---

## 1. Arquitectura encontrada (esto YA existe en Conectar)

Gran parte del prompt **ya está construido**. Hay DOS caminos hacia KLINICOS conviviendo:

### Camino A — Automatizador interno (scraping HTTP, sin navegador)
- `artifacts/api-server/src/integraciones/klinicos-robot.ts`: opera el portal ACEAPP de
  KLINICOS por HTTP directo (login con antiforgery token, selección de
  establecimiento/sector/puesto, búsqueda de paciente por DNI, alta de paciente, ingreso
  ambulatorio, detalle de atención, carga de prestación). No usa Playwright: envía los
  mismos formularios que envía el navegador, con cookie jar propio.
- `integraciones/klinicos-cola.ts` + `klinicos-worker.ts`: cola persistente en la tabla
  `klinicos_trabajos` (estados pendiente → en_proceso → completado / error / cancelado,
  con paso_actual, intentos, errores, anti-duplicados por timestamps y URLs).
- UI: página **Configuración → KLINICOS** (`pages/configuracion/klinicos.tsx`) con
  bandeja de trabajos, contadores (pendientes / en proceso / completados / errores),
  editar, reintentar, cancelar, informes.

### Camino B — Robot externo ("Centro de Control Klinicos", ROBOT_API_URL)
- Servicio externo separado de Conectar, autenticado con `x-api-key`.
- Contrato en `docs/robot-openapi/robot-openapi.yaml`: `POST /api/v1/klinicos/consultations/process`
  (una transacción que valida token + crea ingreso + carga prestación), polling por
  `request_id` (idempotente: reintentar NO consume el token dos veces).
- Cola saliente de órdenes: tabla `robot_ordenes_envios` + worker con backoff
  (`integraciones/robot-ordenes.ts`). El encolado automático está **apagado por decisión**
  hasta que se firme el circuito.
- Validación de token detrás del flag `KLINICOS_TOKEN_VALIDATION_ENABLED`.
- Decisión registrada (jul 2026): *"el Robot externo es el ÚNICO autorizado a operar
  KLINICOS"*. El prompt nuevo pide construirlo ADENTRO de Conectar → **contradicción a
  resolver** (ver §8).

### Respuesta a "¿KLINICOS tiene API oficial?"
No se conoce API oficial ni importación masiva autorizada. Es un portal ASP.NET MVC
(ACEAPP) y hoy se opera por las mismas pantallas/formularios que un operador humano
(cumple la regla del manual). **Playwright no es necesario** para lo ya calibrado: el
scraping HTTP actual es más rápido y estable que un navegador. Playwright quedaría como
plan B si el portal agrega pasos con JavaScript imposibles por HTTP.

## 2. Tecnología actual de Conectar
- Monorepo pnpm. Backend: Node.js + TypeScript + Express + Drizzle ORM (PostgreSQL en AWS
  RDS; dev `conectar_app_dev`, prod `conectar_app_prod`).
- Frontend: React + Vite (`artifacts/mi-diagnosticar`), cliente generado por OpenAPI/Orval.
- Workers internos por `setInterval` en el mismo proceso del api-server (klinicos-worker,
  robot-ordenes, pulso, phirit-poller). No hay proceso worker separado hoy.
- Secretos por variables de entorno Replit. Auditoría en tabla `audit_log` (append-only).

## 3. Archivos que se tocarían (cuando se apruebe avanzar)
- `lib/db/src/schema/klinicos.ts` (+ nuevos estados/campos), posible tabla nueva de lotes.
- `artifacts/api-server/src/integraciones/klinicos-robot.ts` (autorizar token vía pantalla
  Prestaciones: filtrar fecha+DNI, 1 sola candidata CONFIRMADO sin autorización → Autorizar
  → releer → bono).
- `artifacts/api-server/src/integraciones/klinicos-worker.ts` (prioridades: token primero;
  modos simulación/asistido/automático; interruptor general).
- `artifacts/api-server/src/routes/` (nuevo router de envíos/lotes + bandeja de excepciones).
- `lib/api-spec/openapi.yaml` + codegen.
- `artifacts/mi-diagnosticar/src/pages/configuracion/klinicos.tsx` (o página nueva
  "Centro de Control"): botón Enviar a KLINICOS, bandeja de prevalidación, cola,
  excepciones, historial, filtros, métricas.

## 4. Modelo de datos propuesto (delta, no desde cero)
- `klinicos_trabajos`: agregar estados del prompt (listo_para_enviar, facturado,
  rechazado, revision, resultado_incierto) mapeados sobre los actuales; campos
  `modo` (simulacion/asistido/automatico), `aprobado_por`, `clave_idempotencia`
  (DNI + fecha efectiva + código KLINICOS + hash del token/autorización), `bono_numero`,
  `evidencia` (capturas/HTML ante error), `version_automatizador`.
- Índice ÚNICO sobre `clave_idempotencia` (previene duplicados a nivel base, no solo
  lógica).
- Tabla `klinicos_documentos_cargados`: hash SHA-256 del PDF + prestación + fecha
  (regla "un informe por práctica" + anti-recarga documental).
- Auditoría: reutilizar `audit_log` (ya es append-only) con acciones nuevas.

## 5. Flujo de automatización propuesto (resumen)
1. Prevalidación en Conectar (DNI, afiliado, cobertura, fecha efectiva, práctica con
   código EXACTO de la planilla — ya existe esta regla: sin código → revisión manual,
   nunca inventar), token presente, documentación.
2. Aprobación humana (modo asistido) → estado `listo_para_enviar`.
3. Worker toma el caso (token con prioridad absoluta), verifica idempotencia, opera el
   portal, exige coincidencia exacta (0 o >1 candidatas → revisión, fail-closed).
4. Confirmación solo si el modo lo permite; captura de bono/comprobante/mensaje.
5. Timeout / respuesta ambigua → `resultado_incierto`: NUNCA reenvía; primero consulta
   estado en KLINICOS o deriva a revisión.
6. Estado y evidencia vuelven a la bandeja de Conectar.

## 6. Riesgos técnicos
- **Cambio de pantallas de KLINICOS** rompe el scraping silenciosamente → detector de
  "pantalla inesperada" que frena el caso con alerta (criterio de aceptación del prompt).
- **Resultado incierto real**: el portal puede procesar y cortar la conexión; sin releer
  el listado se duplica. La relectura post-acción es obligatoria.
- Workers corren dentro del proceso web: un deploy/reinicio en medio de una carga deja
  casos `en_proceso` colgados → recuperación al arrancar (ya existe patrón parcial).
- CAPTCHA o bloqueo de IP del portal → derivación humana (regla ya aceptada).
- Concurrencia: contradicción del manual (1 sesión por usuario vs 2 por usuario / 8
  totales) → arrancar con UNA sesión, decisión pendiente registrada.
- Eco Doppler y resonancias: carga manual por decisión del 22/07/2026 — el automatizador
  debe EXCLUIRLAS explícitamente.

## 7. Plan por etapas (alineado al prompt)
- **Etapa 0 (bloqueante)**: recibir `manual de facturacion.pdf` + decisiones del §8.
- Etapa 1: informe de diferencias manual ↔ código (categorías: implementada / parcial /
  no implementada / contradictoria / riesgosa / decisión pendiente). Sin código.
- Etapa 2: prueba controlada de navegación (ya hay mucho calibrado en
  docs/klinicos-flujo-administrativo.md; falta calibrar la pantalla Prestaciones→Autorizar).
- Etapa 3: modo simulación (guardar lo que HABRÍA enviado).
- Etapa 4: MVP asistido con pocas prestaciones y aprobación humana.
- Etapa 5: métricas (aceptadas sin intervención por hora, no registros/minuto).
- Etapa 6: modo automático solo para circuitos estandarizados autorizados.

## 8. Información y DECISIONES que faltan (bloqueantes)
1. **Falta el manual**: subir `manual de facturacion.pdf` a este proyecto.
2. **¿Interno o Robot externo?** El prompt pide el automatizador ADENTRO de Conectar,
   pero hay una decisión previa registrada de que el Robot externo es el único autorizado
   a operar KLINICOS, y ya existe un contrato OpenAPI con él. Opciones:
   a) construir el worker interno (retomar `klinicos-robot.ts`) y jubilar al Robot externo;
   b) mantener el Robot externo como ejecutor y que Conectar solo gestione cola/estados;
   c) híbrido transitorio. **Decisión de negocio pendiente.**
3. **Token completo — regla contradictoria**: el documento dice "nunca guardar el token
   completo", pero la clínica pidió expresamente (31/07/2026) guardarlo para el reporte
   de facturación, y ya está en producción (`consultas_token.token_completo`). No se
   cambia nada hasta que definas cuál regla vale.
4. Credenciales de usuarios técnicos propios del RPA para KLINICOS (el manual exige
   usuarios propios; hoy hay credenciales de portal pero hay que confirmar cuáles y
   cuántas).
5. Confirmación contractual de concurrencia con KLINICOS (mientras: 1 sesión).
6. ¿La pantalla "Prestaciones → Autorizar" del manual reemplaza el flujo de token del
   Robot externo (`consultations/process`) o convive con él?
