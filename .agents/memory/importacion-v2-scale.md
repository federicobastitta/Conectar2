---
name: Import v2 background execution at scale
description: How the bulk import (Motor de importación v2) runs large jobs safely — resume source of truth, polling payload, and known risks.
---

# Import v2 (Motor de importación v2) — running big jobs

Large imports (Alephoo "Listado de Turnos con Diagnosticos" HTML-XLS files, 8k–70k rows)
run as a **background chunked job**, not a synchronous request. `POST .../ejecutar` with
`dryRun:false` returns 202 immediately and processes in `CHUNK_SIZE` batches; the frontend
polls `GET .../jobs/:id`.

## Resume must derive from the audit log, not counters
When resuming a partially-run job, compute the start offset and the running counters from
`importacion_auditoria` (`max(fila)` + `count(*)` grouped by `accion`), NOT from the job's
stored counters.

**Why:** each chunk inserts its audit rows atomically *before* updating the job counters.
If the process dies between those two steps, counters are stale but the audit log is correct.
Resuming by counters reprocesses an already-written chunk → duplicate evoluciones/diagnósticos
(no dedup on those inserts). Audit-derived offset is strictly safer (audit >= counters always).
Residual window: a crash *mid-chunk-loop* (before that chunk's audit insert) can still
reprocess up to one chunk's already-written rows.

**How to apply:** any change to how a chunk persists progress must keep the invariant "the
durable audit rows are written before, and are the source of truth for, resume position."

## Polling payload must exclude filasData
`GET /jobs` and `GET /jobs/:id` select an explicit column set that omits `filasData` (the raw
parsed rows JSONB blob — hundreds of MB for the big files). Never return that blob on the
polling path.

## Known risks (deferred, not fixed)
- Upload uses `multer.memoryStorage()` (250MB limit) and the whole file + parsed rows + JSONB
  blob live in memory; the background runner reloads all rows again. Verified OK at 162MB but
  risky at the upper bound — real fix is streaming/disk/object-storage + paged row retrieval.
- Import routes have no auth/requireRol → unauthenticated 250MB upload is a DoS vector.

## Perfil turnos_hc (ago 2026)
- Los exports "turnos según diagnóstico" nuevos vienen en UTF-8 (no latin1 como otros Alephoo), igual con bytes NUL a limpiar.
- El import turnos_hc es idempotente: dedup de evolución por pacienteId+texto exacto y de diagnóstico por pacienteId+descripcion+cie10 (isNull).
- /validar usa el mapeo guardado del job si el body no trae mapeoColumnas; antes crasheaba y dejaba el job clavado en "validando" (destrabar = re-POST validar).
- ejecutar es resumible: si el server se reinicia a mitad, re-POST /ejecutar retoma del audit log.
