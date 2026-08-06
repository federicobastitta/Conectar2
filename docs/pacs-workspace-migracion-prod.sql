-- ═══════════════════════════════════════════════════════════════════════════
-- Migración PRODUCCIÓN — Workspace PACS v1.0 (contrato DiagnosticPACS CONGELADO)
-- Estado: PREPARADA Y VALIDADA EN DEV — **NO APLICAR EN PROD TODAVÍA**
-- Bloqueantes: (1) DiagnosticPACS confirma el contrato v1.0,
--              (2) termina la migración DICOM→S3 y la conciliación de imágenes.
-- Cómo aplicar cuando se destrabe: psql "$DATABASE_URL" -f docs/pacs-workspace-migracion-prod.sql
-- Todo es aditivo e idempotente (IF NOT EXISTS): re-ejecutar es inocuo.
-- Con PACS_WORKSPACE_ENABLED=false estas tablas quedan vacías y sin uso.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- 1) informe_estudios: un informe abarca N estudios DICOM
CREATE TABLE IF NOT EXISTS informe_estudios (
  id serial PRIMARY KEY,
  informe_id integer NOT NULL,
  study_order_id integer,
  study_instance_uid text NOT NULL,
  accession_number text,
  modality text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS informe_estudios_unico
  ON informe_estudios (informe_id, study_instance_uid);

-- 2) informe_versiones: versionado inmutable (cada firma/publicación = versión)
CREATE TABLE IF NOT EXISTS informe_versiones (
  id serial PRIMARY KEY,
  informe_id integer NOT NULL,
  version integer NOT NULL,
  texto text NOT NULL,
  firmado_por integer,
  firmado_en timestamptz,
  publicado_en timestamptz,
  pdf_referencia text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS informe_versiones_unico
  ON informe_versiones (informe_id, version);

-- 3) informe_imagenes_clave_pacs: evidencia congelada al firmar (CM-4, Opción A)
CREATE TABLE IF NOT EXISTS informe_imagenes_clave_pacs (
  id serial PRIMARY KEY,
  informe_id integer NOT NULL,
  informe_version_id integer,
  key_image_id text NOT NULL,
  study_instance_uid text NOT NULL,
  series_instance_uid text NOT NULL,
  sop_instance_uid text NOT NULL,
  frame_number integer,
  titulo text,
  comentario_medico text,
  orden integer NOT NULL DEFAULT 1,
  thumbnail_sha256 text,
  copia_referencia text,
  congelada_en timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS informe_imagenes_clave_pacs_unico
  ON informe_imagenes_clave_pacs (informe_id, key_image_id);

-- 4) pacs_eventos: webhook entrante, idempotencia por event_id
CREATE TABLE IF NOT EXISTS pacs_eventos (
  id serial PRIMARY KEY,
  event_id text NOT NULL,
  event_type text NOT NULL,
  order_id text,
  study_instance_uid text,
  ocurrido_en timestamptz,
  payload jsonb,
  procesado_en timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pacs_eventos_event_id_unico
  ON pacs_eventos (event_id);

-- 5) study_orders: columnas aditivas del contrato (CM-1: accession único e inmutable)
ALTER TABLE study_orders ADD COLUMN IF NOT EXISTS accession_number text;
ALTER TABLE study_orders ADD COLUMN IF NOT EXISTS modality text;
ALTER TABLE study_orders ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;
ALTER TABLE study_orders ADD COLUMN IF NOT EXISTS observaciones_tecnico text;
ALTER TABLE study_orders ADD COLUMN IF NOT EXISTS status_updated_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS study_orders_accession_unico
  ON study_orders (accession_number) WHERE accession_number IS NOT NULL;

COMMIT;
