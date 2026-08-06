---
name: Códigos efímeros en config_sistema
description: Patrón para códigos cortos temporales (vinculación de TVs) sin tabla nueva
---

Los códigos efímeros de vinculación (ej. TVs de sala de espera, prefijo `tv_vinculo_`) se guardan como filas JSON en `config_sistema`, no en una tabla propia.

**Why:** evita DDL nuevo (y el drift dev/prod pendiente) para datos que viven minutos; sobrevive reinicios y múltiples instancias, a diferencia de un Map en memoria.

**How to apply:** para cualquier código/token corto de vida breve, usar `config_sistema` con prefijo propio, TTL en el valor JSON, limpieza perezosa por `actualizado_en`, y consumo de una sola entrega (delete al leer la asignación).
