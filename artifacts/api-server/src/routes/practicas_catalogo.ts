import { Router, type IRouter } from "express";
import { eq, asc, inArray, sql } from "drizzle-orm";
import { db, practicasCatalogoTable, nomencladorPracticasTable } from "@workspace/db";
import { requireRol } from "./auth";
import { z } from "zod/v4";

const router: IRouter = Router();

const bodySchema = z.object({
  codigo: z.string().min(2).max(40).trim(),
  nombre: z.string().min(2).max(200).trim(),
  especialidad: z.string().min(2).max(80).trim().default("CARDIOLOGIA"),
  modalidadDicom: z.string().max(20).trim().optional().nullable(),
  generaDicom: z.boolean().default(true),
  usaWorkspacePacs: z.boolean().default(true),
  requiereTokenKlinicos: z.boolean().default(false),
  requiereRegion: z.boolean().default(false),
  requiereLateralidad: z.boolean().default(false),
  preparacion: z.string().max(1000).trim().optional().nullable(),
  requisitosDocumentacion: z.string().max(1000).trim().optional().nullable(),
  reglasKlinicos: z
    .object({
      practiceId: z.string().optional(),
      practiceCode: z.string().optional(),
      catalog: z.string().optional(),
      description: z.string().optional(),
    })
    .optional()
    .nullable(),
  // Códigos del nomenclador que componen el estudio (pueden repetirse para
  // indicar cantidad, ej. mamografía bilateral).
  codigos: z.array(z.string().min(2).max(30).trim()).max(12).optional().nullable(),
  profesionalInformanteId: z.number().int().positive().optional().nullable(),
  activo: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

// ── GET /api/practicas-catalogo ───────────────────────────────────────────────
router.get(
  "/practicas-catalogo",
  requireRol("admin", "recepcionista", "medico"),
  async (req, res): Promise<void> => {
    const soloActivos = req.query.activo !== "false";
    const rows = await db
      .select()
      .from(practicasCatalogoTable)
      .where(soloActivos ? eq(practicasCatalogoTable.activo, true) : undefined)
      .orderBy(asc(practicasCatalogoTable.sortOrder), asc(practicasCatalogoTable.nombre));

    // Sinónimos: descripciones del nomenclador cuyo código coincide con la parte
    // numérica del código del catálogo (ej. "IOMA-180106-50" → 180106 →
    // "ECOGRAFIA MAMARIA BILATERAL"). Sirven para el autocompletado del frontend.
    const codigoNumerico = (codigo: string): string | null => {
      const partes = codigo.match(/\d{4,}/g);
      return partes ? partes.sort((a, b) => b.length - a.length)[0] : null;
    };
    const numericos = [...new Set(rows.map((r) => codigoNumerico(r.codigo)).filter((c): c is string => c !== null))];
    const sinonimosPorCodigo = new Map<string, string[]>();
    if (numericos.length > 0) {
      const filas = await db
        .selectDistinct({
          codigo: sql<string>`regexp_replace(${nomencladorPracticasTable.codigo}, '[^0-9]', '', 'g')`,
          descripcion: nomencladorPracticasTable.descripcion,
        })
        .from(nomencladorPracticasTable)
        .where(inArray(sql`regexp_replace(${nomencladorPracticasTable.codigo}, '[^0-9]', '', 'g')`, numericos));
      const MAX_SINONIMOS = 5;
      for (const f of filas) {
        if (!f.descripcion) continue;
        const lista = sinonimosPorCodigo.get(f.codigo) ?? [];
        if (lista.length < MAX_SINONIMOS && !lista.includes(f.descripcion)) lista.push(f.descripcion);
        sinonimosPorCodigo.set(f.codigo, lista);
      }
    }
    const practicas = rows.map((r) => {
      const num = codigoNumerico(r.codigo);
      return {
        ...r,
        sinonimos: num ? (sinonimosPorCodigo.get(num) ?? []) : [],
        // Código numérico del nomenclador (ej. "180106"): es el que viaja como
        // prestación en turnera_practicas / Klinicos.
        codigoNomenclador: num,
        // Todos los códigos que componen el estudio, sin repetidos (para
        // tildar en la agenda: cada código va como ítem separado). El listado
        // completo con repeticiones queda en `codigos` para la facturación.
        codigosNomenclador:
          r.codigos && r.codigos.length > 0
            ? [...new Set(r.codigos)]
            : num
              ? [num]
              : [],
      };
    });
    res.json({ practicas });
  },
);

// ── GET /api/practicas-catalogo/:id ──────────────────────────────────────────
router.get(
  "/practicas-catalogo/:id",
  requireRol("admin", "recepcionista", "medico"),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id));
    if (!Number.isFinite(id)) { res.status(400).json({ error: "ID inválido" }); return; }
    const [row] = await db.select().from(practicasCatalogoTable).where(eq(practicasCatalogoTable.id, id)).limit(1);
    if (!row) { res.status(404).json({ error: "Práctica no encontrada" }); return; }
    res.json({ practica: row });
  },
);

// ── POST /api/practicas-catalogo ─────────────────────────────────────────────
router.post(
  "/practicas-catalogo",
  requireRol("admin"),
  async (req, res): Promise<void> => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: "Datos inválidos", detalles: parsed.error.issues });
      return;
    }
    const data = parsed.data;
    const [inserted] = await db
      .insert(practicasCatalogoTable)
      .values({
        codigo: data.codigo,
        nombre: data.nombre,
        especialidad: data.especialidad,
        modalidadDicom: data.modalidadDicom ?? null,
        generaDicom: data.generaDicom,
        usaWorkspacePacs: data.usaWorkspacePacs,
        requiereTokenKlinicos: data.requiereTokenKlinicos,
        requiereRegion: data.requiereRegion,
        requiereLateralidad: data.requiereLateralidad,
        preparacion: data.preparacion ?? null,
        requisitosDocumentacion: data.requisitosDocumentacion ?? null,
        reglasKlinicos: data.reglasKlinicos ?? null,
        codigos: data.codigos ?? null,
        profesionalInformanteId: data.profesionalInformanteId ?? null,
        activo: data.activo,
        sortOrder: data.sortOrder,
      })
      .returning();
    req.log.info({ id: inserted.id, codigo: inserted.codigo }, "practica-catalogo: creada");
    res.status(201).json({ practica: inserted });
  },
);

// ── PUT /api/practicas-catalogo/:id ──────────────────────────────────────────
router.put(
  "/practicas-catalogo/:id",
  requireRol("admin"),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id));
    if (!Number.isFinite(id)) { res.status(400).json({ error: "ID inválido" }); return; }
    const parsed = bodySchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: "Datos inválidos", detalles: parsed.error.issues });
      return;
    }
    const [updated] = await db
      .update(practicasCatalogoTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(practicasCatalogoTable.id, id))
      .returning();
    if (!updated) { res.status(404).json({ error: "Práctica no encontrada" }); return; }
    req.log.info({ id }, "practica-catalogo: actualizada");
    res.json({ practica: updated });
  },
);

// ── DELETE /api/practicas-catalogo/:id (soft delete) ─────────────────────────
router.delete(
  "/practicas-catalogo/:id",
  requireRol("admin"),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id));
    if (!Number.isFinite(id)) { res.status(400).json({ error: "ID inválido" }); return; }
    const [updated] = await db
      .update(practicasCatalogoTable)
      .set({ activo: false, updatedAt: new Date() })
      .where(eq(practicasCatalogoTable.id, id))
      .returning({ id: practicasCatalogoTable.id });
    if (!updated) { res.status(404).json({ error: "Práctica no encontrada" }); return; }
    req.log.info({ id }, "practica-catalogo: desactivada");
    res.json({ ok: true });
  },
);

export default router;
