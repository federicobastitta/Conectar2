---
name: Whaticket API (WhatsApp saliente)
description: Cómo enviar WhatsApp vía Whaticket SaaS y la restricción de plantillas del canal WABA
---

Config: secreto `WHATICKET_API_TOKEN` + env `WHATICKET_API_URL` (https://api.whaticket.com/api/v1) y `WHATICKET_CONNECTION_UUID`. La UUID de la conexión NO se puede listar por API (`/whatsapps` devuelve `[]`); la pasa el usuario desde la pantalla de Whaticket.

Envío: `POST /messages` con Bearer token y payload `{ connectionId, templateId?, messages: [{ number, body }] }`. **El `templateId` va en el NIVEL SUPERIOR del payload** — si se pone dentro de cada mensaje la API lo ignora y devuelve `400 "templateId is require when connection channel is WABA"` aunque esté presente. Truco de diagnóstico sin enviar nada real: mandar un número inválido ("000") — si la plantilla se aceptó, el error cambia a "Too Short!". Endpoints válidos verificados: GET `/contacts` (200), GET `/whatsapps`. No existen `/templates`, `/messages/send`, `/tickets`, etc.

**Variables de plantilla (verificado en vivo, ago 2026):** van como ARRAY dentro de cada mensaje: `messages: [{ number, body, variables: ["v1", ...] }]`. La cantidad debe coincidir EXACTO con las definidas en la plantilla (`400 "The number of variables (N) must match the template definition (M)"`); también existe `globalVariables` (array, top-level). Ojo: la plantilla aprobada original tiene 6 variables. El templateId "con link" se guarda en `config_sistema` clave `whaticket_template_link_id` (fallback env `WHATICKET_TEMPLATE_LINK_ID`).

**Restricción clave:** el canal es WABA (API oficial Meta) → iniciar conversación exige `templateId` de una plantilla aprobada por Meta (`400 "templateId is require when connection channel is WABA"`). Texto libre solo dentro de la ventana de 24 h. No hay endpoint para listar plantillas: el ID lo pasa el usuario.

**How to apply:** el cliente vive en `integraciones/whaticket.ts` (payload `{connectionId, messages:[…]}`); el templateId aprobado se guarda en `config_sistema` clave `whaticket_template_id` (fallback env `WHATICKET_TEMPLATE_ID`, PUT solo admin). Mapear errores JSON `{"error": ...}`, no loguear números completos (enmascarar) ni el token. Probar con node fetch (los secretos interpolados en bash se manglean).
