---
name: Pruebas controladas en producción
description: Cómo montar y limpiar un escenario TEST vía la API de la app publicada sin tocar datos reales.
---

Regla: para verificar UI en la app publicada, montar un escenario TEST propio (profesional+turnera+paciente TEST) por API y limpiarlo al final; nunca operar sobre turnos de pacientes reales.

**Gotchas:**
- Gestión de usuarios (`/api/usuarios`) exige rol `admin` = perfiles **desarrollador/gerente**; el usuario "administracion" tiene rol recepcionista y recibe "No autorizado".
- El usuario demo medico@ está vinculado a un profesional REAL (`profesionalId=1`); relinkearlo a un profesional TEST y **restaurar a 1** al terminar. Su clave en prod puede diferir: resetear vía PATCH /api/usuarios.
- Admitir sin token pinta la marca naranja, que pisa el fondo de estado (rosa Atendido); quitarla con POST /turnos/:id/descolorear (gerencia) o recepcionar con token.
- Un turno con consulta finalizada (encounter) no se puede hard-DELETE (500); limpiarlo con PATCH estado:"cancelado".
- Limpieza: DELETE paciente (baja lógica), PATCH turnera activa:false, PATCH profesional activo:false.
- El tester Playwright puede navegar la URL publicada completa si se la das explícita.

**Why:** la fila rosa "Atendido" se verificó así en prod sin esperar a un médico real.

**Gotchas flujo consulta médico (verificado jul 2026):**
- Finalizar consulta solo cierra el turno (→ visto/Atendido) si está en estado de espera (arribo/llamado/en_sala/en_atencion); con "pendiente" la consulta se registra pero la fila queda "Reservado".
- PATCH /api/turnos/:id acepta el enum de UI (pendiente/confirmado/en_sala/atendido/cancelado/ausente), NO los estados internos (arribo/llamado): usar "en_sala" para armar el escenario.
- El médico NO ve controles de registro de turno ni botón llamar en fila "Reservado" en Mi agenda; crear el turno por API (POST /turnos como gerente) y pasarlo a en_sala.
- El tester no debe usar pasos [DB]: su base es la dev, no la AWS de prod; verificar datos vía la API publicada.

**Gotchas guardia presencial TEST (verificado ago 2026):**
- El build publicado puede ser MÁS NUEVO que el workspace de la tarea (campos extra en respuestas, guards distintos): verificar contra el comportamiento real de prod, no contra el código local, y no intentar "arreglar" prod desde un workspace desactualizado.
- Para probar flujos post-token sin quemar un token IOMA real: crear la sesión por API pública y simular la aceptación con SQL directo a conectar_app_prod (turno confirmado + sesión en_cola linkeada); después probar /llegue y llamado por la API publicada; limpiar cancelando turno + abandonando sesión.
- Un turno "confirmado" no aparece en sala-espera/cola (cola de admitidos) pero sí cuenta en infoFila — es por diseño, no un bug.

**Gotchas firma de planillas TEST (verificado jul 2026):**
- Circuito completo por API publicada: crear user TEST perfil medico_consulta_informante vinculado al profesional real → POST /consultorio/study-orders (usar studyType "laboratorio" para no encolar push al PACS) → /firmar → POST /consultorio/pdf/generate (sourceType "orden_estudio", no "study_order") → GET /consultorio/pdf/:id.
- El médico TEST no puede descargar el PDF de un paciente fuera de su alcance (403 puedeLeerPaciente); descargarlo con token admin — la firma se estampa igual porque depende de firma_estado, no del solicitante.
- Firmada = inmutable por API; limpiar borrando por SQL directo (AWS prod): pdf_documents, study_orders_firma_log (columna order_id), indicaciones_pacientes, study_orders; users+sesiones del user TEST.
