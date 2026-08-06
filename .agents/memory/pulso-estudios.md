---
name: Pulso estudios/informes integration
description: How Pulso studies & reports are synced and rendered; security constraints on external report content.
---

# Integración Estudios/Informes de Pulso

## Modelo de datos y sync
- Los ESTUDIOS se sincronizan a una tabla local (`pulso_estudios`) igual que los pacientes: sync incremental con ventana rodante (~45 días) + upsert por `pulso_id`.
- El CONTENIDO del informe (HTML) y el PDF firmado NO se almacenan: se consultan EN VIVO on-demand contra Pulso vía proxy autenticado del backend. Solo la lista/metadata vive en la DB.
- Matching de paciente: primero por id externo (`pacientes_externos`/pulso), luego por DNI.

## Gap de vinculación y su fix
- El sync incremental NO re-visita estudios viejos fuera de ventana. Si un paciente se importa DESPUÉS de que su estudio ya se sincronizó con `patientId = null`, ese estudio quedaría huérfano.
- **Fix:** al final de cada ciclo de sync corre un relink (UPDATE por DNI) que vincula estudios `patient_id IS NULL` a pacientes cuyo `dni` coincide. Suma a `stats.vinculados`.
- **Why:** cerrar el gap sin depender de resync full manual.

## Seguridad — contenido externo
- El HTML del informe viene de un sistema externo → se re-sanitiza en el frontend con DOMPurify (allowlist estricta de tags/attrs) antes de `dangerouslySetInnerHTML`. No confiar solo en sanitización upstream.
- El proxy de PDF valida la firma `%PDF-` en el buffer, fuerza `Content-Type: application/pdf` y agrega `X-Content-Type-Options: nosniff` — no reemitir el content-type upstream a ciegas (riesgo de contenido activo bajo el origen de la app).
- **How to apply:** cualquier endpoint nuevo que proxee binarios/HTML de Pulso u otro HIS debe seguir estas dos reglas.

## Contrato
- El endpoint de PDF (`/pulso/informes/{id}/pdf`) es binario y se consume con `fetch` manual (token de `localStorage`), NO vía hook Orval — mismo patrón que el PDF del worklist. Intencional; no agregarlo al OpenAPI para no generar un hook binario inútil.
