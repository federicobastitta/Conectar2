---
name: Prod app usa AWS, executeSql prod queda stale
description: Por qué las lecturas SQL de producción no reflejan lo que muestra la app publicada
---

La app publicada opera contra la base AWS (CLINICA_DB_URL); `executeSql(environment:"production")` sigue leyendo la base Replit de prod, que quedó desactualizada.

**Why:** al migrar los datos a AWS (julio 2026), un PATCH vía la API publicada devolvió 200 y persistió, pero el SELECT por executeSql prod siguió mostrando el valor viejo — dos bases distintas.

**How to apply:** para verificar o modificar datos de producción: (a) la API publicada (login admin contra la URL .replit.app), o (b) SQL directo con node pg desde artifacts/api-server usando CLINICA_DB_URL con el path cambiado a `/conectar_app_prod` (el path default /postgres NO es la base de la app; también existe /conectar_app_dev). Tratar executeSql prod solo como referencia histórica. Ojo también con el replay determinístico del sandbox: repetir la misma query idéntica devuelve el resultado cacheado; variar la query para forzar lectura fresca.

**Acceso SQL directo a prod (ago 2026):** la password embebida en CLINICA_DB_URL quedó vieja; conectar con esa URL pero reemplazando la password por CLINICA_DB_PASSWORD y base `conectar_app_prod` (la URL apunta a `/postgres`, que NO es la base de la app). Ejecutar psql desde node (spawn) para que bash no mangle el secret.
