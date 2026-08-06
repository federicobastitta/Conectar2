---
name: Usuarios por perfil y entorno dev vs prod
description: Por qué un usuario creado en dev no funciona en la app publicada y cómo arreglarlo
---

Dev y producción tienen bases de usuarios separadas: un usuario creado en dev (SQL o UI) no existe en la app publicada. Además, el api-server crea usuarios por defecto por perfil al arrancar (USUARIOS_POR_DEFECTO en routes/usuarios.ts), así que en prod el email puede YA existir con otra contraseña — el POST /api/usuarios da 500/409 y el login 401.

**How to apply:** si un login "no funciona" en la app publicada, verificar con executeSql(environment:"production") si el email ya existe, y resetear la contraseña vía `PATCH /api/usuarios/:id` de la app publicada con login admin (prod DB es read-only para el agente).
