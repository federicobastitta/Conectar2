import { Router, type IRouter, type Request, type Response } from "express";
import {
  eq, ilike, or, and, ne, type SQL, desc, sql,
} from "drizzle-orm";
import {
  db,
  pacientesTable,
  turnosTable,
  contactosEmergenciaTable,
  documentosPacienteTable,
  grupoFamiliarTable,
  auditoriaPacientesTable,
  usersTable,
} from "@workspace/db";
import {
  ListPacientesQueryParams,
  CreatePacienteBody,
  UpdatePacienteBody,
  GetPacienteParams,
  UpdatePacienteParams,
  DeletePacienteParams,
  GetPacienteTurnosParams,
  BuscarDuplicadosPacienteQueryParams,
  InactivarPacienteParams,
  ReactivarPacienteParams,
  GetContactoEmergenciaParams,
  CreateContactoEmergenciaParams,
  CreateContactoEmergenciaBody,
  DeleteContactoEmergenciaParams,
  GetDocumentosPacienteParams,
  CreateDocumentoPacienteParams,
  CreateDocumentoPacienteBody,
  DeleteDocumentoPacienteParams,
  GetGrupoFamiliarParams,
  CreateGrupoFamiliarVinculoParams,
  CreateGrupoFamiliarVinculoBody,
  DeleteGrupoFamiliarVinculoParams,
  GetAuditoriaPacienteParams,
  GetLinksIngresoPacienteParams,
  RevocarLinksIngresoPacienteParams,
} from "@workspace/api-zod";
import { getUserIdFromToken, requireRol } from "./auth";
import { medicoPuedeVerPaciente, profesionalIdDe } from "../lib/alcance-medico";
import {
  generarTokenIngreso,
  listarTokensIngresoDePaciente,
  revocarTokensIngresoDePaciente,
} from "../lib/autologin-paciente";
import { urlBaseLinkIngreso } from "../lib/url-publica";

const router: IRouter = Router();

// Todo el módulo de pacientes es solo para staff: expone y modifica datos personales
// y clínicos. Los pacientes acceden a su propia información vía /portal, /hce y /mi-*.
// OJO: scoped a "/pacientes" — un router.use sin path se aplicaría a TODO lo que
// pase por este router (incluidas rutas de otros routers montados en el mismo prefijo).
router.use("/pacientes", requireRol("admin", "recepcionista", "medico"));

async function getUser(req: Request) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const userId = await getUserIdFromToken(token);
  if (!userId) return null;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return user ?? null;
}

async function registrarAuditoria(
  pacienteId: number,
  usuarioId: number,
  usuarioEmail: string,
  accion: string,
  extras?: { camposModificados?: string; valorAnterior?: string; valorNuevo?: string }
) {
  await db.insert(auditoriaPacientesTable).values({
    pacienteId,
    usuarioId,
    usuarioEmail,
    accion,
    camposModificados: extras?.camposModificados ?? null,
    valorAnterior: extras?.valorAnterior ?? null,
    valorNuevo: extras?.valorNuevo ?? null,
  });
}

// Regla institucional (jul 2026): el número de historia clínica ES el DNI del
// paciente. Solo los pacientes sin DNI reciben el formato legacy HC000123.
function generarNumeroHc(id: number, dni?: string | null): string {
  const dniLimpio = (dni ?? "").trim();
  if (dniLimpio) return dniLimpio;
  return "HC" + String(id).padStart(6, "0");
}

// ── Buscar duplicados (antes de :id para evitar conflicto de rutas) ───────
router.get("/pacientes/buscar-duplicados", async (req: Request, res: Response): Promise<void> => {
  const params = BuscarDuplicadosPacienteQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const { nombre, apellido, fechaNacimiento, telefono, excludeId } = params.data;

  const conditions: SQL[] = [];

  if (nombre && apellido) {
    conditions.push(
      and(
        ilike(pacientesTable.nombre, `%${nombre}%`),
        ilike(pacientesTable.apellido, `%${apellido}%`)
      )!
    );
  }
  if (fechaNacimiento) {
    conditions.push(eq(pacientesTable.fechaNacimiento, fechaNacimiento));
  }
  if (telefono) {
    conditions.push(
      or(
        eq(pacientesTable.telefono, telefono),
        eq(pacientesTable.telefonoAlternativo, telefono)
      )!
    );
  }

  if (conditions.length === 0) {
    res.json({ hayDuplicados: false, duplicados: [] });
    return;
  }

  let query = db
    .select()
    .from(pacientesTable)
    .where(and(or(...conditions)!, eq(pacientesTable.activo, true)));

  const raw = await query.orderBy(pacientesTable.apellido, pacientesTable.nombre);
  const duplicados = excludeId
    ? raw.filter((p) => p.id !== excludeId)
    : raw;

  res.json({ hayDuplicados: duplicados.length > 0, duplicados });
});

// ── Listar pacientes ──────────────────────────────────────────────────────
// Alcance del médico dentro del módulo pacientes: solo pacientes con algún
// turno suyo (turnera propia, grupal donde participa, o asignado a él).
function condicionAlcanceMedico(pid: number): SQL {
  return sql`EXISTS (
    SELECT 1 FROM turnos t
    WHERE t.paciente_id = ${pacientesTable.id}
      AND (t.profesional_id = ${pid}
        OR t.turnera_id IN (
          SELECT id FROM turneras WHERE profesional_id = ${pid}
          UNION
          SELECT turnera_id FROM turnera_participantes WHERE profesional_id = ${pid}))
  )`;
}

// Devuelve true si respondió 403/400 (médico sin alcance sobre el paciente).
async function bloquearMedicoSinAlcance(req: Request, res: Response, pacienteId: number): Promise<boolean> {
  const user = await getUser(req);
  if (!user || user.rol !== "medico") return false;
  const pid = profesionalIdDe(user);
  if (pid == null || !(await medicoPuedeVerPaciente(pid, pacienteId))) {
    res.status(403).json({ error: "Sin permisos para ver este paciente" });
    return true;
  }
  return false;
}

router.get("/pacientes", async (req: Request, res: Response): Promise<void> => {
  const params = ListPacientesQueryParams.safeParse(req.query);
  const conditions: SQL[] = [];

  const userLista = await getUser(req);
  if (userLista?.rol === "medico") {
    const pid = profesionalIdDe(userLista);
    if (pid == null) {
      res.json({ data: [], total: 0, page: 1, limit: 20 });
      return;
    }
    conditions.push(condicionAlcanceMedico(pid));
  }

  if (params.success) {
    const { q, dni, nroHc, telefono, soloActivos } = params.data as {
      q?: string; dni?: string; nroHc?: string; telefono?: string; soloActivos?: boolean;
    };

    if (dni) {
      conditions.push(eq(pacientesTable.dni, dni));
    } else if (nroHc) {
      conditions.push(eq(pacientesTable.numeroHc, nroHc));
    } else if (telefono) {
      conditions.push(
        or(
          ilike(pacientesTable.telefono, `%${telefono}%`),
          ilike(pacientesTable.telefonoAlternativo, `%${telefono}%`)
        )!
      );
    } else if (q) {
      // Autocompletado: cada palabra debe matchear nombre, apellido, DNI o HC
      // (insensible a acentos) — "perez jua" encuentra a "Juan Pérez".
      for (const palabra of q.trim().split(/\s+/).slice(0, 5)) {
        const patron = `%${palabra}%`;
        conditions.push(
          or(
            sql`unaccent(${pacientesTable.nombre}) ILIKE unaccent(${patron})`,
            sql`unaccent(${pacientesTable.apellido}) ILIKE unaccent(${patron})`,
            ilike(pacientesTable.dni, patron),
            ilike(pacientesTable.numeroHc, patron)
          )!
        );
      }
    }

    if (soloActivos !== false) {
      conditions.push(eq(pacientesTable.activo, true));
    }
  } else {
    conditions.push(eq(pacientesTable.activo, true));
  }

  const limit = (params.success && (params.data as { limit?: number }).limit) ? (params.data as { limit?: number }).limit! : 20;
  const page = (params.success && (params.data as { page?: number }).page) ? (params.data as { page?: number }).page! : 1;
  const offset = (page - 1) * limit;

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const data = await db
    .select()
    .from(pacientesTable)
    .where(where)
    .orderBy(pacientesTable.apellido, pacientesTable.nombre)
    .limit(limit)
    .offset(offset);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(pacientesTable)
    .where(where);

  res.json({ data, total, page, limit });
});

// ── Crear paciente ────────────────────────────────────────────────────────
router.post("/pacientes", async (req: Request, res: Response): Promise<void> => {
  const user = await getUser(req);
  if (!user) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }

  const parsed = CreatePacienteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { forzarCreacion, ...datos } = parsed.data as typeof parsed.data & { forzarCreacion?: boolean };

  if (datos.dni) {
    const [existente] = await db
      .select()
      .from(pacientesTable)
      .where(eq(pacientesTable.dni, datos.dni))
      .limit(1);
    if (existente && existente.activo) {
      // El DNI tiene índice único global: aun con forzarCreacion no se puede
      // insertar otro paciente con el mismo DNI (fallaría el insert).
      res.status(409).json({
        error: forzarCreacion
          ? "No se puede crear otro paciente con el mismo DNI: ya existe uno activo. Editá la ficha existente."
          : "Ya existe un paciente activo con ese DNI",
        paciente: existente,
        code: "DNI_DUPLICADO",
      });
      return;
    }
    if (existente && !existente.activo) {
      // El DNI tiene índice único global: si la ficha existe pero está
      // inactiva (borrada), la reactivamos con los datos nuevos en lugar
      // de fallar el insert.
      const [reactivado] = await db
        .update(pacientesTable)
        .set({
          ...datos,
          activo: true,
          modificadoPor: user.id,
          modificadoEn: new Date(),
        })
        .where(eq(pacientesTable.id, existente.id))
        .returning();
      await registrarAuditoria(reactivado.id, user.id, user.email, "REACTIVACION");
      res.status(201).json(reactivado);
      return;
    }
  }

  let inserted;
  try {
    [inserted] = await db
      .insert(pacientesTable)
      .values({
        ...datos,
        activo: true,
        creadoPor: user.id,
      })
      .returning();
  } catch (err) {
    // Carrera: otro request insertó el mismo DNI entre el chequeo y el insert.
    const pgCode = (err as { cause?: { code?: string }; code?: string })?.cause?.code ?? (err as { code?: string })?.code;
    if (pgCode === "23505") {
      res.status(409).json({ error: "Ya existe un paciente con ese DNI", code: "DNI_DUPLICADO" });
      return;
    }
    throw err;
  }

  const numeroHc = generarNumeroHc(inserted.id, inserted.dni);
  const [paciente] = await db
    .update(pacientesTable)
    .set({ numeroHc })
    .where(eq(pacientesTable.id, inserted.id))
    .returning();

  await registrarAuditoria(paciente.id, user.id, user.email, "CREACION");

  res.status(201).json(paciente);
});

// ── Obtener paciente ──────────────────────────────────────────────────────
router.get("/pacientes/:id", async (req: Request, res: Response): Promise<void> => {
  const params = GetPacienteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (await bloquearMedicoSinAlcance(req, res, params.data.id)) return;
  const [paciente] = await db
    .select()
    .from(pacientesTable)
    .where(eq(pacientesTable.id, params.data.id))
    .limit(1);
  if (!paciente) {
    res.status(404).json({ error: "Paciente no encontrado" });
    return;
  }
  res.json(paciente);
});

// ── Actualizar paciente ───────────────────────────────────────────────────
router.patch("/pacientes/:id", async (req: Request, res: Response): Promise<void> => {
  const user = await getUser(req);
  if (!user) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }

  const params = UpdatePacienteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdatePacienteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [antes] = await db
    .select()
    .from(pacientesTable)
    .where(eq(pacientesTable.id, params.data.id))
    .limit(1);
  if (!antes) {
    res.status(404).json({ error: "Paciente no encontrado" });
    return;
  }

  // HC = DNI: si cambia el DNI, el número de historia clínica lo acompaña.
  const dniNuevo = typeof parsed.data.dni === "string" ? parsed.data.dni.trim() : undefined;
  const [paciente] = await db
    .update(pacientesTable)
    .set({
      ...parsed.data,
      ...(dniNuevo ? { numeroHc: dniNuevo } : {}),
      modificadoPor: user.id,
      modificadoEn: new Date(),
    })
    .where(eq(pacientesTable.id, params.data.id))
    .returning();

  const camposModificados = Object.keys(parsed.data).join(", ");
  await registrarAuditoria(paciente.id, user.id, user.email, "ACTUALIZACION", {
    camposModificados,
    valorAnterior: JSON.stringify(
      Object.fromEntries(
        Object.keys(parsed.data).map((k) => [k, (antes as Record<string, unknown>)[k]])
      )
    ),
    valorNuevo: JSON.stringify(parsed.data),
  });

  res.json(paciente);
});

// ── Baja lógica (DELETE como alias) ─────────────────────────────────────
router.delete("/pacientes/:id", async (req: Request, res: Response): Promise<void> => {
  const user = await getUser(req);
  if (!user) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }

  const params = DeletePacienteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [paciente] = await db
    .update(pacientesTable)
    .set({ activo: false, modificadoPor: user.id, modificadoEn: new Date() })
    .where(eq(pacientesTable.id, params.data.id))
    .returning();

  if (!paciente) {
    res.status(404).json({ error: "Paciente no encontrado" });
    return;
  }

  await registrarAuditoria(paciente.id, user.id, user.email, "BAJA_LOGICA");
  res.sendStatus(204);
});

// ── Inactivar paciente (baja lógica explícita) ────────────────────────────
router.post("/pacientes/:id/inactivar", async (req: Request, res: Response): Promise<void> => {
  const user = await getUser(req);
  if (!user) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }

  const params = InactivarPacienteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [paciente] = await db
    .update(pacientesTable)
    .set({ activo: false, modificadoPor: user.id, modificadoEn: new Date() })
    .where(eq(pacientesTable.id, params.data.id))
    .returning();

  if (!paciente) {
    res.status(404).json({ error: "Paciente no encontrado" });
    return;
  }

  await registrarAuditoria(paciente.id, user.id, user.email, "BAJA_LOGICA");
  res.json(paciente);
});

// ── Reactivar paciente ────────────────────────────────────────────────────
router.post("/pacientes/:id/reactivar", async (req: Request, res: Response): Promise<void> => {
  const user = await getUser(req);
  if (!user) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }

  const params = ReactivarPacienteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [paciente] = await db
    .update(pacientesTable)
    .set({ activo: true, modificadoPor: user.id, modificadoEn: new Date() })
    .where(eq(pacientesTable.id, params.data.id))
    .returning();

  if (!paciente) {
    res.status(404).json({ error: "Paciente no encontrado" });
    return;
  }

  await registrarAuditoria(paciente.id, user.id, user.email, "REACTIVACION");
  res.json(paciente);
});

// ── Historial de turnos ───────────────────────────────────────────────────
router.get("/pacientes/:id/turnos", async (req: Request, res: Response): Promise<void> => {
  const params = GetPacienteTurnosParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (await bloquearMedicoSinAlcance(req, res, params.data.id)) return;
  const turnos = await db
    .select()
    .from(turnosTable)
    .where(eq(turnosTable.pacienteId, params.data.id))
    .orderBy(desc(turnosTable.fecha), desc(turnosTable.horaInicio));
  res.json(turnos);
});

// ── Contactos de emergencia ───────────────────────────────────────────────
router.get("/pacientes/:id/contacto-emergencia", async (req: Request, res: Response): Promise<void> => {
  const params = GetContactoEmergenciaParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (await bloquearMedicoSinAlcance(req, res, params.data.id)) return;
  const contactos = await db
    .select()
    .from(contactosEmergenciaTable)
    .where(eq(contactosEmergenciaTable.pacienteId, params.data.id))
    .orderBy(contactosEmergenciaTable.createdAt);
  res.json(contactos);
});

router.post("/pacientes/:id/contacto-emergencia", async (req: Request, res: Response): Promise<void> => {
  const user = await getUser(req);
  if (!user) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }

  const params = CreateContactoEmergenciaParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateContactoEmergenciaBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [contacto] = await db
    .insert(contactosEmergenciaTable)
    .values({ ...parsed.data, pacienteId: params.data.id, creadoPor: user.id })
    .returning();

  res.status(201).json(contacto);
});

router.delete("/pacientes/:id/contacto-emergencia/:contactoId", async (req: Request, res: Response): Promise<void> => {
  const params = DeleteContactoEmergenciaParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await db
    .delete(contactosEmergenciaTable)
    .where(
      and(
        eq(contactosEmergenciaTable.id, params.data.contactoId),
        eq(contactosEmergenciaTable.pacienteId, params.data.id)
      )
    );
  res.sendStatus(204);
});

// ── Documentos adjuntos ───────────────────────────────────────────────────
router.get("/pacientes/:id/documentos", async (req: Request, res: Response): Promise<void> => {
  const params = GetDocumentosPacienteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (await bloquearMedicoSinAlcance(req, res, params.data.id)) return;
  const docs = await db
    .select()
    .from(documentosPacienteTable)
    .where(eq(documentosPacienteTable.pacienteId, params.data.id))
    .orderBy(desc(documentosPacienteTable.createdAt));
  res.json(docs);
});

router.post("/pacientes/:id/documentos", async (req: Request, res: Response): Promise<void> => {
  const user = await getUser(req);
  if (!user) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }

  const params = CreateDocumentoPacienteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateDocumentoPacienteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [doc] = await db
    .insert(documentosPacienteTable)
    .values({ ...parsed.data, pacienteId: params.data.id, creadoPor: user.id })
    .returning();

  res.status(201).json(doc);
});

router.delete("/pacientes/:id/documentos/:docId", async (req: Request, res: Response): Promise<void> => {
  const params = DeleteDocumentoPacienteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await db
    .delete(documentosPacienteTable)
    .where(
      and(
        eq(documentosPacienteTable.id, params.data.docId),
        eq(documentosPacienteTable.pacienteId, params.data.id)
      )
    );
  res.sendStatus(204);
});

// ── Grupo familiar ────────────────────────────────────────────────────────
router.get("/pacientes/:id/grupo-familiar", async (req: Request, res: Response): Promise<void> => {
  const params = GetGrupoFamiliarParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (await bloquearMedicoSinAlcance(req, res, params.data.id)) return;
  const vinculos = await db
    .select()
    .from(grupoFamiliarTable)
    .where(eq(grupoFamiliarTable.pacienteId, params.data.id))
    .orderBy(grupoFamiliarTable.createdAt);
  res.json(vinculos);
});

router.post("/pacientes/:id/grupo-familiar", async (req: Request, res: Response): Promise<void> => {
  const user = await getUser(req);
  if (!user) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }

  const params = CreateGrupoFamiliarVinculoParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateGrupoFamiliarVinculoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [vinculo] = await db
    .insert(grupoFamiliarTable)
    .values({ ...parsed.data, pacienteId: params.data.id, creadoPor: user.id })
    .returning();

  res.status(201).json(vinculo);
});

router.delete("/pacientes/:id/grupo-familiar/:vinculoId", async (req: Request, res: Response): Promise<void> => {
  const params = DeleteGrupoFamiliarVinculoParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await db
    .delete(grupoFamiliarTable)
    .where(
      and(
        eq(grupoFamiliarTable.id, params.data.vinculoId),
        eq(grupoFamiliarTable.pacienteId, params.data.id)
      )
    );
  res.sendStatus(204);
});

// ── Auditoría ─────────────────────────────────────────────────────────────
router.get("/pacientes/:id/auditoria", async (req: Request, res: Response): Promise<void> => {
  const params = GetAuditoriaPacienteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (await bloquearMedicoSinAlcance(req, res, params.data.id)) return;
  const log = await db
    .select()
    .from(auditoriaPacientesTable)
    .where(eq(auditoriaPacientesTable.pacienteId, params.data.id))
    .orderBy(desc(auditoriaPacientesTable.createdAt));
  res.json(log);
});

// ── Links de ingreso (autologin permanente) ───────────────────────────────
// Solo gestión (rol admin: administrador, gerente, desarrollador, etc.) puede
// ver y anular los links de ingreso del paciente. Anular = borrar la fila
// autologin_paciente_* de config_sistema; el portal pasa a responder 410.
function requiereGestion(req: Request, res: Response): boolean {
  const user = res.locals.user as typeof usersTable.$inferSelect | undefined;
  if (!user || user.rol !== "admin") {
    res.status(403).json({ error: "Solo un rol de gestión puede ver o anular los links de ingreso" });
    return true;
  }
  return false;
}

router.get("/pacientes/:id/links-ingreso", async (req: Request, res: Response): Promise<void> => {
  const params = GetLinksIngresoPacienteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (requiereGestion(req, res)) return;
  const links = await listarTokensIngresoDePaciente(params.data.id);
  res.json(links);
});

// Genera un link de ingreso permanente para el paciente y lo devuelve UNA vez
// (el token plano nunca se guarda). Pensado para copiarlo y mandarlo por el
// WhatsApp propio del operador ("lo saco por afuera").
router.post("/pacientes/:id/links-ingreso", async (req: Request, res: Response): Promise<void> => {
  const params = GetLinksIngresoPacienteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  // Generar puede también recepción (mostrador: QR o WhatsApp propio);
  // ver/anular links sigue siendo solo gestión.
  const quien = res.locals.user as typeof usersTable.$inferSelect | undefined;
  if (!quien || !["admin", "recepcionista"].includes(quien.rol)) {
    res.status(403).json({ error: "Solo gestión o recepción pueden generar links de ingreso" });
    return;
  }
  const user = res.locals.user as typeof usersTable.$inferSelect;
  const [paciente] = await db
    .select()
    .from(pacientesTable)
    .where(eq(pacientesTable.id, params.data.id))
    .limit(1);
  if (!paciente || !paciente.activo) {
    res.status(404).json({ error: "Paciente no encontrado o dado de baja" });
    return;
  }
  if (!paciente.dni?.trim()) {
    res.status(422).json({ error: "El paciente no tiene DNI cargado en su ficha; cargalo antes de generar el link." });
    return;
  }
  const base = urlBaseLinkIngreso();
  if (!base) {
    res.status(422).json({ error: "No hay una URL pública configurada para armar el link de ingreso." });
    return;
  }
  const { tokenPlano } = await generarTokenIngreso({
    usuarioId: null,
    pacienteId: paciente.id,
    generadoPorId: user.id,
    generadoPorEmail: user.email,
  });
  await registrarAuditoria(paciente.id, user.id, user.email, "LINK_INGRESO_GENERADO", {
    valorNuevo: "link de ingreso generado para envío manual",
  });
  res.status(201).json({
    link: `${base}/ingreso/${tokenPlano}`,
    pacienteNombre: `${paciente.apellido}, ${paciente.nombre}`,
    telefono: paciente.telefono ?? null,
  });
});

router.delete("/pacientes/:id/links-ingreso", async (req: Request, res: Response): Promise<void> => {
  const params = RevocarLinksIngresoPacienteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (requiereGestion(req, res)) return;
  const user = res.locals.user as typeof usersTable.$inferSelect;
  const revocados = await revocarTokensIngresoDePaciente(params.data.id);
  if (revocados > 0) {
    await registrarAuditoria(params.data.id, user.id, user.email, "LINKS_INGRESO_ANULADOS", {
      valorNuevo: `${revocados} link(s) de ingreso anulados`,
    });
  }
  res.json({ revocados });
});

export default router;
