---
name: Recuperación de clave sin mail
description: Flujo elegido para "olvidé mi contraseña" — dentro de la app, sin servicio de email
---
El usuario descartó conectar Resend/SendGrid: la recuperación NO manda mails.
**Cómo funciona:** POST /auth/olvide-clave (público, rate-limit 5/h por IP, tope 50 pendientes, siempre responde ok) deja un pedido en pedidos_recuperacion_clave; el admin ve un banner ámbar en AppLayout y asigna la clave nueva (revoca todas las sesiones) o descarta.
**Why:** sin integración de email no se puede enviar nada; quería que "las contraseñas se recuperen en mauro_inchausti@hotmail.com" — quedó pendiente si algún día conecta un servicio de mails.
**How to apply:** el matching pedido→usuario usa el MISMO criterio que el login (email exacto o local-part inequívoco); si se toca el login, mantener buscarUsuarioPorIdentificador en sincronía. Cambio de clave propio (POST /auth/cambiar-clave) revoca las demás sesiones y conserva la actual.
