---
name: Prod schema drift pending
description: DDL applied in dev via psql that must be re-applied to the production DB at next deploy
---

Because `drizzle push` hard-fails in this sandbox, dev schema changes are applied via raw psql. **Resuelto estructuralmente (jul 30 2026):** el api-server sincroniza el esquema al arrancar (`src/lib/esquema-drift.ts`): compara el esquema Drizzle contra information_schema de la base conectada y aplica solo cambios aditivos (ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS). Columnas NOT NULL sin default se agregan nullable con advertencia; FKs e índices no renderizables quedan como advertencia en logs. Reporte read-only para admins: GET /api/infraestructura/esquema-drift.

**Verificado en prod AWS (jul 31 2026, post-publish):** GET /api/infraestructura/esquema-drift en la app publicada devolvió `ok:true` sin tablas/columnas faltantes; sin errores del módulo en los logs de deployment; y todos los índices/tablas históricamente pendientes verificados presentes por SQL directo en `conectar_app_prod` (turnera_participantes_unique, turnos_qr_codigo_unique, certificates_verification_code_idx, pacs_worklist_orden_unico, turnera_obras_sociales_unique, turnera_practicas_unique, mensajes_profesional_destino_idx, chat_mensajes_conversacion_idx, informe_plantillas_prof_idx, nomenclador_os_codigo_unique, equivalencias_os_codigo_unique, especialidades_nombre_norm_uq; tablas nomenclador_*, pedidos_recuperacion_clave, config_sistema, videollamadas, pacs_estudios_vinculados, chat_mensajes, mensajes_profesional, informe_plantillas, turnera_*). Nomenclador prod tiene 6803 filas importadas.

**Lección clave:** el schema diff del publish solo sincroniza la base Replit de prod — NO toca la base AWS (`conectar_app_prod`) que es la que usa la app publicada. Desde jul 2026 la sincronización al arrancar cubre columnas/tablas aditivas en AWS; índices/FK nuevos siguen siendo manuales (aplicar con pg + `CREATE INDEX IF NOT EXISTS`).

**Currently pending for prod:** PACS workspace DDL (4 tables informe_estudios/informe_versiones/informe_imagenes_clave_pacs/pacs_eventos + study_orders columns) — script ready and validated at `docs/pacs-workspace-migracion-prod.sql`, deliberately NOT applied: blocked until DiagnosticPACS confirms contract v1.0 and finishes DICOM→S3 migration. La sincronización al arrancar lo aplicaría solo (tables stay empty with flag off) una vez que el esquema Drizzle lo incluya — but do not enable while the PACS migration constraint says otherwise.

**DATA pendiente (no es drift de esquema):**
- Turnera "Ergometrias 24hs — Lomas" no existe en prod (solo hay Ergometrías Berazategui) — crearla desde la UI publicada (tipo=práctica, worklist=sí) cuando corresponda.
- Dos turneras de guardia con `es_guardia=false` (Ana Varela / guardia ecografía, y Julio Figueroa / guardia clínica) — **igual en dev y prod**, así que no es divergencia; si deben ser guardia, corregirlas en ambos entornos a la vez.

**How to use this file:** add pending SQL here when applying dev DDL via psql that la sincronización no cubre (índices, FKs, NOT NULL con default); tras el próximo publish, verificar y quitar lo aplicado. Data migrations (UPDATEs) CAN run against the AWS prod base directly: connect with node pg from artifacts/api-server using CLINICA_DB_URL with the database path swapped to `/conectar_app_prod` (default path is /postgres, which is NOT the app DB; el CA sale de lib/db/src/rds-ca.ts). Use with care; verify counts before/after.
