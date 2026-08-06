---
name: Pool de cuentas Klinicos
description: Varias credenciales del portal para sesiones paralelas y worker concurrente
---

Regla (02-ago-2026, pedido del usuario "para más velocidad"): el robot usa un pool de cuentas del portal Klinicos (secrets KLINICOS_USUARIO/_2/_3 con sus PASSWORD) para tener varias sesiones abiertas a la vez.

- Los logins rotan de cuenta (round-robin) salvo credencial explícita; el worker procesa trabajos en paralelo (tantos como cuentas) asignando una cuenta fija por posición de tanda, así dos cargas simultáneas nunca comparten usuario.
- En logs solo puede aparecer la etiqueta ("cuenta N"), jamás el usuario o clave reales.

**Why:** el portal invalida la sesión anterior del mismo usuario al reloguear; con una sola cuenta, operaciones simultáneas (u operadores humanos con la misma cuenta) se pisaban la sesión y aparecían timeouts/500 espurios.
**How to apply:** todo flujo nuevo que abra sesión debe pasar por el login central del robot (hereda la rotación); si necesita garantía de cuentas distintas en paralelo, pasar la credencial explícita del pool.
