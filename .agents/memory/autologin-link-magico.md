---
name: Autologin por link mágico
description: Links de ingreso del paciente (WhatsApp) hasheados en config_sistema; ahora permanentes y reutilizables, atados a la ficha (no a un usuario Conectar).
---

- El token plano nunca se persiste: la clave de config_sistema es `autologin_paciente_<sha256>`, el valor JSON lleva estado/auditoría (lib/autologin del api-server).
- **Permanente y reutilizable** (decisión del usuario, ago-2026): sin vencimiento ni un-solo-uso; cada uso incrementa `usos` y `ultimoUsoEn`. Compartirlo es responsabilidad del paciente; el motivo fue evitar que se le cierre la sesión.
- Atado a la FICHA del paciente (`usuarioId: null`): no requiere usuario en Conectar — las cuentas de pacientes viven en Mi Diagnosticar (proyecto aparte) y se identifican por DNI. Solo exige DNI cargado.
- Links viejos conservan sus reglas (expiraEn / estado usado); la limpieza perezosa borra SOLO filas en estado "usado" (los permanentes viven en "pendiente" para siempre). Revocar = borrar la fila.
- `/auth/ingreso-magico` (login local Conectar) rechaza tokens con usuarioId null; la revocación por cambio de clave solo aplica a tokens con usuario.
- **How to apply:** en la auditoría de mensajes el token se enmascara antes de guardar el contenido; nada de DNI en URL/logs.
- El link también puede ir en el PRIMER mensaje vía la segunda plantilla de Meta con variable {{1}} (config `whaticket_template_link_id`); en texto libre sigue la ventana de 24 h.
- El link apunta al PORTAL del paciente (origin de APP_PACIENTE_PUSH_URL, helper urlBaseLinkIngreso; fallback a la URL local). El portal verifica servidor-a-servidor: POST /api/integraciones/app-paciente/autologin con Bearer APP_PACIENTE_PUSH_TOKEN y {codigo} → 200 {ok, dni, telefono, nombre, apellido} / 410 {ok:false, motivo}. Contrato confirmado con el portal; falta publicar Conectar y pasarles un código de prueba generado en la app publicada.

**Actualización (ago 2026):** los tokens atados solo a la ficha (usuarioId null) ya NO se rechazan en /auth/ingreso-magico: al canjearlos se auto-crea (o reutiliza) un usuario rol "paciente" con clave aleatoria inutilizable, así el link deja al paciente logueado en /mi-turno de esta misma app. La ficha debe estar activa.
