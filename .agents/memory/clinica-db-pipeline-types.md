---
name: clinica-db pipeline types
description: Nombres exactos de campos y tipos en el pipeline Alephoo de clinica-db; errores frecuentes por género en español.
---

## Regla

`EstadoFilaPipeline` usa formas **femeninas** en español para los estados de fila:
- ✅ `"rechazada"` (NO "rechazado")
- ✅ `"incorporada"` (NO "incorporado")
- ✅ `"normalizada"`, `"aprobada"`, `"cuarentena"`, `"conciliada"`

## Campos en FilaAlephooStaging (heredados por FilaNormalizada)

- `estado: EstadoFilaPipeline` — estado actual de la fila en el pipeline
- `erroresValidacion: string[]` — errores de validación
- `advertenciasValidacion: string[]` — advertencias
- `filaNumero: number` — número de fila en el Excel (1-based)

`FilaNormalizada extends FilaAlephooStaging` — hereda todos esos campos.
`FilaCuarentena extends FilaNormalizada` — agrega `motivoCuarentena: string[]`.

## OpcionesPipeline

Campos requeridos: `uploadId`, `archivoS3Key`, `archivoNombre`, `archivoSha256`, `iniciadaPor` (con 'a').

Campo agregado: `skipIncorporacion?: boolean` — omite stage 5 (incorporación) cuando `true`.
El worker Alephoo usa `skipIncorporacion: !cfg.approve` para no incorporar sin --approve explícito.

**Why:** El pipeline siempre incorporaría si hay filas aprobadas; el worker requiere aprobación explícita externa.
**How to apply:** Siempre pasar `skipIncorporacion: !aprobado` desde el worker o cualquier caller que quiera staging-only.
