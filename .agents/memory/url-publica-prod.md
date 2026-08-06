---
name: URL pública en producción
description: Por qué los QR de PDFs salían con el dominio .replit.app y cómo se fija el dominio propio
---

En producción `REPLIT_DOMAINS` lista primero el dominio `.replit.app` (clinic-core-suite.replit.app), no el dominio propio clinicadiagnosticar.com — `urlPublicaApp()` tomaba ese primer valor y los QR de órdenes/recetas/certificados salían con el dominio equivocado (ambos dominios sirven la misma app, así que los QR viejos siguen funcionando).

**Fix (ago 2026):** env var `URL_PUBLICA_APP=https://clinicadiagnosticar.com` en el entorno **production**; `urlPublicaApp()` la prioriza. Toma efecto recién al republicar.

**How to apply:** cualquier link "público" generado por el server (QR, links mágicos, push) debe pasar por `urlPublicaApp()`/`urlBaseLinkIngreso()`; nunca asumir que REPLIT_DOMAINS[0] es el dominio custom.
