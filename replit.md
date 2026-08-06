# Conectar — Red Clínica Digital

Conectar (antes Diagnored) es la plataforma clínica digital que conecta de forma permanente a la institución de salud con el paciente a través de su celular. No es solo una turnera ni una historia clínica: es una red de relación digital continua entre la clínica y el afiliado.

**Premisa central:** el celular del paciente es una extensión digital de la clínica. Mucha interacción entre la app del paciente y el sistema de gestión: turnos, estudios, sala de espera, mensajes, informes, videollamadas y relación médico-paciente.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — API server (port 8080, proxied en `/api`)
- `pnpm --filter @workspace/mi-diagnosticar run dev` — Frontend React (port 20469, proxied en `/`)
- `pnpm run typecheck` — typecheck completo del workspace
- `pnpm run build` — typecheck + build de todos los paquetes
- `pnpm --filter @workspace/api-spec run codegen` — regenerar hooks React Query y schemas Zod desde OpenAPI
- `pnpm --filter @workspace/db run push` — aplicar cambios de schema a la DB (dev only)
- `pnpm --filter @workspace/scripts run seed` — poblar la base de datos con datos de ejemplo
- `pnpm --filter @workspace/api-server run test` — tests de integración (vitest) contra la DB de desarrollo; crean y limpian sus propios datos

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite + shadcn/ui + wouter + TanStack Query
- API: Express 5 + pino logging estructurado
- DB: PostgreSQL + Drizzle ORM
- Validación: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval 8.20 (desde OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — Contrato OpenAPI (fuente de verdad)
- `lib/api-client-react/src/generated/api.ts` — hooks React Query generados
- `lib/api-zod/src/generated/api.ts` — schemas Zod para validación en el backend
- `lib/db/src/schema/` — schemas Drizzle por tabla (una tabla por archivo)
- `artifacts/api-server/src/routes/` — rutas Express agrupadas por dominio
- `artifacts/mi-diagnosticar/src/` — frontend React (páginas, componentes, hooks)
- `scripts/src/seed.ts` — script de datos de ejemplo

## Pendiente del próximo publish

- El selector "Sala de llamado (TV)" junto a "Mi consultorio" (Mi agenda y escritorio médico) ya funciona en dev; la app publicada aún no lo muestra porque su build es anterior. Se resuelve con el próximo publish.

## Módulos del producto

Detalle técnico completo de cada módulo en **`docs/modulos.md`**. Índice:

### Implementados (v0.1)
1. **Turnera online** — reserva de turnos en pocos pasos (sede → especialidad → profesional → fecha/hora)
2. **Agendas** — CRUD de turneras (días, horarios, duración, modalidad, visibilidad online/interna)
3. **Historia Clínica (HCE)** — legajo único: evoluciones, diagnósticos CIE10, recetas, adjuntos, signos vitales, auditoría + agente IA "Clinical Assistant"
4. **Dashboard** — resumen operativo del día, KPIs, ocupación por turnera
5. **Tablero operativo** — vista full-screen de episodios del día
6. **Portal del paciente** — booking sin cuenta, consulta por DNI/token
7. **Episodios / Estados** — máquina de estados, recepción, worklist, informes con firma
8. **Motor de importación (v2)** — wizard CSV/Excel/JSON con mapeo auto, dedup, background chunked; perfil Alephoo `his_turnos_diagnosticos_v1`
9. **Consultorio Digital** — `/consultorio` (médico): dashboard, agenda del día, prácticas, Mi Producción
10. **Resolución clínica** — recetas, derivaciones, certificados, órdenes de estudio + motor PDF + IA clínica
11. **Admisión + Sala de Espera** — check-in y cola en tiempo real (`/admision`, `/sala-espera`)
12. **Pantalla de sala para TV** — `/pantalla-sala` modo kiosco, protegida por token de dispositivo
13. **Consultorio Médico Unificado** — `/pacientes/:id/consulta`, finalizar consulta en una transacción
14. **Circuito de estados de estudios** — máquina de estados de órdenes con permisos por rol
15. **Motor de derivación directa + Estadísticas** — derivación de prácticas, bandeja de recepción, dashboard `/estadisticas`
16. **Reserva sin recargar datos** — paciente logueado confirma directo, turno atado a su sesión
17. **Mi lugar en la cola (paciente)** — `/mi-turno` con posición en vivo
18. **Integración Phir-it** — fuente de estudios/informes vía webhook + notificación WhatsApp
19. **Reprogramar turno (paciente)** — reprograma a otro slot de la misma turnera
20. **Robot de sondeo Phir-it (scraper)** — poller que entra al portal web y detecta informados
21. **Integración Pulso** — sync de pacientes desde el HIS Pulso sin duplicados
22. **Auditoría técnica v1.0** — lockdown de seguridad (`requireRol`, endpoints core solo staff, índices)
23. **Sprint "Recepcionar Paciente"** — recepción <30 seg: `/admision` = tablero de recepción, botón "Recepcionar" por fila, semáforo documental, tests de integración

### Roadmap (próximos módulos)
Centro de mensajes · Informes médicos · Envíos automáticos de informes · App del paciente (PWA) · PACS / imágenes médicas · Integraciones (Whaticket, WhatsApp Business, otros HIS) · Salas grupales · Asistente de turnos (IA). Ver `docs/modulos.md`.

## Filosofía UX

No copiar sistemas médicos viejos. Inspirarse en:
- **WhatsApp** — mensajería rápida y familiar
- **Instagram** — interfaz visual, moderna y cercana
- **Mercado Pago** — fluidez, confianza y claridad en cada paso
- **Uber** — seguimiento en tiempo real (sala de espera, llamador)
- **Google Maps** — estado y progreso siempre visible

El producto debe sentirse moderno, cercano y fácil de usar para cualquier tipo de paciente.

## Alcance excluido

No desarrollar facturación, contabilidad, liquidaciones ni módulos financieros. Conectar se integra con los sistemas que hacen esas funciones (Prestador, SUAC, etc.).

## Arquitectura

- Backend desacoplado, APIs documentadas en OpenAPI
- Auth por token (v0.1, simple); roadmap: JWT + Redis + RBAC fino
- Roles actuales: `admin`, `recepcionista`, `medico`, `paciente`
- Logs de auditoría (en roadmap con tabla `audit_log`)
- Portable a AWS, Azure, GCP, VPS privado, servidor dedicado o infraestructura propia
- Preparado para Docker/compose, variables de entorno, DB externa

## Usuarios de demo

| Email | Contraseña | Rol |
|-------|-----------|-----|
| admin@diagnosticar.ar | admin123 | admin |
| recepcion@diagnosticar.ar | recepcion123 | recepcionista |
| medico@diagnosticar.ar | medico123 | medico |
| paciente@diagnosticar.ar | paciente123 | paciente (Juan Pérez, pacienteId 1) |
| tecnico@diagnosticar.ar | tecnico123 | recepcionista (perfil técnico) |

## User preferences

- **Popup de datos faltantes al emitir órdenes (jul 2026):** NO frenar por falta de N° de afiliado/beneficiario; el popup solo pide DNI y cobertura.

- **Textos IA para la obra social (jul 2026):** nunca incluir frases negativas que resten fundamento a la solicitud (ej. "no se informan maniobras positivas", "sin hallazgos"); los datos negativos o faltantes se omiten.

- **Regla de almacenamiento (jul 2026): todo dato de pacientes o usuarios va a AWS (lib/clinica-db, RDS vía CLINICA_DB_URL); todo dato de sistema (turnos, agendas, worklist, configuración) queda en la DB de Replit.** En dev sin CLINICA_DB_URL, los módulos de datos de usuario usan DATABASE_URL como fallback (misma convención que createTestPool de clinica-db).

- **Al crear una turnera (jul 2026), el agente SIEMPRE debe preguntar:** 1) ¿es de práctica o de consulta? 2) ¿va a la worklist del PACS o no? Si va a la worklist, se envía al PACS con el mismo nombre que la agenda y con los datos del paciente según la regla de envíos de worklist; al usuario solo se le avisa que se creó la turnera nueva (sin pedirle nada más).

- **Texto manuscrito médico (jul 2026):** debe parecer escritura rápida de médico — trazo ágil, algo difícil de leer pero comprensible, letras parcialmente conectadas, con variaciones sutiles de tamaño/desnivel/espaciado por palabra Y por carácter (letras repetidas nunca idénticas), determinístico por profesional. NUNCA usar tipografías caligráficas/decorativas (ej. Dancing Script) ni manuscritas demasiado prolijas. Si algún día se muestra texto manuscrito en la interfaz web: misma pauta — fuente manuscrita + pequeñas variaciones controladas de rotación/posición/tamaño/espaciado por palabra o carácter, sin exagerar. Detalle en `api-server/src/pdf/fuentes_manuscritas/`.

- **El robot Klinicos SÍ puede cargar/crear pacientes en Klinicos** (regla actualizada jul 2026): consume el padrón de Conectar vía `GET /api/robot-klinicos/padron` (paginado, auth `x-api-key` = ROBOT_API_KEY) y hace el alta en Klinicos. Antes el alta era exclusivamente manual.

## Gotchas

- **Nunca usar `console.log` en el servidor** — usar `req.log` en handlers o `logger` (pino)
- **Campos `fecha` en turnos son strings YYYY-MM-DD**, no objetos Date — Drizzle `date(..., {mode:"string"})` solo acepta strings
- **Zod codegen genera `Date`** para campos fecha — convertir con `.toISOString().split("T")[0]` antes de queries Drizzle
- **Zod v3 instalado** pero el proyecto usa `import { z } from "zod/v4"` para la API v4 — no romper la compatibilidad
- **Orval genera `import * as zod from 'zod'`** — evitar `format: email` y `type: object` sin `properties` en el spec OpenAPI
- **`diasAtencion` en turneras** se almacena como string separado por comas (ej: "1,2,3,4,5")
- **Disponibilidad de slots** se calcula en tiempo real desde los parámetros de cada agenda (no se almacena en DB)
- **Cambios en el spec** OpenAPI requieren correr `pnpm --filter @workspace/api-spec run codegen` y luego `pnpm run typecheck:libs`
- **Búsquedas de texto con nombres en español** deben ser insensibles a acentos (`unaccent(col) ILIKE unaccent(patrón)`); la extensión se crea idempotente al arrancar el api-server
- **`router.use(middleware)` sin path se filtra a otros routers** montados en el mismo prefijo (`app.use("/api", ...)`) — siempre scopear: `router.use("/pacientes", mw)`
- **Query params de fecha llegan como string** pero el Zod generado espera `Date` — usar `coerceFechasQuery` (turnos.ts) antes de `safeParse`, si no el endpoint devuelve 400 siempre
- **"Hoy" y "ahora" se calculan en hora argentina** (`America/Argentina/Buenos_Aires`) vía `api-server/src/lib/tiempo.ts` (`hoyArgentina`, `horaArgentina`, `esSlotPasado`) — el server corre en UTC (+3h vs AR); nunca usar `new Date()` directo para decidir si un slot ya pasó
- **Día de semana desde fecha YYYY-MM-DD**: parsear como `new Date(\`${f}T00:00:00.000Z\`)` y usar `getUTCDay()`, nunca `getDay()` (se corre un día si el server no está en UTC)

## Pointers

- Ver skill `pnpm-workspace` para estructura del workspace, TypeScript y convenciones
- Ver skill `react-vite` para patrones del frontend
