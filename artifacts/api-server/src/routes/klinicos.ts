import { Router, type IRouter, type Request, type Response } from "express";
import { desc, eq, sql } from "drizzle-orm";
import {
  db,
  configSistemaTable,
  klinicosTrabajos,
  klinicosReglasSector,
  klinicosReglasPractica,
  klinicosReglasCie10,
  klinicosPracticas,
  klinicosPrescriptores,
  klinicosEqEspecialidades,
  especialidadesTable,
  pacientesTable,
  profesionalesTable,
  turnosTable,
} from "@workspace/db";
import {
  CreateKlinicosConsultaEspejoBody,
  UpdateKlinicosTrabajoBody,
  UpsertKlinicosReglaSectorBody,
  UpsertKlinicosEqEspecialidadBody,
  CreateKlinicosReglaPracticaBody,
  UpdateKlinicosReglaPracticaBody,
  CreateKlinicosReglaCie10Body,
  UpdateKlinicosReglaCie10Body,
  CreateKlinicosPracticaBody,
  UpdateKlinicosPracticaBody,
  CreateKlinicosPrescriptorBody,
  UpdateKlinicosPrescriptorBody,
} from "@workspace/api-zod";
import { requireRol } from "./auth";
import { klinicosHabilitado, klinicosDryRun } from "../integraciones/klinicos-robot";
import { invalidarCacheReglasSector, autoencoladoKlinicosActivo, invalidarCacheAutoencolado } from "../integraciones/klinicos-cola";
import { elegirProfesionalIngreso } from "../lib/seed-profesionales-ingreso";
import { generarInformeFacturacion, procesarTrabajo, ejecutarTrabajoAprobado, klinicosModo } from "../integraciones/klinicos-worker";
import { generarPdfDocumento } from "../pdf/documento_pdf";
import { ObjectStorageService, objectStorageClient, ObjectNotFoundError } from "../lib/objectStorage";
import { Readable } from "stream";

const objectStorage = new ObjectStorageService();

const router: IRouter = Router();

const soloStaff = requireRol("admin", "recepcionista", "medico");
const soloAdmin = requireRol("admin");

router.use("/integraciones/klinicos", soloStaff);

// ── Bandeja de trabajos ────────────────────────────────────────────────────

router.get("/integraciones/klinicos/trabajos", async (req: Request, res: Response): Promise<void> => {
  const estado = typeof req.query.estado === "string" ? req.query.estado : undefined;
  const rows = await db
    .select({
      trabajo: klinicosTrabajos,
      pacienteNombre: sql<string | null>`${pacientesTable.apellido} || ', ' || ${pacientesTable.nombre}`,
    })
    .from(klinicosTrabajos)
    .leftJoin(pacientesTable, eq(klinicosTrabajos.pacienteId, pacientesTable.id))
    .where(estado ? eq(klinicosTrabajos.estado, estado) : undefined)
    .orderBy(desc(klinicosTrabajos.creadoEn))
    .limit(200);
  res.json(rows.map((r) => ({ ...r.trabajo, pacienteNombre: r.pacienteNombre })));
});

router.patch("/integraciones/klinicos/trabajos/:id", async (req: Request, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  const parsed = UpdateKlinicosTrabajoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos", detalles: parsed.error.issues });
    return;
  }
  const body = parsed.data;
  const [t] = await db
    .select({ estado: klinicosTrabajos.estado })
    .from(klinicosTrabajos)
    .where(eq(klinicosTrabajos.id, id))
    .limit(1);
  if (!t) {
    res.status(404).json({ error: "Trabajo no encontrado" });
    return;
  }
  // Máquina de estados: solo se editan/cancelan trabajos que el robot todavía
  // no ejecutó. "pendiente" vía PATCH está prohibido (usar /reintentar); un
  // trabajo completado es inmutable para no duplicar ingresos en Klinicos.
  if (body.estado === "pendiente") {
    res.status(422).json({ error: "Para reencolar usá el endpoint de reintentar" });
    return;
  }
  if (!["pendiente", "error", "esperando_aprobacion"].includes(t.estado)) {
    res.status(422).json({ error: `No se puede editar un trabajo en estado ${t.estado}` });
    return;
  }
  // Condición de estado en el WHERE: si el worker lo tomó en el medio, no pisamos.
  const [updated] = await db
    .update(klinicosTrabajos)
    .set({
      // Editar un trabajo que esperaba aprobación invalida su simulación: el
      // trabajo vuelve a la cola para re-simular con los datos corregidos.
      ...(t.estado === "esperando_aprobacion" && body.estado === undefined
        ? { estado: "pendiente", intentos: 0, simulacionPayload: null, simulacionEn: null }
        : {}),
      ...(body.consultaPor !== undefined ? { consultaPor: body.consultaPor } : {}),
      ...(body.cie10Codigo !== undefined ? { cie10Codigo: body.cie10Codigo } : {}),
      ...(body.cie10Descripcion !== undefined ? { cie10Descripcion: body.cie10Descripcion } : {}),
      ...(body.practicaCodigos !== undefined ? { practicaCodigos: body.practicaCodigos } : {}),
      ...(body.efectorNombre !== undefined ? { efectorNombre: body.efectorNombre } : {}),
      ...(body.prescriptorNombre !== undefined ? { prescriptorNombre: body.prescriptorNombre } : {}),
      ...(body.tokenAutorizacion !== undefined ? { tokenAutorizacion: body.tokenAutorizacion } : {}),
      ...(body.sectorServicio !== undefined ? { sectorServicio: body.sectorServicio } : {}),
      ...(body.estado !== undefined ? { estado: body.estado } : {}),
    })
    .where(sql`${klinicosTrabajos.id} = ${id} AND ${klinicosTrabajos.estado} IN ('pendiente', 'error', 'esperando_aprobacion')`)
    .returning();
  if (!updated) {
    res.status(409).json({ error: "El trabajo cambió de estado, refrescá la bandeja" });
    return;
  }
  req.log.info({ trabajoId: id }, "klinicos: trabajo editado desde la bandeja");
  res.json({ ...updated, pacienteNombre: null });
});

router.post("/integraciones/klinicos/trabajos/:id/reintentar", async (req: Request, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  const [updated] = await db
    .update(klinicosTrabajos)
    .set({ estado: "pendiente", intentos: 0, ultimoError: null })
    .where(sql`${klinicosTrabajos.id} = ${id} AND ${klinicosTrabajos.estado} IN ('error', 'cancelado')`)
    .returning();
  if (!updated) {
    res.status(422).json({ error: "Solo se pueden reintentar trabajos en error o cancelados" });
    return;
  }
  req.log.info({ trabajoId: id }, "klinicos: trabajo reencolado");
  // Reintento manual: se procesa al instante en segundo plano, sin esperar
  // al próximo ciclo del worker. El claim atómico evita doble procesado.
  void procesarTrabajo(id).catch((err) =>
    req.log.error({ err, trabajoId: id }, "klinicos: fallo el procesado inmediato del reintento"),
  );
  res.json({ ...updated, pacienteNombre: null });
});

// ── Validación espejo de token de consulta (Clínica Médica) ───────────────
// El paciente se presenta en recepción solo con el DNI + token: se encola un
// trabajo de consulta de CLINICA MEDICA con el profesional configurado para
// la especialidad (regla 01/08/2026: siempre "SAEZ, IGNACIO").
// El robot crea el ingreso (la prestación CONSULTA se autogenera) y valida el
// token inline en la grilla de prestaciones.
router.post("/integraciones/klinicos/consultas-espejo", async (req: Request, res: Response): Promise<void> => {
  const parsed = CreateKlinicosConsultaEspejoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos", detalles: parsed.error.issues });
    return;
  }
  const dni = parsed.data.dni.trim();
  const token = parsed.data.token.trim();
  // Revalidar DESPUÉS del trim: un token de espacios pasa el minLength del
  // schema pero queda vacío al normalizar.
  if (dni.length < 6 || token.length < 4) {
    res.status(400).json({ error: "DNI o token demasiado cortos" });
    return;
  }

  const [paciente] = await db
    .select()
    .from(pacientesTable)
    .where(sql`${pacientesTable.dni} = ${dni} AND ${pacientesTable.activo} = true`)
    .limit(1);
  if (!paciente) {
    res.status(404).json({ error: `No hay paciente activo con DNI ${dni} en Conectar. Cargá la ficha primero.` });
    return;
  }

  const ESPECIALIDAD = "CLINICA MEDICA";
  const profesional = await elegirProfesionalIngreso(ESPECIALIDAD).catch((err: unknown) => {
    req.log.error({ err }, "consultas-espejo: fallo la rotación de profesional");
    return null;
  });
  if (!profesional) {
    res.status(422).json({ error: "No hay médicos activos en el listado de profesionales de ingreso de Clínica Médica" });
    return;
  }

  // Anti-duplicado atómico: lock advisory por paciente+token dentro de la
  // transacción, así dos recepcionistas cargando el mismo token a la vez no
  // insertan dos trabajos (uno recibe 409).
  let duplicado: { id: number; estado: string } | null = null;
  const [trabajo] = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`consulta-espejo:${paciente.id}:${token}`}))`);
    const [existente] = await tx
      .select({ id: klinicosTrabajos.id, estado: klinicosTrabajos.estado })
      .from(klinicosTrabajos)
      .where(
        sql`${klinicosTrabajos.pacienteId} = ${paciente.id} AND ${klinicosTrabajos.tokenAutorizacion} = ${token} AND ${klinicosTrabajos.estado} NOT IN ('cancelado', 'error')`,
      )
      .limit(1);
    if (existente) {
      duplicado = existente;
      return [];
    }
    return tx
      .insert(klinicosTrabajos)
      .values({
        pacienteId: paciente.id,
        turnoId: null,
        dni,
        sexo: paciente.sexo ?? null,
        celular: paciente.telefono ?? paciente.telefonoAlternativo ?? null,
        especialidad: ESPECIALIDAD,
        motivo: "Consulta clínica médica (validación espejo desde recepción)",
        sectorServicio: "CONSULTORIO",
        profesionalKlinicos: profesional,
        tokenAutorizacion: token,
      })
      .returning();
  });
  if (duplicado) {
    const d = duplicado as { id: number; estado: string };
    res.status(409).json({ error: `Ya existe el trabajo #${d.id} (${d.estado}) para ese paciente y token` });
    return;
  }

  req.log.info(
    { trabajoId: trabajo.id, pacienteId: paciente.id, profesional },
    "consultas-espejo: trabajo de consulta encolado",
  );
  // Se procesa al toque en segundo plano (el paciente está esperando en el
  // mostrador); el claim atómico del worker evita doble procesado.
  void procesarTrabajo(trabajo.id).catch((err) =>
    req.log.error({ err, trabajoId: trabajo.id }, "consultas-espejo: fallo el procesado inmediato"),
  );
  res.status(201).json({ ...trabajo, pacienteNombre: `${paciente.apellido}, ${paciente.nombre}` });
});

// ── Etapa 4 (modo asistido): aprobación humana de la carga real ─────────────
// El operador revisa el payload simulado en la bandeja y aprueba la ejecución
// real caso por caso. El claim atómico esperando_aprobacion → en_proceso
// registra quién aprobó y evita doble ejecución concurrente.
router.post("/integraciones/klinicos/trabajos/:id/aprobar", async (req: Request, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (!klinicosHabilitado()) {
    res.status(422).json({ error: "El robot Klinicos no está habilitado (faltan KLINICOS_USUARIO / KLINICOS_PASSWORD)" });
    return;
  }
  if (klinicosDryRun()) {
    res.status(422).json({ error: "KLINICOS_DRY_RUN está activo: el entorno bloquea la ejecución real" });
    return;
  }
  const user = res.locals.user as { email?: string } | undefined;
  // No se aprueba la carga de un turno que ya fue cancelado: el trabajo se
  // cancela acá mismo para que la bandeja quede consistente.
  const [conTurno] = await db
    .select({ turnoEstado: turnosTable.estado, turnoId: klinicosTrabajos.turnoId })
    .from(klinicosTrabajos)
    .leftJoin(turnosTable, sql`${turnosTable.id} = ${klinicosTrabajos.turnoId}`)
    .where(sql`${klinicosTrabajos.id} = ${id}`)
    .limit(1);
  if (conTurno?.turnoId != null && (conTurno.turnoEstado == null || ["cancelado", "anulado", "a_reprogramar"].includes(conTurno.turnoEstado))) {
    await db
      .update(klinicosTrabajos)
      .set({ estado: "cancelado", ultimoError: "El turno fue cancelado antes de la carga" })
      .where(sql`${klinicosTrabajos.id} = ${id} AND ${klinicosTrabajos.estado} = 'esperando_aprobacion'`);
    res.status(422).json({ error: "El turno de este trabajo fue cancelado: no corresponde cargarlo (el trabajo quedó cancelado)" });
    return;
  }
  const [updated] = await db
    .update(klinicosTrabajos)
    .set({ estado: "en_proceso", aprobadoPor: user?.email ?? "desconocido", aprobadoEn: new Date() })
    .where(sql`${klinicosTrabajos.id} = ${id} AND ${klinicosTrabajos.estado} = 'esperando_aprobacion'`)
    .returning();
  if (!updated) {
    res.status(422).json({ error: "Solo se pueden aprobar trabajos esperando aprobación (refrescá la bandeja)" });
    return;
  }
  req.log.info({ trabajoId: id, aprobadoPor: updated.aprobadoPor }, "klinicos: carga real aprobada por el operador");
  // La ejecución real corre en segundo plano; la bandeja se actualiza por polling.
  void ejecutarTrabajoAprobado(id).catch((err) =>
    req.log.error({ err, trabajoId: id }, "klinicos: falló la ejecución real aprobada"),
  );
  res.json({ ...updated, pacienteNombre: null });
});

// Rechazo del operador: el trabajo queda cancelado (para corregir datos y
// re-simular, usar el botón Revisar, que reencola automáticamente).
router.post("/integraciones/klinicos/trabajos/:id/rechazar", async (req: Request, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  const motivo = typeof (req.body as { motivo?: unknown })?.motivo === "string" ? (req.body as { motivo: string }).motivo.trim() : "";
  const user = res.locals.user as { email?: string } | undefined;
  const [updated] = await db
    .update(klinicosTrabajos)
    .set({ estado: "cancelado", ultimoError: `Rechazado por ${user?.email ?? "operador"}${motivo ? `: ${motivo}` : ""}` })
    .where(sql`${klinicosTrabajos.id} = ${id} AND ${klinicosTrabajos.estado} = 'esperando_aprobacion'`)
    .returning();
  if (!updated) {
    res.status(422).json({ error: "Solo se pueden rechazar trabajos esperando aprobación" });
    return;
  }
  req.log.info({ trabajoId: id }, "klinicos: carga real rechazada por el operador");
  res.json({ ...updated, pacienteNombre: null });
});

// ── Informe de facturación (IA) ────────────────────────────────────────────
// Versión burocrática para el circuito de la obra social; NO es el informe
// médico real. Se regenera a demanda y se baja como PDF firmado con la firma
// escaneada del médico (matcheado contra el efector/profesional del trabajo).

router.post(
  "/integraciones/klinicos/trabajos/:id/informe/regenerar",
  async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "id inválido" }); return; }
    const texto = await generarInformeFacturacion(id);
    if (!texto) {
      res.status(422).json({ error: "No se pudo generar el informe (trabajo inexistente o fallo de IA)" });
      return;
    }
    req.log.info({ trabajoId: id }, "klinicos: informe de facturación regenerado");
    res.json({ informeIaTexto: texto });
  },
);

function normalizarNombre(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
}

// Nombre de archivo = apellido del paciente (pedido del cliente).
function nombreArchivoInforme(apellido: string | null | undefined, dni: string, ext: string): string {
  const base = (apellido ?? "").trim() || dni;
  const limpio = normalizarNombre(base).replace(/[^A-Z0-9ÑÜ ]/gi, "").replace(/\s+/g, "_");
  return `${limpio || "PACIENTE"}.${ext}`;
}

type PdfArmado =
  | { ok: true; doc: PDFKit.PDFDocument; apellido: string | null; dni: string }
  | { ok: false; status: number; error: string };

async function armarPdfInforme(id: number): Promise<PdfArmado> {
  const [trabajo] = await db.select().from(klinicosTrabajos).where(eq(klinicosTrabajos.id, id)).limit(1);
  if (!trabajo) return { ok: false, status: 404, error: "Trabajo no encontrado" };
  if (!trabajo.informeIaTexto) {
    return { ok: false, status: 422, error: "El trabajo todavía no tiene informe generado" };
  }

  const [paciente] = trabajo.pacienteId
    ? await db.select().from(pacientesTable).where(eq(pacientesTable.id, trabajo.pacienteId)).limit(1)
    : [undefined];

  // Médico firmante: el efector del trabajo (o el profesional Klinicos),
  // matcheado por nombre contra los profesionales locales para traer
  // matrícula y firma escaneada.
  const candidatos = [trabajo.efectorNombre, trabajo.profesionalKlinicos].filter(
    (v): v is string => Boolean(v),
  );
  const profesionales = await db.select().from(profesionalesTable).where(eq(profesionalesTable.activo, true));
  const firmante = profesionales.find((p) => {
    const full = normalizarNombre(`${p.apellido ?? ""} ${p.nombre}`);
    return candidatos.some((c) => {
      const cn = normalizarNombre(c);
      return cn.includes(normalizarNombre(p.apellido ?? p.nombre)) || full.includes(cn) || cn.includes(full);
    });
  });

  const doc = generarPdfDocumento({
    titulo: "Informe de estudio",
    tipoDocumento: "informe",
    paciente: {
      nombre: paciente?.nombre ?? "",
      apellido: paciente?.apellido ?? "",
      dni: paciente?.dni ?? trabajo.dni,
      cobertura: paciente?.cobertura ?? null,
    },
    profesional: firmante
      ? {
          id: firmante.id,
          nombre: firmante.nombre,
          apellido: firmante.apellido,
          matricula: firmante.matricula,
          firmaImagen: firmante.firmaImagen,
          caligrafia: firmante.caligrafia,
        }
      : { nombre: trabajo.efectorNombre ?? trabajo.profesionalKlinicos ?? "Profesional", apellido: null, matricula: null },
    fechaEmision: trabajo.informeIaGeneradoEn ?? new Date(),
    campos: [{ etiqueta: "Estudio", valor: trabajo.especialidad }],
    cuerpo: trabajo.informeIaTexto,
  });

  return { ok: true, doc, apellido: paciente?.apellido ?? null, dni: paciente?.dni ?? trabajo.dni };
}

router.get(
  "/integraciones/klinicos/trabajos/:id/informe-pdf",
  async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "id inválido" }); return; }
    const armado = await armarPdfInforme(id);
    if (!armado.ok) { res.status(armado.status).json({ error: armado.error }); return; }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${nombreArchivoInforme(armado.apellido, armado.dni, "pdf")}"`,
    );
    armado.doc.pipe(res);
    armado.doc.end();
  },
);

// ── PDF del informe en la nube (App Storage) ───────────────────────────────
// El circuito requiere subir un PDF a Klinicos: guardamos en el bucket
// nuestro PDF generado (con firma) o un PDF/captura subido a mano.

function pdfABuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

router.post(
  "/integraciones/klinicos/trabajos/:id/informe-pdf/guardar",
  async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "id inválido" }); return; }
    const armado = await armarPdfInforme(id);
    if (!armado.ok) { res.status(armado.status).json({ error: armado.error }); return; }

    const buffer = await pdfABuffer(armado.doc);
    const nombre = nombreArchivoInforme(armado.apellido, armado.dni, "pdf");

    const privateDir = objectStorage.getPrivateObjectDir().replace(/\/$/, "");
    const entityId = `uploads/informes-klinicos/${id}/${nombre}`;
    const fullPath = `${privateDir}/${entityId}`;
    const partes = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
    const bucketName = partes[0] ?? "";
    const objectName = partes.slice(1).join("/");
    await objectStorageClient
      .bucket(bucketName)
      .file(objectName)
      .save(buffer, { contentType: "application/pdf" });

    const objectPath = `/objects/${entityId}`;
    const [updated] = await db
      .update(klinicosTrabajos)
      .set({
        informePdfPath: objectPath,
        informePdfNombre: nombre,
        informePdfOrigen: "generado",
        informePdfSubidoEn: new Date(),
      })
      .where(eq(klinicosTrabajos.id, id))
      .returning();
    req.log.info({ trabajoId: id, objectPath }, "klinicos: informe PDF guardado en la nube");
    res.json({ ...updated, pacienteNombre: null });
  },
);

router.put(
  "/integraciones/klinicos/trabajos/:id/informe-archivo",
  async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "id inválido" }); return; }
    const objectPathRaw = typeof req.body?.objectPath === "string" ? req.body.objectPath : "";
    const contentType = typeof req.body?.contentType === "string" ? req.body.contentType : "application/pdf";
    if (!objectPathRaw) { res.status(400).json({ error: "objectPath requerido" }); return; }
    if (!["application/pdf", "image/png", "image/jpeg"].includes(contentType)) {
      res.status(422).json({ error: "Solo se aceptan PDF o imágenes PNG/JPG" });
      return;
    }

    const objectPath = objectStorage.normalizeObjectEntityPath(objectPathRaw);
    if (!objectPath.startsWith("/objects/uploads/")) {
      res.status(400).json({ error: "objectPath inválido" });
      return;
    }
    // Verificar que el archivo realmente exista en el bucket
    try {
      await objectStorage.getObjectEntityFile(objectPath);
    } catch (e) {
      if (e instanceof ObjectNotFoundError) {
        res.status(422).json({ error: "El archivo no se terminó de subir, probá de nuevo" });
        return;
      }
      throw e;
    }

    const [trabajo] = await db.select().from(klinicosTrabajos).where(eq(klinicosTrabajos.id, id)).limit(1);
    if (!trabajo) { res.status(404).json({ error: "Trabajo no encontrado" }); return; }
    const [paciente] = trabajo.pacienteId
      ? await db.select().from(pacientesTable).where(eq(pacientesTable.id, trabajo.pacienteId)).limit(1)
      : [undefined];
    const ext = contentType === "application/pdf" ? "pdf" : contentType === "image/png" ? "png" : "jpg";
    const nombre = nombreArchivoInforme(paciente?.apellido, paciente?.dni ?? trabajo.dni, ext);

    const [updated] = await db
      .update(klinicosTrabajos)
      .set({
        informePdfPath: objectPath,
        informePdfNombre: nombre,
        informePdfOrigen: "subido",
        informePdfSubidoEn: new Date(),
      })
      .where(eq(klinicosTrabajos.id, id))
      .returning();
    req.log.info({ trabajoId: id, objectPath }, "klinicos: informe adjuntado desde archivo subido");
    res.json({ ...updated, pacienteNombre: null });
  },
);

router.get(
  "/integraciones/klinicos/trabajos/:id/informe-archivo",
  async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "id inválido" }); return; }
    const [trabajo] = await db.select().from(klinicosTrabajos).where(eq(klinicosTrabajos.id, id)).limit(1);
    if (!trabajo) { res.status(404).json({ error: "Trabajo no encontrado" }); return; }
    if (!trabajo.informePdfPath) {
      res.status(404).json({ error: "El trabajo no tiene archivo de informe guardado" });
      return;
    }
    try {
      const file = await objectStorage.getObjectEntityFile(trabajo.informePdfPath);
      const response = await objectStorage.downloadObject(file);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${trabajo.informePdfNombre ?? `informe-${id}.pdf`}"`,
      );
      if (response.body) {
        Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
      } else {
        res.end();
      }
    } catch (e) {
      if (e instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "El archivo ya no está en el almacenamiento" });
        return;
      }
      throw e;
    }
  },
);

router.get("/integraciones/klinicos/estado", async (_req: Request, res: Response): Promise<void> => {
  const [counts] = await db
    .select({
      pendientes: sql<number>`count(*) FILTER (WHERE estado = 'pendiente')::int`,
      enProceso: sql<number>`count(*) FILTER (WHERE estado = 'en_proceso')::int`,
      esperandoAprobacion: sql<number>`count(*) FILTER (WHERE estado = 'esperando_aprobacion')::int`,
      completados: sql<number>`count(*) FILTER (WHERE estado = 'completado')::int`,
      errores: sql<number>`count(*) FILTER (WHERE estado = 'error')::int`,
    })
    .from(klinicosTrabajos);
  res.json({
    habilitado: klinicosHabilitado(),
    dryRun: klinicosDryRun(),
    modo: klinicosModo(),
    pendientes: counts?.pendientes ?? 0,
    enProceso: counts?.enProceso ?? 0,
    esperandoAprobacion: counts?.esperandoAprobacion ?? 0,
    completados: counts?.completados ?? 0,
    errores: counts?.errores ?? 0,
  });
});

// ── Catálogo: reglas de sector ─────────────────────────────────────────────

router.get("/integraciones/klinicos/reglas-sector", async (_req: Request, res: Response): Promise<void> => {
  const rows = await db.select().from(klinicosReglasSector).orderBy(klinicosReglasSector.especialidad);
  res.json(rows);
});

router.post(
  "/integraciones/klinicos/reglas-sector",
  soloAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = UpsertKlinicosReglaSectorBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Datos inválidos", detalles: parsed.error.issues });
      return;
    }
    const { especialidad, sectorServicio, activo } = parsed.data;
    const [row] = await db
      .insert(klinicosReglasSector)
      .values({ especialidad, sectorServicio, activo: activo ?? true })
      .onConflictDoUpdate({
        target: klinicosReglasSector.especialidad,
        set: { sectorServicio, activo: activo ?? true },
      })
      .returning();
    invalidarCacheReglasSector();
    res.json(row);
  },
);

// ── Llave de envíos automáticos a Klinicos ──────────────────────────────────

router.get("/integraciones/klinicos/autoencolado", async (_req: Request, res: Response): Promise<void> => {
  res.json({ activo: await autoencoladoKlinicosActivo() });
});

router.put(
  "/integraciones/klinicos/autoencolado",
  soloAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const activo = (req.body as { activo?: unknown })?.activo;
    if (typeof activo !== "boolean") {
      res.status(400).json({ error: "Falta el campo activo (true/false)" });
      return;
    }
    await db
      .insert(configSistemaTable)
      .values({ clave: "klinicos_autoencolado", valor: activo ? "on" : "off" })
      .onConflictDoUpdate({
        target: configSistemaTable.clave,
        set: { valor: activo ? "on" : "off", actualizadoEn: new Date() },
      });
    invalidarCacheAutoencolado();
    req.log.info({ activo }, "klinicos: envíos automáticos " + (activo ? "prendidos" : "apagados"));
    res.json({ activo });
  },
);

// ── Equivalencias: especialidad propia → especialidad Klinicos ─────────────

router.get("/integraciones/klinicos/eq-especialidades", async (_req: Request, res: Response): Promise<void> => {
  const rows = await db
    .select({
      id: klinicosEqEspecialidades.id,
      especialidadId: klinicosEqEspecialidades.especialidadId,
      especialidadNombre: especialidadesTable.nombre,
      klinicosEspecialidad: klinicosEqEspecialidades.klinicosEspecialidad,
      activo: klinicosEqEspecialidades.activo,
    })
    .from(klinicosEqEspecialidades)
    .leftJoin(especialidadesTable, eq(klinicosEqEspecialidades.especialidadId, especialidadesTable.id))
    .orderBy(especialidadesTable.nombre);
  res.json(rows);
});

router.post(
  "/integraciones/klinicos/eq-especialidades",
  soloAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = UpsertKlinicosEqEspecialidadBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Datos inválidos", detalles: parsed.error.issues });
      return;
    }
    const { especialidadId, activo } = parsed.data;
    const klinicosEspecialidad = parsed.data.klinicosEspecialidad.trim();
    if (!klinicosEspecialidad) {
      res.status(400).json({ error: "El nombre en Klinicos no puede estar vacío" });
      return;
    }
    const [esp] = await db
      .select({ id: especialidadesTable.id, nombre: especialidadesTable.nombre })
      .from(especialidadesTable)
      .where(eq(especialidadesTable.id, especialidadId))
      .limit(1);
    if (!esp) {
      res.status(404).json({ error: "Especialidad inexistente" });
      return;
    }
    const [row] = await db
      .insert(klinicosEqEspecialidades)
      .values({ especialidadId, klinicosEspecialidad, activo: activo ?? true })
      .onConflictDoUpdate({
        target: klinicosEqEspecialidades.especialidadId,
        set: {
          klinicosEspecialidad,
          // si no se manda "activo", se preserva el estado actual de la fila
          ...(activo === undefined ? {} : { activo }),
          actualizadoEn: new Date(),
        },
      })
      .returning();
    res.json({ ...row, especialidadNombre: esp.nombre });
  },
);

// ── Reglas de equivalencia: especialidad → práctica ────────────────────────

router.get("/integraciones/klinicos/reglas-practica", async (_req: Request, res: Response): Promise<void> => {
  const rows = await db
    .select()
    .from(klinicosReglasPractica)
    .orderBy(desc(klinicosReglasPractica.prioridad), klinicosReglasPractica.especialidad);
  res.json(rows);
});

router.post(
  "/integraciones/klinicos/reglas-practica",
  soloAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateKlinicosReglaPracticaBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Datos inválidos", detalles: parsed.error.issues });
      return;
    }
    const [practica] = await db
      .select({ id: klinicosPracticas.id })
      .from(klinicosPracticas)
      .where(eq(klinicosPracticas.id, parsed.data.practicaId))
      .limit(1);
    if (!practica) {
      res.status(422).json({ error: "La práctica indicada no existe" });
      return;
    }
    const [row] = await db.insert(klinicosReglasPractica).values(parsed.data).returning();
    res.status(201).json(row);
  },
);

router.patch(
  "/integraciones/klinicos/reglas-practica/:id",
  soloAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params.id);
    const parsed = UpdateKlinicosReglaPracticaBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Datos inválidos", detalles: parsed.error.issues });
      return;
    }
    const [row] = await db.update(klinicosReglasPractica).set(parsed.data).where(eq(klinicosReglasPractica.id, id)).returning();
    if (!row) {
      res.status(404).json({ error: "Regla no encontrada" });
      return;
    }
    res.json(row);
  },
);

router.delete(
  "/integraciones/klinicos/reglas-practica/:id",
  soloAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params.id);
    const [row] = await db.delete(klinicosReglasPractica).where(eq(klinicosReglasPractica.id, id)).returning({ id: klinicosReglasPractica.id });
    if (!row) {
      res.status(404).json({ error: "Regla no encontrada" });
      return;
    }
    res.status(204).end();
  },
);

// ── Reglas de equivalencia: motivo → CIE-10 ────────────────────────────────

router.get("/integraciones/klinicos/reglas-cie10", async (_req: Request, res: Response): Promise<void> => {
  const rows = await db
    .select()
    .from(klinicosReglasCie10)
    .orderBy(desc(klinicosReglasCie10.prioridad), klinicosReglasCie10.patron);
  res.json(rows);
});

router.post(
  "/integraciones/klinicos/reglas-cie10",
  soloAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateKlinicosReglaCie10Body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Datos inválidos", detalles: parsed.error.issues });
      return;
    }
    const [row] = await db.insert(klinicosReglasCie10).values(parsed.data).returning();
    res.status(201).json(row);
  },
);

router.patch(
  "/integraciones/klinicos/reglas-cie10/:id",
  soloAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params.id);
    const parsed = UpdateKlinicosReglaCie10Body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Datos inválidos", detalles: parsed.error.issues });
      return;
    }
    const [row] = await db.update(klinicosReglasCie10).set(parsed.data).where(eq(klinicosReglasCie10.id, id)).returning();
    if (!row) {
      res.status(404).json({ error: "Regla no encontrada" });
      return;
    }
    res.json(row);
  },
);

router.delete(
  "/integraciones/klinicos/reglas-cie10/:id",
  soloAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params.id);
    const [row] = await db.delete(klinicosReglasCie10).where(eq(klinicosReglasCie10.id, id)).returning({ id: klinicosReglasCie10.id });
    if (!row) {
      res.status(404).json({ error: "Regla no encontrada" });
      return;
    }
    res.status(204).end();
  },
);

// ── Catálogo: prácticas / códigos IOMA ─────────────────────────────────────

router.get("/integraciones/klinicos/practicas", async (_req: Request, res: Response): Promise<void> => {
  const rows = await db.select().from(klinicosPracticas).orderBy(klinicosPracticas.categoria, klinicosPracticas.nombre);
  res.json(rows);
});

router.post(
  "/integraciones/klinicos/practicas",
  soloAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateKlinicosPracticaBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Datos inválidos", detalles: parsed.error.issues });
      return;
    }
    const [row] = await db.insert(klinicosPracticas).values(parsed.data).returning();
    res.status(201).json(row);
  },
);

router.patch(
  "/integraciones/klinicos/practicas/:id",
  soloAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params.id);
    const parsed = UpdateKlinicosPracticaBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Datos inválidos", detalles: parsed.error.issues });
      return;
    }
    const [row] = await db.update(klinicosPracticas).set(parsed.data).where(eq(klinicosPracticas.id, id)).returning();
    if (!row) {
      res.status(404).json({ error: "Práctica no encontrada" });
      return;
    }
    res.json(row);
  },
);

// ── Catálogo: prescriptores (rotación del robot) ───────────────────────────

router.get("/integraciones/klinicos/prescriptores", async (_req: Request, res: Response): Promise<void> => {
  const rows = await db.select().from(klinicosPrescriptores).orderBy(klinicosPrescriptores.nombre);
  res.json(rows);
});

router.post(
  "/integraciones/klinicos/prescriptores",
  soloAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateKlinicosPrescriptorBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Datos inválidos", detalles: parsed.error.issues });
      return;
    }
    try {
      const [row] = await db.insert(klinicosPrescriptores).values(parsed.data).returning();
      res.status(201).json(row);
    } catch (err) {
      const pgCode =
        err && typeof err === "object"
          ? ((err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code)
          : undefined;
      if (pgCode === "23505") {
        res.status(409).json({ error: "Ya existe un prescriptor con ese nombre" });
        return;
      }
      throw err;
    }
  },
);

router.patch(
  "/integraciones/klinicos/prescriptores/:id",
  soloAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params.id);
    const parsed = UpdateKlinicosPrescriptorBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Datos inválidos", detalles: parsed.error.issues });
      return;
    }
    try {
      const [row] = await db
        .update(klinicosPrescriptores)
        .set(parsed.data)
        .where(eq(klinicosPrescriptores.id, id))
        .returning();
      if (!row) {
        res.status(404).json({ error: "Prescriptor no encontrado" });
        return;
      }
      res.json(row);
    } catch (err) {
      const pgCode =
        err && typeof err === "object"
          ? ((err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code)
          : undefined;
      if (pgCode === "23505") {
        res.status(409).json({ error: "Ya existe un prescriptor con ese nombre" });
        return;
      }
      throw err;
    }
  },
);

export default router;
