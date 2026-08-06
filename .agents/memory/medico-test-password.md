---
name: Credencial de fixture del médico en dev
description: La suite de api-server depende de una clave fija del usuario médico de prueba; no resetearla.
---
Los tests de api-server (estudios_previos, integracion_estudios_previos) loguean al usuario médico por defecto con una contraseña de fixture propia, definida en esos archivos de test (distinta de la del seed de usuarios por defecto).

**Why:** Resetear la clave de ese usuario (p. ej. para pruebas e2e) rompe la validación completa con 401 en el login de los tests.

**How to apply:** Antes de cambiar la clave del usuario médico de prueba, mirar qué esperan los tests (constantes MEDICO_PASS en __tests__); si se cambia, restaurarla vía PATCH /api/usuarios con un usuario gestor antes de validar.
