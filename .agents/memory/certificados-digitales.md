---
name: Certificados digitales con verificación pública
description: Reglas del módulo de certificados médicos con QR, estados y PDF inmutable (ago 2026)
---

- El certificado emitido es **inmutable**: errores se corrigen con revocar (estado `revocado`, motivo) o reemplazar (`reemplazaAId` al emitir → el anterior queda `reemplazado` en la MISMA transacción con guarda `estado='valido'`; conflicto → 409).
- Número institucional visible `CT-AAAAMMDD-XXXXXXXX` es **derivado** de id+createdAt (no hay columna); la verificación manual exige coincidencia completa (fecha incluida) para no permitir enumerar ids.
- El PDF original se guarda en base64 (`certificates.pdf_original`) al emitir; la descarga pública sirve siempre ese binario (fallback: regenera una vez y guarda, para certificados viejos).
- Cuerpo del PDF de certificados: tipografía digital (Helvetica); la firma sigue siendo la imagen manuscrita. Las órdenes/recetas siguen manuscritas (no unificar).
- Endpoints públicos de verificación tienen rate limit en memoria (30/min por IP) y registran cada consulta en `certificado_verificaciones` (IP/user-agent, solo auditoría — nunca mostrar al público).
- Página pública `/verificar/:codigo` (y `/verificar` con entrada manual): muestra DNI parcial `••.•••.456`, nunca el DNI completo; leyenda legal LCT 20.744 art. 210; NO afirmar registro en ReNaPDiS.

**Why:** spec institucional de Federico (ago 2026) + revisión de seguridad: el CT es secuencial y sin freno permitía extraer datos clínicos a escala.
**How to apply:** cualquier cambio a certificados debe preservar inmutabilidad, snapshot del PDF y estas guardas; cambios de datos del profesional/paciente NO deben alterar PDFs ya emitidos.
- Visor PDF propio en la página pública (pdfjs-dist **fijado en v4.10.x**: v5 usa `Map.getOrInsert`, demasiado nuevo y rompe en navegadores comunes). Zoom por botones + pellizco (se quitó `maximum-scale=1` del viewport global) y pantalla completa con X.
