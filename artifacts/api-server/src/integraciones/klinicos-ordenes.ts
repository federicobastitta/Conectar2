// Resolución de la orden médica que respalda una práctica cargada en Klinicos.
//
// Pedido del usuario (03/08/2026): SIEMPRE se genera la orden de respaldo
// automática (la que se imprime con letra, firma y sello del prescriptor
// institucional), aunque el turno ya tenga una orden cargada a mano. Reglas:
//   1. Se crea (o reutiliza, si el robot ya la creó para este paciente+
//      práctica+turno) la orden automática con el prescriptor rotado.
//   2. Solo si la automática NO se puede crear (práctica/prescriptor sin
//      resolver), se cae a una orden existente vinculada al turno como
//      último recurso.
//   3. Sin ninguna de las dos → se explica el faltante (fail-closed: NO se
//      inventa nada).

import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  db,
  klinicosPrescriptores,
  ordenesPracticasTable,
  practicasCatalogoTable,
  profesionalesTable,
  usersTable,
  type KlinicosTrabajo,
} from "@workspace/db";
import { logger } from "../lib/logger";

const ESTADOS_ORDEN_DESCARTADA = ["cancelada", "rechazada"] as const;

/** Marca de auditoría de las órdenes generadas por el robot: además de
 * documentar el origen, permite reusar SOLO las automáticas en reintentos
 * (las cargadas a mano nunca se reutilizan como principal). */
const OBSERVACION_ORDEN_AUTO = "Orden generada automáticamente por el robot Klinicos (prescriptor rotado)";

export interface OrdenResuelta {
  ordenId: number | null;
  numeroOrden: string | null;
  /** true si la orden la generó el robot en este paso. */
  creada: boolean;
  /** Si ordenId es null: explicación del faltante (para la bandeja/detalle). */
  faltante: string | null;
}

function normalizarNombre(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** "MP 238-974" / "238.974" / "238974" → "238974". Vacío si no hay dígitos. */
function matriculaDigitos(s: string | null | undefined): string {
  return (s ?? "").replace(/\D+/g, "");
}

/** Palabras del nombre del profesional: usa nombre_normalizado si está, y si
 * no lo reconstruye desde apellido+nombre (fichas cargadas a mano). */
function palabrasDeProfesional(p: { nombre: string; apellido: string | null; nombreNormalizado: string | null }): Set<string> {
  const base = p.nombreNormalizado?.trim() || normalizarNombre(`${p.apellido ?? ""} ${p.nombre}`);
  return new Set(base.split(" ").filter(Boolean));
}

/** Matching de nombres tolerante a orden invertido, acentos y segundos
 * nombres de un solo lado: las palabras del lado más corto deben estar todas
 * en el otro, con al menos 2 en común (una sola palabra es demasiado débil). */
function nombresCompatibles(palabrasPrescriptor: string[], propias: Set<string>): boolean {
  const comunes = palabrasPrescriptor.filter((p) => propias.has(p));
  if (comunes.length < 2) return false;
  return comunes.length === palabrasPrescriptor.length || comunes.length === propias.size;
}

/** Busca el profesional de Conectar que corresponde al prescriptor rotado.
 * Matrícula (solo dígitos, tolera "MP 238-974" vs "238974") es criterio
 * fuerte; el nombre tolera orden apellido/nombre invertido, acentos y
 * segundos nombres. Ambiguo o ninguno → null (nunca adivinar). */
export async function buscarProfesionalPrescriptor(
  prescriptorNombre: string | null,
  prescriptorMatricula: string | null,
): Promise<number | null> {
  const candidatos = await db
    .select({
      id: profesionalesTable.id,
      nombre: profesionalesTable.nombre,
      apellido: profesionalesTable.apellido,
      nombreNormalizado: profesionalesTable.nombreNormalizado,
      matricula: profesionalesTable.matricula,
      matriculaEspecialista: profesionalesTable.matriculaEspecialista,
    })
    .from(profesionalesTable)
    .where(eq(profesionalesTable.activo, true));

  // 1. Matrícula como criterio fuerte (comparación por dígitos)
  const matDigitos = matriculaDigitos(prescriptorMatricula);
  if (matDigitos) {
    const porMatricula = candidatos.filter(
      (c) => matriculaDigitos(c.matricula) === matDigitos || matriculaDigitos(c.matriculaEspecialista) === matDigitos,
    );
    if (porMatricula.length === 1) return porMatricula[0].id;
    // varias fichas con la misma matrícula (duplicados) → desempatar por nombre
    if (porMatricula.length > 1 && prescriptorNombre) {
      const palabras = normalizarNombre(prescriptorNombre).split(" ").filter(Boolean);
      const porNombre = porMatricula.filter((c) => nombresCompatibles(palabras, palabrasDeProfesional(c)));
      if (porNombre.length === 1) return porNombre[0].id;
    }
    if (porMatricula.length > 1) return null; // ambiguo incluso con matrícula
  }

  // 2. Nombre normalizado ("APELLIDO NOMBRE" de la planilla vs ficha)
  if (!prescriptorNombre) return null;
  const palabras = normalizarNombre(prescriptorNombre).split(" ").filter(Boolean);
  if (!palabras.length) return null;
  const matches = candidatos.filter((c) => nombresCompatibles(palabras, palabrasDeProfesional(c)));
  if (matches.length === 1) return matches[0].id;
  // varios homónimos: la matrícula desempata si alguna ficha la tiene
  if (matches.length > 1 && matDigitos) {
    const conMatricula = matches.filter(
      (c) => matriculaDigitos(c.matricula) === matDigitos || matriculaDigitos(c.matriculaEspecialista) === matDigitos,
    );
    if (conMatricula.length === 1) return conMatricula[0].id;
  }
  return null; // ambiguo o ninguno → null
}

/** Busca la práctica del catálogo interno que factura alguno de los códigos
 * IOMA del trabajo (codigos jsonb, reglasKlinicos.practiceCode o codigo). */
async function buscarPracticaCatalogo(codigos: string[]): Promise<{ id: number; requiereTokenKlinicos: boolean } | null> {
  const activas = await db
    .select({
      id: practicasCatalogoTable.id,
      codigo: practicasCatalogoTable.codigo,
      codigos: practicasCatalogoTable.codigos,
      reglasKlinicos: practicasCatalogoTable.reglasKlinicos,
      requiereTokenKlinicos: practicasCatalogoTable.requiereTokenKlinicos,
    })
    .from(practicasCatalogoTable)
    .where(eq(practicasCatalogoTable.activo, true));
  // Un trabajo puede traer códigos de varias prácticas (ej. ECG + ergometría
  // multi-código). La orden referencia UNA práctica: se toma la del primer
  // código que matchea de forma inequívoca (exactamente una práctica activa).
  for (const codigoCrudo of codigos) {
    const codigo = codigoCrudo.trim();
    const matches = activas.filter(
      (p) =>
        p.codigos?.some((c) => c.trim() === codigo) ||
        p.reglasKlinicos?.practiceCode?.trim() === codigo ||
        p.codigo.trim() === codigo,
    );
    if (matches.length === 1) return { id: matches[0].id, requiereTokenKlinicos: matches[0].requiereTokenKlinicos };
  }
  return null; // ningún código con match inequívoco → no adivinar
}

/** Usuario "sistema" para el created_by de órdenes generadas por el robot. */
async function usuarioSistemaId(): Promise<number | null> {
  const [u] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(sql`${usersTable.email} IN ('desarrollador@diagnosticar.ar', 'admin@diagnosticar.ar', 'gerente@diagnosticar.ar')`)
    .orderBy(usersTable.id)
    .limit(1);
  return u?.id ?? null;
}

export async function resolverOrdenParaTrabajo(trabajo: KlinicosTrabajo): Promise<OrdenResuelta> {
  const sinOrden = (faltante: string): OrdenResuelta => {
    logger.info({ trabajoId: trabajo.id, faltante }, "klinicos-ordenes: sin orden para el trabajo");
    return { ordenId: null, numeroOrden: null, creada: false, faltante };
  };
  // Último recurso: si la orden automática no se puede crear, se usa una
  // orden ya cargada al turno (mejor respaldar con lo que hay que frenar).
  const caerAExistente = async (faltante: string): Promise<OrdenResuelta> => {
    if (trabajo.turnoId) {
      const [existente] = await db
        .select({ id: ordenesPracticasTable.id, numeroOrden: ordenesPracticasTable.numeroOrden })
        .from(ordenesPracticasTable)
        .where(
          and(
            eq(ordenesPracticasTable.turnoId, trabajo.turnoId),
            notInArray(ordenesPracticasTable.estado, [...ESTADOS_ORDEN_DESCARTADA]),
          ),
        )
        .orderBy(sql`${ordenesPracticasTable.id} DESC`)
        .limit(1);
      if (existente) {
        logger.warn(
          { trabajoId: trabajo.id, ordenId: existente.id, faltante },
          "klinicos-ordenes: no se pudo crear la orden automática, se usa la orden cargada del turno",
        );
        return { ordenId: existente.id, numeroOrden: existente.numeroOrden, creada: false, faltante: null };
      }
    }
    return sinOrden(faltante);
  };
  if (!trabajo.practicaCodigos?.length) return caerAExistente("el trabajo no tiene códigos de práctica");

  const practica = await buscarPracticaCatalogo(trabajo.practicaCodigos);

  // 1. Crear (o reutilizar la automática ya creada) — SIEMPRE, aunque el
  //    turno tenga una orden cargada a mano (regla 03/08/2026).
  if (!practica)
    return caerAExistente(
      `no hay una práctica única del catálogo interno con los códigos ${trabajo.practicaCodigos.join(", ")} — vincular el código en Configuración → Prácticas o cargar la orden a mano`,
    );
  if (!trabajo.pacienteId) return caerAExistente("el trabajo no tiene paciente de Conectar vinculado");

  // Matrícula del prescriptor (si la rotación la conoce) para el matching
  let prescriptorMatricula: string | null = null;
  if (trabajo.prescriptorNombre) {
    const [pr] = await db
      .select({ matricula: klinicosPrescriptores.matricula })
      .from(klinicosPrescriptores)
      .where(eq(klinicosPrescriptores.nombre, trabajo.prescriptorNombre))
      .limit(1);
    prescriptorMatricula = pr?.matricula ?? null;
  }
  const profesionalId = await buscarProfesionalPrescriptor(trabajo.prescriptorNombre, prescriptorMatricula);
  if (!profesionalId)
    return caerAExistente(
      `el prescriptor "${trabajo.prescriptorNombre ?? "(sin definir)"}" no coincide con un único profesional activo de Conectar — cargar la orden a mano o ajustar el prescriptor en la bandeja`,
    );
  const createdBy = await usuarioSistemaId();
  if (!createdBy) return caerAExistente("no hay usuario sistema para registrar la orden automática");

  const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
  // Lección 03/08/2026: la orden que respalda la práctica debe estar fechada
  // 1–7 días ANTES de la carga (determinístico por trabajo para que la
  // simulación y la ejecución real coincidan).
  const diasAtras = 1 + (trabajo.id % 7);
  const fechaOrden = new Date(Date.now() - diasAtras * 86_400_000).toLocaleDateString("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
  });
  const ordenUuid = randomUUID();
  const { creadaFila, numeroOrden } = await db.transaction(async (tx) => {
    // Candado por paciente+práctica: dos trabajos concurrentes no deben crear
    // órdenes duplicadas. El lock es transaccional (se libera al commit).
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`orden-auto:${trabajo.pacienteId}:${practica.id}`}))`,
    );
    // Re-chequeo dentro del candado: ¿otro proceso ya creó la orden AUTOMÁTICA?
    // Solo se reutilizan las generadas por el robot (las cargadas a mano ya no
    // valen como principal desde la regla 03/08/2026).
    const [yaExiste] = await tx
      .select({ id: ordenesPracticasTable.id, numeroOrden: ordenesPracticasTable.numeroOrden })
      .from(ordenesPracticasTable)
      .where(
        and(
          eq(ordenesPracticasTable.patientId, trabajo.pacienteId!),
          eq(ordenesPracticasTable.practicaId, practica.id),
          eq(ordenesPracticasTable.observaciones, OBSERVACION_ORDEN_AUTO),
          trabajo.turnoId
            ? sql`(${ordenesPracticasTable.turnoId} = ${trabajo.turnoId} OR ${ordenesPracticasTable.turnoId} IS NULL)`
            : isNull(ordenesPracticasTable.turnoId),
          notInArray(ordenesPracticasTable.estado, [...ESTADOS_ORDEN_DESCARTADA]),
        ),
      )
      .orderBy(sql`${ordenesPracticasTable.id} DESC`)
      .limit(1);
    if (yaExiste) return { creadaFila: yaExiste, numeroOrden: yaExiste.numeroOrden };

    const [fila] = await tx
      .insert(ordenesPracticasTable)
      .values({
        ordenUuid,
        numeroOrden: `OP-${hoy.slice(0, 4)}-tmp-${ordenUuid.slice(0, 8)}`,
        accessionNumber: null, // NO viaja al PACS: respaldo administrativo para Klinicos
        patientId: trabajo.pacienteId!,
        professionalId: profesionalId,
        practicaId: practica.id,
        // Nunca "validada" acá: la validación real del token es otro circuito.
        estado: "pendiente_validacion",
        prioridad: "normal",
        motivoClinico: trabajo.consultaPor ?? trabajo.motivo ?? "Práctica indicada en la agenda de Conectar",
        diagnosticoCie10: trabajo.cie10Codigo ?? null,
        fechaOrden,
        turnoId: trabajo.turnoId ?? null,
        observaciones: OBSERVACION_ORDEN_AUTO,
        createdBy,
      })
      .returning({ id: ordenesPracticasTable.id });
    const numero = `OP-${hoy.slice(0, 4)}-${String(fila.id).padStart(6, "0")}`;
    await tx.update(ordenesPracticasTable).set({ numeroOrden: numero }).where(eq(ordenesPracticasTable.id, fila.id));
    return { creadaFila: fila, numeroOrden: numero };
  });
  logger.info(
    { trabajoId: trabajo.id, ordenId: creadaFila.id, numeroOrden, profesionalId, practicaId: practica.id },
    "klinicos-ordenes: orden creada automáticamente para el trabajo",
  );
  return { ordenId: creadaFila.id, numeroOrden, creada: true, faltante: null };
}
