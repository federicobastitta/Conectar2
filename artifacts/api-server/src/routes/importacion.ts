import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, pacientesTable, profesionalesTable, especialidadesTable, sedesTable, turnerasTable } from "@workspace/db";
import { PreviewImportacionBody, EjecutarImportacionBody } from "@workspace/api-zod";
import { requireRol } from "./auth";

const router: IRouter = Router();

// Endpoints de importación legacy: solo staff (crean pacientes y profesionales).
router.use("/importacion", requireRol("admin", "recepcionista"));

type AnyRecord = Record<string, unknown>;

function normalizeRows(datosJson: string): AnyRecord[] {
  try {
    const parsed = JSON.parse(datosJson);
    if (Array.isArray(parsed)) return parsed as AnyRecord[];
    return [];
  } catch {
    return [];
  }
}

router.post("/importacion/preview", async (req, res): Promise<void> => {
  const parsed = PreviewImportacionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const rows = normalizeRows(parsed.data.datosJson);
  const errores: { fila: number; mensaje: string; campo: string | null }[] = [];
  let nuevos = 0;
  let actualizados = 0;
  const preview: AnyRecord[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let isNew = true;
    if (parsed.data.entidad === "pacientes") {
      if (!row.nombre || !row.apellido) {
        errores.push({ fila: i + 1, mensaje: "nombre y apellido son requeridos", campo: null });
        continue;
      }
      if (row.dni) {
        const [existing] = await db.select().from(pacientesTable).where(eq(pacientesTable.dni, String(row.dni))).limit(1);
        if (existing) isNew = false;
      }
    } else if (parsed.data.entidad === "profesionales") {
      if (!row.nombre) {
        errores.push({ fila: i + 1, mensaje: "nombre es requerido", campo: null });
        continue;
      }
    } else if (parsed.data.entidad === "especialidades") {
      if (!row.nombre) {
        errores.push({ fila: i + 1, mensaje: "nombre es requerido", campo: null });
        continue;
      }
    } else if (parsed.data.entidad === "sedes") {
      if (!row.nombre) {
        errores.push({ fila: i + 1, mensaje: "nombre es requerido", campo: null });
        continue;
      }
    }
    if (isNew) nuevos++;
    else actualizados++;
    preview.push({ ...row, _accion: isNew ? "crear" : "actualizar", _fila: i + 1 });
  }

  res.json({ nuevos, actualizados, erroresCount: errores.length, errores, previewJson: JSON.stringify(preview) });
});

router.post("/importacion/ejecutar", async (req, res): Promise<void> => {
  const parsed = EjecutarImportacionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const rows = normalizeRows(parsed.data.datosJson);
  const errores: { fila: number; mensaje: string; campo: string | null }[] = [];
  let creados = 0;
  let actualizados = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      if (parsed.data.entidad === "pacientes") {
        if (!row.nombre || !row.apellido) { errores.push({ fila: i + 1, mensaje: "nombre y apellido requeridos", campo: null }); continue; }
        if (row.dni) {
          const [existing] = await db.select().from(pacientesTable).where(eq(pacientesTable.dni, String(row.dni))).limit(1);
          if (existing) {
            await db.update(pacientesTable).set({ nombre: String(row.nombre), apellido: String(row.apellido), email: row.email ? String(row.email) : undefined, telefono: row.telefono ? String(row.telefono) : undefined, cobertura: row.cobertura ? String(row.cobertura) : undefined }).where(eq(pacientesTable.id, existing.id));
            actualizados++;
            continue;
          }
        }
        await db.insert(pacientesTable).values({ nombre: String(row.nombre), apellido: String(row.apellido), dni: row.dni ? String(row.dni) : undefined, numeroHc: row.dni ? String(row.dni) : undefined, email: row.email ? String(row.email) : undefined, telefono: row.telefono ? String(row.telefono) : undefined, cobertura: row.cobertura ? String(row.cobertura) : undefined });
        creados++;
      } else if (parsed.data.entidad === "profesionales") {
        if (!row.nombre) { errores.push({ fila: i + 1, mensaje: "nombre requerido", campo: null }); continue; }
        await db.insert(profesionalesTable).values({ nombre: String(row.nombre), apellido: row.apellido ? String(row.apellido) : undefined, matricula: row.matricula ? String(row.matricula) : undefined, email: row.email ? String(row.email) : undefined });
        creados++;
      } else if (parsed.data.entidad === "especialidades") {
        if (!row.nombre) { errores.push({ fila: i + 1, mensaje: "nombre requerido", campo: null }); continue; }
        await db.insert(especialidadesTable).values({ nombre: String(row.nombre) });
        creados++;
      } else if (parsed.data.entidad === "sedes") {
        if (!row.nombre) { errores.push({ fila: i + 1, mensaje: "nombre requerido", campo: null }); continue; }
        await db.insert(sedesTable).values({ nombre: String(row.nombre), direccion: row.direccion ? String(row.direccion) : undefined });
        creados++;
      }
    } catch (err) {
      errores.push({ fila: i + 1, mensaje: "Error interno al procesar fila", campo: null });
    }
  }
  res.json({ creados, actualizados, erroresCount: errores.length, errores });
});

export default router;
