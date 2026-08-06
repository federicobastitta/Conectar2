---
name: Firma de planillas IOMA
description: Circuito de aprobación y firma de la planilla de alta complejidad (study_orders)
---

Regla: la firma/sello del PDF de la planilla IOMA se estampa SOLO si `study_orders.firma_estado = 'firmada'` en la base; el flag `firmaAutorizada` lo setea el backend en la fuente del PDF y jamás viene del frontend. Vista previa y borradores salen con "PENDIENTE DE FIRMA".

**Why:** requisito legal/clínico del usuario — la firma es una declaración jurada del prescriptor; ni admin ni "vista como" pueden firmarla. Los endpoints de firma usan el token REAL (`getUserIdFromToken`), no el usuario efectivo, así la impersonación admin queda bloqueada por construcción.

**How to apply:**
- Auto-firma (ago 2026, pedido del usuario): si el que EMITE la orden (o crea la nueva versión) es el propio prescriptor real, la planilla nace firmada en la misma transacción (hash + evento en el log). Admin emitiendo en nombre del médico sigue dejándola `pendiente_firma` y pasa por "Firmas pendientes".
- Firmada = inmutable: correcciones via `nueva-version` (clona la orden, v+1, la vieja pasa a `reemplazada`). Eventos en `study_orders_firma_log` (solo INSERT).
- Órdenes con planilla creadas antes de la migración quedaron `pendiente_firma`: sus PDFs re-descargados salen sin firma hasta que el prescriptor las apruebe.
- El push al Robot ocurre al emitir, antes de la firma: ese PDF sale marcado pendiente (pendiente definir si debe esperar a la firma).
- Pre-verificación sin firma real: se puede leer `profesionales.firma_imagen` de la base prod (CLINICA_DB_URL apunta a `postgres`; cambiar el path a `conectar_app_prod`) y renderizar la planilla localmente con `generarPdfDocumento({ firmaAutorizada: true })` + pdftoppm/sharp para validar tinta azul y transparencia; lo único no simulable es el acto de firma del médico.
- Imágenes de firma: se procesan a PNG transparente azul birome (umbral de luminancia → alfa) y se guardan en `profesionales.firma_imagen`; en prod se cargan vía el endpoint admin de profesionales, nunca en el repo. El sello negro es el texto que ya dibuja el PDF.
