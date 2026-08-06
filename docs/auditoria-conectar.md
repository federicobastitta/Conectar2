# Auditoría técnica, funcional y arquitectónica — Conectar (by Diagnosticar)

**Fecha:** 9 de julio de 2026
**Alcance:** revisión completa del código (backend, frontend, modelo de datos, contrato API), sin cambios de código.
**Objetivo:** consolidar la base del sistema antes de incorporar nuevas funcionalidades.

---

## Resumen ejecutivo

Conectar creció rápido y bien en features, pero acumuló **tres deudas estructurales** que hoy son el mayor riesgo del proyecto:

1. **Duplicación clínica**: existen dos historias clínicas paralelas (HCE estructurada y la legada), dos tablas de recetas, tres formas de pedir un estudio y tres máquinas de estados no sincronizadas (turnos, órdenes de estudio, solicitudes de derivación).
2. **Seguridad despareja**: los módulos nuevos tienen autorización sólida por rol y ownership; los módulos fundacionales (turnos, turneras, historia clínica legada, dashboard, importación, IA) siguen **sin autenticación**.
3. **Fragmentación de pantallas operativas**: el médico y la recepción tienen 3–4 pantallas que hacen cosas parecidas (tablero, sala de espera, worklist; HCE, consulta unificada, consultorio), lo que multiplica clics y confusión.

La buena noticia: la arquitectura de base (OpenAPI-first, codegen, Drizzle, monorepo) es correcta y escala. No hace falta reescribir; hace falta **consolidar**: elegir un ganador por cada concepto duplicado, migrar y borrar el resto.

---

## 1. Módulos existentes

| # | Módulo | Pantallas | Backend |
|---|--------|-----------|---------|
| 1 | Turnera online / booking | `/turnos/nuevo`, portal paciente | `turnos.ts`, `turneras.ts` |
| 2 | Agendas (turneras) | Configuración | `turneras.ts` |
| 3 | Historia Clínica (HCE) | `/pacientes/:id/hce` | `hce.ts` + `historia_clinica.ts` (legado) |
| 4 | Dashboard | `/` | `dashboard.ts` |
| 5 | Tablero operativo | `/turnos/tablero` | `turnos.ts` |
| 6 | Portal del paciente | booking sin cuenta | `turnos.ts` |
| 7 | Episodios / informes | `/worklist`, `/informes` | `informes.ts` |
| 8 | Importación | `/importacion` | `importacion.ts` (v1, legado) + `importacion_v2.ts` |
| 9 | Consultorio digital | `/consultorio` | `consultorio.ts` |
| 10 | Resolución clínica | pestañas en HCE/consulta | `consultorio_docs.ts` |
| 11 | Admisión + Sala de espera | `/admision`, `/sala-espera`, `/pantalla-sala` | `sala_espera.ts` |
| 12 | Consulta unificada | `/pacientes/:id/consulta` | `consultorio_docs.ts` |
| 13 | Circuito de estudios | integrado en 10/12 | `consultorio_docs.ts` |
| 14 | Derivación directa + solicitudes | pestaña Derivar, `/recepcion/solicitudes` | `derivacion.ts` |
| 15 | Estadísticas | `/estadisticas` | `estadisticas.ts` |
| 16 | Asistente IA / agentes | `/asistente` | `agentes.ts`, `openai.ts` |
| 17 | Mensajería, salas grupales, notificaciones | `/mensajeria`, `/salas-grupales`, `/notificaciones` | parcial |

## 2–4. Estado funcional por módulo

### Completos y sólidos
- **Admisión + Sala de espera** (transiciones atómicas, auditadas, con tests de concurrencia, pantalla TV pública con datos anonimizados).
- **Derivación directa** (máquina de estados completa, permisos por rol y ownership, reprogramación, notificaciones simuladas, e2e verificado).
- **Resolución clínica** (recetas, derivaciones, certificados, órdenes, PDF idempotente, timeline).
- **Consulta unificada** (finalizar consulta en una transacción DB).
- **Estadísticas** (admin only, funcional).
- **Informes** (recientemente protegido con roles y ownership).

### Incompletos
- **Notificaciones**: solo "simuladas" (registro en DB); no hay envío real por WhatsApp/push/email ni dashboard de entregas.
- **Mensajería** (`/mensajeria`): pantalla presente pero el módulo Centro de Mensajes del roadmap no está implementado de punta a punta.
- **Salas grupales** (`/salas-grupales`): esqueleto de pantalla, sin lógica de invitaciones/notificaciones.
- **Configuración** (`/configuracion`): página casi vacía; la configuración real vive dispersa.
- **App del paciente**: el paciente tiene rol y login pero casi ninguna pantalla propia (la premisa central del producto — el celular como extensión de la clínica — todavía no existe como experiencia).
- **Importación v1**: convive con v2 sin haberse retirado.

## 5. Funcionalidades duplicadas (hallazgo crítico)

| Concepto | Implementación A | Implementación B (o C) | Recomendación |
|----------|------------------|------------------------|---------------|
| Historia clínica | `encounters`/`clinical_records`/`vital_signs` (HCE) | `evoluciones`/`diagnosticos`/`adjuntos` (legado, **sin auth**) | Consolidar en HCE; migrar y retirar legado |
| Recetas | `prescriptions` | `recetas` (legado) | Solo `prescriptions` |
| Pedir un estudio | `study_orders` (resolución) | `solicitudes` (derivación) + `practicas` (consultorio) | Unificar: `solicitudes` como motor de workflow; `study_orders` como acto clínico que **crea** una solicitud (hoy no están vinculados) |
| Adjuntos | `encounter_attachments` | `adjuntos` + `documentos_paciente` | Un solo repositorio documental del paciente |
| Auditoría | `audit_log` | `auditoria_pacientes` + `importacion_auditoria` | Una sola tabla `audit_log` con `entidad` |
| Importación | `importacion.ts` (v1) | `importacion_v2.ts` | Borrar v1 |
| Badges de estado (UI) | `EstadoBadge`, `StatusBadge`, `OrdenEstadoBadge`, `SolicitudEstadoBadge` | — | Un componente genérico con mapa de estados por dominio |

## 6. Deuda técnica

1. **Endpoints sin autenticación** (la deuda más urgente): `turnos.ts`, `turneras.ts`, `historia_clinica.ts` (¡datos clínicos!), `dashboard.ts`, `importacion.ts`, `openai.ts` no verifican token. Cualquiera con la URL puede leer/escribir.
2. **Auth por copia y pega**: cada route file repite el patrón `getUserFromRequest` + chequeo de rol hardcodeado. No hay middleware global ni RBAC centralizado; un archivo nuevo nace desprotegido por defecto.
3. **Fetch crudo en frontend**: `worklist`, `tablero` e `informe editor` usan `fetch` manual con token de `localStorage`, en paralelo al cliente generado. Doble mantenimiento y riesgo de desincronización de auth.
4. **Transacciones escasas**: fuera de "finalizar consulta", la mayoría de las escrituras multi-tabla (solicitud + turno + auditoría + notificación) son escrituras parciales sin transacción.
5. **`tokenStore` en memoria**: cache write-through por instancia; se rompe con más de una réplica en producción.
6. **`diasAtencion` como string CSV** en turneras: impide consultas eficientes de disponibilidad.
7. **Foreign keys ausentes** en varias tablas (`turnos.turnera_id`, `solicitudes.patient_id`, etc.): riesgo de registros huérfanos.
8. **`users.profesional_id` como texto** en DB vs entero en el contrato API.
9. **Archivos gigantes**: `consultorio_docs.ts` (~1.200 líneas: PDF + IA + estados + CRUD) e `importacion_v2.ts` (~1.000).
10. **Manejo de errores inconsistente**: algunos handlers sin try/catch (500 implícito), logging con `req.log` aplicado de forma despareja.

## 7. Problemas de arquitectura

1. **Tres máquinas de estados no sincronizadas** para el mismo flujo real (paciente → estudio → informe): `turnos.estado` (16+ estados), `solicitudes.estado` (10), `study_orders.status` (8). Un estudio puede estar "realizado" en una tabla y "en espera" en otra. **No existe la entidad que las una.**
2. **Ausencia del concepto "Episodio" como entidad**: el episodio existe como idea (estados del turno) pero no como agregado que conecte turno, solicitud, encuentro, orden e informe.
3. **Seguridad como responsabilidad de cada endpoint** en lugar de capa transversal.
4. **Dos generaciones de esquema conviviendo** (HCE nueva vs historia clínica legada) sin plan de migración explícito.
5. **La "app del paciente" no existe como superficie separada**: el rol paciente entra por la misma SPA administrativa, lo que contradice la premisa del producto y complica el diseño de permisos.

## 8. Procesos que pueden simplificarse

- **Recepción de un paciente**: hoy toca hasta 3 pantallas (tablero → admisión → sala de espera). Debería ser una sola vista de recepción con búsqueda, admisión y cola.
- **Atención médica**: el médico navega entre consultorio → agenda → HCE → consulta unificada. Un solo punto de entrada ("Mi día") con apertura directa de la consulta.
- **Pedir un estudio**: hoy hay 3 formularios distintos según por dónde entres. Debe haber uno solo, que dispare el workflow completo (orden → solicitud → turno → informe).
- **Validación de cobertura**: hoy está dentro del flujo de solicitudes; debería ser un paso estándar de la admisión para todo turno.

## 9. Pantallas que podrían unificarse

| Unificar | En |
|----------|-----|
| `/turnos/tablero` + `/admision` + `/sala-espera` | **Centro de Recepción** (una pantalla, tres paneles: agenda del día, admisión, cola) |
| `/consultorio` + `/worklist` (parte médica) | **Mi Día del médico** |
| `/pacientes/:id/hce` + `/pacientes/:id/consulta` (+ `/pacientes/:id/historia` huérfana) | **Ficha del paciente** única: lectura = HCE, botón "Iniciar consulta" abre el modo de edición sobre la misma pantalla |
| `/informes` + `/notificaciones` | Bandeja de informes con su estado de entrega |
| `/configuracion` + sedes + especialidades + turneras + servicios | **Configuración** unificada con secciones |

## 10. Módulos con demasiadas responsabilidades

- **`consultorio_docs.ts`**: CRUD de 4 tipos de documentos + máquina de estados de órdenes + motor PDF + IA clínica + timeline + dashboard del médico. Separar en: documentos, workflow de órdenes, PDF, IA.
- **Consultorio Digital (frontend)**: dashboard + agenda + prácticas + producción. Las "prácticas" duplican a las órdenes de estudio y deberían desaparecer como concepto separado.
- **`turnos.ts`**: booking público + gestión interna + tablero + estados. Separar la superficie pública (portal) de la interna.

## 11. Funcionalidades a mover a módulos existentes (no crear nuevos)

- **Prácticas del consultorio** → absorber en órdenes de estudio / solicitudes.
- **Envíos automáticos de informes** (roadmap #11) → extensión del módulo de notificaciones existente (`notificaciones_salientes`), no un módulo nuevo.
- **Asistente de turnos IA** (roadmap #16) → reutilizar el motor de disponibilidad de derivación (`/derivacion/servicios/:id/disponibilidad`), que ya prioriza por menor espera; el asistente es solo otra interfaz sobre el mismo motor.
- **Lugar en la cola desde el celular** → parte del módulo sala de espera, no módulo aparte.
- **Validación de cobertura/token** → moverla de "solicitudes" a "admisión" como capacidad transversal.

## 12. Riesgos de seguir construyendo sobre la arquitectura actual

1. **Incidente de datos clínicos**: los endpoints sin auth son explotables hoy; publicar el producto así es inviable legalmente (datos de salud).
2. **Divergencia de datos clínicos**: cada sprint que escribe en una de las dos historias clínicas agranda el costo de la migración futura.
3. **Estados fantasma**: sin sincronización entre las 3 máquinas de estados, los KPIs de estadísticas y las pantallas operativas mostrarán números que no cierran (ya es posible hoy).
4. **Parálisis por pantallas**: cada módulo nuevo agrega otra pantalla al menú (ya hay 20+ ítems); los usuarios administrativos no van a adoptar el sistema.
5. **Escalado horizontal roto** por el token store en memoria.
6. **Onboarding de desarrollo cada vez más caro**: 3 formas de hacer lo mismo significa que cada feature nueva debe decidir (mal) dónde vivir.

## 13. Mejoras de experiencia de usuario recomendadas

- **Menú por rol, no por módulo**: recepcionista ve 4 ítems (Recepción, Turnos, Pacientes, Solicitudes); médico ve 3 (Mi Día, Pacientes, Mensajes); admin ve todo.
- **Buscador global de pacientes** (ya existe la búsqueda insensible a acentos) accesible con atajo de teclado desde cualquier pantalla.
- **Estados con lenguaje humano y color consistente** en todo el sistema (hoy cada pantalla tiene su propio mapa de colores).
- **Acciones contextuales**: desde cualquier lugar donde aparezca un paciente, poder abrir ficha / iniciar consulta / admitir sin cambiar de pantalla.
- **Modo "pantalla de trabajo"** persistente para recepción (como la pantalla TV): auto-refresh, sin navegación.

## 14. Oportunidades para reducir clics

- **Admisión en un clic** desde la agenda del día (hoy: ir a admisión → buscar → admitir).
- **"Atender siguiente"** en la vista del médico: un botón que llama al próximo de la cola y abre su consulta (hoy: sala de espera → llamar → atender → navegar a consulta).
- **Finalizar consulta ya crea todo** (bien resuelto); extender el patrón: al firmar un informe, ofrecer publicar + notificar en el mismo paso.
- **Derivar desde el plan de la consulta**: si el médico escribe una orden, ofrecer directamente el primer turno disponible (el motor ya existe) sin pasar por recepción cuando no requiere autorización.
- **Autocompletar cobertura** desde la ficha del paciente en booking y solicitudes.

## 15. Funcionalidades que hoy sobran

- **Importación v1** (retirar; v2 la reemplaza).
- **`/pacientes/:id/historia`** (huérfana, reemplazada por HCE).
- **Prácticas del consultorio** como entidad separada (duplican órdenes).
- **Tablas legadas** `evoluciones`/`recetas`/`diagnosticos`/`adjuntos` (tras migrar datos).
- **Pestaña "Nueva Consulta" dentro de HCE** (la consulta unificada es superior; HCE debe quedar como lectura).
- **`/notificaciones` como pantalla separada** (integrar donde se genera la notificación).

## 16. Funcionalidades que faltan para un ERP/HIS profesional

**Seguridad y cumplimiento (bloqueantes para 1.0):**
- Autenticación en el 100% de los endpoints + RBAC centralizado.
- Sesiones robustas (expiración, revocación, refresh) fuera de memoria.
- Auditoría completa y uniforme de acceso a datos clínicos (quién vio qué, no solo quién escribió).
- Backups y política de retención de datos de salud.

**Operación clínica:**
- Notificaciones reales (WhatsApp Business/email/push) con estado de entrega.
- App/portal del paciente real (turnos, resultados, cola, documentos) — es la premisa del producto.
- Gestión de ausentismo y sobreturnos; lista de espera automática.
- Consentimientos informados digitales.
- Interoperabilidad mínima: export HL7/FHIR de encuentros y resultados, códigos de cobertura estandarizados.

**Plataforma:**
- Manejo de archivos/estudios en object storage (hoy los adjuntos son referencias sueltas).
- Ambientes: seeds separados de datos demo vs producción, migraciones versionadas (hoy `db push`).
- Observabilidad: métricas y alertas, no solo logs.

## 17. Propuesta de arquitectura para la versión 1.0

### Principio rector
**Un concepto = una tabla = un flujo = una pantalla.** Todo lo demás se migra y se borra.

### Modelo de dominio consolidado (5 agregados)

1. **Paciente** (MPI): identidad, cobertura, documentos, grupo familiar. Una sola tabla de adjuntos (`documentos_paciente`) para todo archivo del paciente.
2. **Agenda**: sedes, especialidades, profesionales, turneras (con `dias_atencion` relacional), turnos. Estados del turno reducidos a los operativos: `reservado → confirmado → en_sala → llamado → en_atencion → atendido` (+ `cancelado`, `ausente`).
3. **Episodio clínico** (nueva entidad central): une turno + encuentro + órdenes + informe. Es el hilo conductor que hoy falta. Cada pedido de estudio es una **Solicitud** (motor único de workflow: la máquina de estados de derivación, que es la más completa) vinculada al episodio; `study_orders` queda como el documento clínico que la origina.
4. **Historia clínica**: solo el esquema HCE (`encounters`, `prescriptions`, `vital_signs`); las tablas legadas se migran y retiran. La HCE es una **vista de lectura** de los episodios.
5. **Comunicaciones**: notificaciones salientes (con proveedor real), mensajería, y a futuro la app del paciente como cliente de este agregado.

### Capa de seguridad transversal
- Middleware global de autenticación en Express: **todo `/api/*` exige token salvo lista blanca explícita** (login, portal público, pantalla TV).
- Módulo RBAC único: roles y reglas de ownership declarativas (`medico → solo recursos de su profesionalId`, `paciente → solo lo propio`), consumido por todos los routers.
- Sesiones en DB (ya existe `sesiones`) sin cache en memoria, o con cache compartido si se escala.

### Frontend: 3 espacios de trabajo, no 20 pantallas
- **Recepción**: agenda del día + admisión + cola + solicitudes (una pantalla con paneles).
- **Médico**: "Mi Día" (cola + agenda + producción) → abre **Ficha del paciente** única (lectura HCE / modo consulta / resolución / derivación en la misma superficie).
- **Administración**: dashboard, estadísticas, configuración unificada, importación.
- El **paciente** sale de la SPA administrativa: portal/PWA propio consumiendo la misma API.
- Regla técnica: un solo cliente HTTP (el generado), cero `fetch` manual; un solo sistema de badges/estados.

### Orden de ejecución sugerido (consolidación antes que features)

| Fase | Contenido | Por qué primero |
|------|-----------|-----------------|
| 1. Seguridad | Middleware global + RBAC + proteger los 6 routers abiertos + sesiones sin memoria | Bloqueante legal y el riesgo más barato de eliminar ahora |
| 2. Unificación clínica | Migrar historia legada → HCE; una sola tabla de recetas y de adjuntos; retirar importación v1 y pantallas huérfanas | Cada semana de espera agranda la migración |
| 3. Episodio + workflow único | Entidad episodio; solicitudes como único motor de estados; vincular study_orders → solicitud → turno → informe | Elimina los estados fantasma y arregla las estadísticas |
| 4. Consolidación de pantallas | Centro de Recepción, Mi Día, Ficha única; menú por rol | Adopción de usuarios; reduce clics de forma masiva |
| 5. Comunicaciones reales | WhatsApp/email reales con estado de entrega; base del portal del paciente | Es la promesa diferencial del producto y ya tiene la infraestructura de datos lista |

### Qué NO cambiar
- OpenAPI-first + codegen (Orval): funciona y disciplina el contrato.
- Drizzle + PostgreSQL, monorepo pnpm, Express: correctos para la escala objetivo.
- Los módulos recientes (sala de espera, derivación, resolución, consulta unificada): son el patrón de calidad a replicar — transiciones atómicas, auditoría, permisos por ownership, tests.

---

**Conclusión:** el sistema no necesita más superficie, necesita menos. Con las 5 fases de consolidación, Conectar queda con una base defendible (seguridad), un modelo de datos sin ambigüedad (episodio como hilo conductor) y tres espacios de trabajo claros. Sobre esa base, los módulos del roadmap (mensajería, app del paciente, PACS, IA de turnos) se construyen una sola vez y en el lugar correcto.
