---
name: Alephoo .xls exports encoding
description: Cómo parsear los exports .xls de Alephoo (HTML disfrazado) sin romper acentos
---
Los exports "Excel" de Alephoo son HTML disfrazado de .xls, con bytes NUL intercalados (pseudo UTF-16).

**Regla:** leer el archivo como `latin1` y hacer strip de `\u0000` antes de parsear. Leerlo como `utf-8` produce U+FFFD en todos los acentos (Pérez → P�rez) y corrompe sedes/especialidades/pacientes en cascada.

**Why:** una corrida con utf-8 creó entidades con nombres corruptos que hubo que limpiar por SQL antes de re-importar.

**How to apply:** cualquier importador de archivos Alephoo (`scripts/src/importar-turnos-detallados.ts` es la referencia). Otras convenciones del export: primer "DNI" = paciente y el segundo = médico; paciente viene "APELLIDO Nombre", médico viene "Nombre Apellido"; el detalle de duraciones se infiere del gap modal entre turnos y debe redondearse a valores clínicos (10/15/20/30/40/60).
