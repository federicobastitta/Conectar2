---
name: Protocolo bilateral alta complejidad
description: Órdenes de "ambas" articulaciones — ficha por lado, lado más doloroso, frase obligatoria
---

Regla clínica pedida por el usuario: en estudios de ambas articulaciones (ej. AMBAS RODILLAS) la ficha de síntomas se carga POR LADO, el médico marca cuál es la más dolorosa (obligatorio antes de emitir/vista previa), y la orden debe dejar explícito el lado más doloroso y que el otro lado presenta sus hallazgos positivos, cerrando con la idea exacta "descartar o establecer sobrecarga compensatoria o enfermedad bilateral" para articulaciones de carga (rodilla, cadera, tobillo/pie) y "descartar o establecer proceso degenerativo articular o enfermedad bilateral" para miembro superior (hombro, codo, muñeca/mano).

**Cómo se activa:** nombre de práctica con ambas/ambos/bilateral, o toggle manual "Sí, ambas" (el catálogo NO tiene prácticas bilaterales, así que el toggle es el camino real). Solo regiones articulares; excluye tomografía/doppler/columna completa.

**Detalles:** las maniobras viajan a la IA prefijadas por lado ("rodilla derecha: <definición>", género correcto: tobillo/codo/hombro → derecho); el payload incluye `bilateral:{region,ladoMasDoloroso}` (spec GenerarResumenHcInput); si la práctica no dice "ambas", el studyName sale con sufijo "(AMBAS)". Cambiar lado/maniobras/toggle invalida el resumenHc ya generado (si no, se emite texto viejo).

**Regla vigente:** nunca epónimos en pantalla ni en la orden — solo definiciones.
