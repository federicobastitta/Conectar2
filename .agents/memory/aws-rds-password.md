---
name: Password RDS AWS rechazada
description: Qué pasó y cómo diagnosticar cuando la base AWS rechaza la contraseña de golpe
---

El 03-ago-2026 ~00:15 el RDS (usuario postgres) empezó a rechazar la contraseña de CLINICA_DB_URL/CLINICA_DEV_DB_URL sin que el usuario tocara nada — dev y prod cayeron a la vez. Causa probable: rotación automática de la contraseña (AWS Secrets Manager / managed password) o cambio hecho fuera de Replit.

**Cómo diagnosticar:** script node con pg que conecta con ambas URLs e imprime host/db/passLen; si ambas fallan con 28P01, el problema es del lado de AWS, no de los secretos mangled del sandbox.

**Cómo se arregla (ago 2026):** la clave vive ahora SOLO en el secreto CLINICA_DB_PASSWORD — todos los consumidores (clinica-url-resolver, lib/db, lib/clinica-db connection, alephoo-worker) pisan la contraseña embebida en la URL con ese secreto. Rotación futura = actualizar UN secreto y republicar. La URL puede llevar un placeholder (ROTADA) como contraseña.

**Trampas vistas en el incidente:**
- El cambio de contraseña maestra en RDS puede quedar agendado a la ventana de mantenimiento; forzarlo con Acciones → Reiniciar.
- El reboot del RDS cambió la IP pública; conexiones al hostname fallaban raro ("server does not support SSL" = se estaba hablando con OTRO servidor, p. ej. el Postgres local por URL rota) mientras el DNS propagaba.
- El usuario novato pisó el value de CLINICA_DB_URL con un string suelto → new URL() daba host vacío → pg conectaba a localhost. Si los errores mezclan "does not support SSL" + "password authentication failed", primero verificar la ESTRUCTURA de la URL (host/user/db) sin imprimir la clave.
- La opción "Administrar credenciales en Secrets Manager" de RDS rota la clave sola; se desactivó pasando a contraseña autoadministrada.
