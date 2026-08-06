---
name: Verificación pública de órdenes de estudio
description: QR/link de veracidad en órdenes de baja complejidad, espejo del circuito de certificados
---
Las órdenes de estudio de BAJA complejidad llevan QR + link + código público de verificación (las de alta complejidad / planilla IOMA no, por ahora). Espejo del circuito de certificados:
- Token hex (20 chars) en `study_orders.verification_code`, generado PEREZOSAMENTE al armar el primer PDF (cubre órdenes viejas); si no se puede persistir, la orden sale sin QR (nunca un código huérfano).
- Número visible derivable `OE-AAAAMMDD-<id 8 dígitos>` (helper junto al armado de fuente del PDF). El ingreso manual exige coincidencia COMPLETA (fecha incluida) contra enumeración de ids, igual que CT.
- Endpoint público `GET /api/consultorio/ordenes/verificar/:codigo` comparte el rate limit por IP de certificados (30/min); devuelve datos mínimos (estudio, paciente con DNI parcial, médico/matrícula, vigente/anulada), nunca historia clínica.
- Página pública `/verificar-orden/:codigo` en el frontend (sin login).

Las RECETAS tienen el mismo circuito espejo: token perezoso en `prescriptions.verification_code`, número `RM-AAAAMMDD-<id 8>`, endpoint `GET /api/consultorio/recetas/verificar/:codigo` y página `/verificar-receta/:codigo`. El QR sale en todas las recetas (no hay distinción de complejidad).

**Wording aprobado (03-ago-2026):** tanto en certificados como en órdenes, el bloque del QR y las páginas públicas dicen "Validación de veracidad" y aclaran que valida que el documento fue emitido realmente por Diagnosticar Medical Center y no es una copia editada/adulterada.

**Pie claro:** debajo de la línea de firma de la orden va SIEMPRE en imprenta "Orden emitida por <MÉDICO>" + "M.P. <matrícula>"; la matrícula se escribe en `doc.y` después del nombre (el nombre puede ocupar 2 renglones — no usar offsets fijos o se enciman).
