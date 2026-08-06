/**
 * Sincronización idempotente del esquema al arrancar.
 *
 * Problema que resuelve: el flujo de publish NO sincroniza la base AWS
 * (conectar_app_prod) que usa la app publicada — solo la base Replit. Si en dev
 * se agregó una columna via psql y no se replicó a AWS, los endpoints fallan
 * con 500 (caso real 30/7/2026: faltaba ordenes_practicas.turno_id).
 *
 * Estrategia: al arrancar, se compara el esquema Drizzle (fuente de verdad en
 * lib/db/src/schema) contra information_schema de la base conectada y se
 * aplican SOLO cambios aditivos e idempotentes:
 *   - columnas faltantes  → ALTER TABLE ... ADD COLUMN IF NOT EXISTS
 *   - tablas faltantes    → CREATE TABLE IF NOT EXISTS (columnas + PK)
 * Nunca borra, renombra ni cambia tipos. Columnas NOT NULL sin default
 * renderizable se agregan nullable (con advertencia) para no romper filas
 * existentes.
 */

import { is, SQL, sql } from "drizzle-orm";
import { PgTable, PgDialect, getTableConfig, type PgColumn } from "drizzle-orm/pg-core";
import * as workspaceDb from "@workspace/db";
import { db } from "@workspace/db";
import { logger } from "./logger";

const dialecto = new PgDialect();

// ── Descubrimiento de tablas del esquema ─────────────────────────────────────

export function tablasDelEsquema(): PgTable[] {
  const tablas: PgTable[] = [];
  for (const valor of Object.values(workspaceDb)) {
    if (is(valor, PgTable)) tablas.push(valor);
  }
  return tablas;
}

// ── Render de defaults ───────────────────────────────────────────────────────

function renderizarDefault(col: PgColumn): string | null {
  if (!col.hasDefault) return null;
  const def = col.default;
  // defaultFn / $defaultFn corren en runtime JS, no son un default de DB
  if (def === undefined) return null;
  if (def === null) return "NULL";
  if (is(def, SQL)) {
    try {
      const q = dialecto.sqlToQuery(def.inlineParams());
      return q.sql;
    } catch {
      return null;
    }
  }
  switch (typeof def) {
    case "number":
      return Number.isFinite(def) ? String(def) : null;
    case "boolean":
      return def ? "true" : "false";
    case "string":
      return `'${def.replace(/'/g, "''")}'`;
    case "object":
      // jsonb / arrays de valores
      try {
        const tipo = col.getSQLType();
        if (tipo === "jsonb" || tipo === "json") {
          return `'${JSON.stringify(def).replace(/'/g, "''")}'::${tipo}`;
        }
        return null;
      } catch {
        return null;
      }
    default:
      return null;
  }
}

// ── Generación de DDL ────────────────────────────────────────────────────────

export interface DDLColumna {
  tabla: string;
  columna: string;
  ddl: string;
  advertencia?: string;
}

export function generarDDLColumnaFaltante(tabla: string, col: PgColumn): DDLColumna {
  const tipo = col.getSQLType();
  const def = renderizarDefault(col);
  let ddl = `ALTER TABLE "${tabla}" ADD COLUMN IF NOT EXISTS "${col.name}" ${tipo}`;
  let advertencia: string | undefined;
  if (def !== null) ddl += ` DEFAULT ${def}`;
  if (col.notNull) {
    if (def !== null) {
      ddl += ` NOT NULL`;
    } else {
      advertencia = `columna ${tabla}.${col.name} es NOT NULL sin default renderizable — se agrega nullable para no romper filas existentes`;
    }
  }
  return { tabla, columna: col.name, ddl, advertencia };
}

export interface DDLTabla {
  tabla: string;
  ddl: string[];
  advertencias: string[];
}

export function generarDDLTablaFaltante(t: PgTable): DDLTabla {
  const cfg = getTableConfig(t);
  const advertencias: string[] = [];
  const lineas: string[] = [];
  const pks: string[] = [];

  for (const col of cfg.columns) {
    const tipo = col.getSQLType();
    let linea = `"${col.name}" ${tipo}`;
    const def = renderizarDefault(col);
    if (def !== null) linea += ` DEFAULT ${def}`;
    // en tabla nueva no hay filas: NOT NULL es seguro aun sin default
    if (col.notNull && !col.primary) linea += ` NOT NULL`;
    if (col.primary) pks.push(`"${col.name}"`);
    lineas.push(linea);
  }
  if (pks.length > 0) lineas.push(`PRIMARY KEY (${pks.join(", ")})`);

  const ddl: string[] = [
    `CREATE TABLE IF NOT EXISTS "${cfg.name}" (\n  ${lineas.join(",\n  ")}\n)`,
  ];

  // Índices: best-effort (los de expresión/parciales que no se puedan
  // renderizar quedan como advertencia para aplicar a mano)
  for (const idx of cfg.indexes) {
    try {
      const c = (idx as unknown as { config: {
        name?: string;
        unique?: boolean;
        columns: Array<{ name?: string } | SQL>;
        where?: SQL;
      } }).config;
      const cols = c.columns.map((cc) => {
        if (is(cc, SQL)) return dialecto.sqlToQuery(cc.inlineParams()).sql;
        if (cc && typeof cc === "object" && "name" in cc && cc.name) return `"${cc.name}"`;
        throw new Error("columna de índice no renderizable");
      });
      const nombre = c.name ?? `${cfg.name}_${cols.join("_").replace(/[^a-z0-9_]/gi, "")}_idx`;
      let sqlIdx = `CREATE ${c.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS "${nombre}" ON "${cfg.name}" (${cols.join(", ")})`;
      if (c.where) sqlIdx += ` WHERE ${dialecto.sqlToQuery(c.where.inlineParams()).sql}`;
      ddl.push(sqlIdx);
    } catch (err) {
      advertencias.push(
        `índice de ${cfg.name} no se pudo generar automáticamente (${err instanceof Error ? err.message : String(err)}) — crear a mano`,
      );
    }
  }
  if (cfg.foreignKeys.length > 0) {
    advertencias.push(
      `tabla ${cfg.name} tiene ${cfg.foreignKeys.length} FK(s) en el esquema que no se crean automáticamente`,
    );
  }
  return { tabla: cfg.name, ddl, advertencias };
}

// ── Detección de drift ───────────────────────────────────────────────────────

export interface SnapshotDB {
  /** tabla → set de nombres de columna existentes en la base */
  tablas: Map<string, Set<string>>;
}

export async function snapshotBaseActual(): Promise<SnapshotDB> {
  const res = await db.execute(sql`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `);
  const tablas = new Map<string, Set<string>>();
  for (const row of res.rows as Array<{ table_name: string; column_name: string }>) {
    let cols = tablas.get(row.table_name);
    if (!cols) {
      cols = new Set();
      tablas.set(row.table_name, cols);
    }
    cols.add(row.column_name);
  }
  return { tablas };
}

export interface DriftEsquema {
  tablasFaltantes: DDLTabla[];
  columnasFaltantes: DDLColumna[];
}

export function detectarDrift(snapshot: SnapshotDB, tablas: PgTable[] = tablasDelEsquema()): DriftEsquema {
  const tablasFaltantes: DDLTabla[] = [];
  const columnasFaltantes: DDLColumna[] = [];

  for (const t of tablas) {
    const cfg = getTableConfig(t);
    const existentes = snapshot.tablas.get(cfg.name);
    if (!existentes) {
      tablasFaltantes.push(generarDDLTablaFaltante(t));
      continue;
    }
    for (const col of cfg.columns) {
      if (!existentes.has(col.name)) {
        columnasFaltantes.push(generarDDLColumnaFaltante(cfg.name, col));
      }
    }
  }
  return { tablasFaltantes, columnasFaltantes };
}

// ── Aplicación (aditiva e idempotente) ───────────────────────────────────────

export interface ResultadoSincronizacion {
  columnasAgregadas: string[];
  tablasCreadas: string[];
  advertencias: string[];
  errores: Array<{ ddl: string; error: string }>;
}

export async function sincronizarEsquema(): Promise<ResultadoSincronizacion> {
  const snapshot = await snapshotBaseActual();
  const drift = detectarDrift(snapshot);
  const resultado: ResultadoSincronizacion = {
    columnasAgregadas: [],
    tablasCreadas: [],
    advertencias: [],
    errores: [],
  };

  for (const col of drift.columnasFaltantes) {
    try {
      await db.execute(sql.raw(col.ddl));
      resultado.columnasAgregadas.push(`${col.tabla}.${col.columna}`);
      if (col.advertencia) resultado.advertencias.push(col.advertencia);
      logger.warn({ modulo: "esquema-drift", ddl: col.ddl }, "esquema: columna faltante agregada %s.%s", col.tabla, col.columna);
    } catch (err) {
      resultado.errores.push({ ddl: col.ddl, error: err instanceof Error ? err.message : String(err) });
      logger.error({ modulo: "esquema-drift", ddl: col.ddl, err }, "esquema: error agregando columna %s.%s", col.tabla, col.columna);
    }
  }

  for (const t of drift.tablasFaltantes) {
    let ok = true;
    for (const ddl of t.ddl) {
      try {
        await db.execute(sql.raw(ddl));
      } catch (err) {
        ok = false;
        resultado.errores.push({ ddl, error: err instanceof Error ? err.message : String(err) });
        logger.error({ modulo: "esquema-drift", ddl, err }, "esquema: error creando tabla %s", t.tabla);
        break;
      }
    }
    if (ok) {
      resultado.tablasCreadas.push(t.tabla);
      logger.warn({ modulo: "esquema-drift", tabla: t.tabla }, "esquema: tabla faltante creada %s", t.tabla);
    }
    resultado.advertencias.push(...t.advertencias);
  }

  return resultado;
}

/** Punto de entrada al arrancar: nunca tira — loguea y sigue. */
export async function sincronizarEsquemaAlArrancar(): Promise<void> {
  try {
    const res = await sincronizarEsquema();
    const total = res.columnasAgregadas.length + res.tablasCreadas.length;
    if (total === 0 && res.errores.length === 0) {
      logger.info({ modulo: "esquema-drift" }, "esquema: sin drift — base al día con el esquema Drizzle");
      return;
    }
    logger.warn(
      {
        modulo: "esquema-drift",
        columnasAgregadas: res.columnasAgregadas,
        tablasCreadas: res.tablasCreadas,
        advertencias: res.advertencias,
        errores: res.errores,
      },
      "esquema: sincronización aplicó %d cambio(s), %d error(es)",
      total,
      res.errores.length,
    );
  } catch (err) {
    logger.error({ modulo: "esquema-drift", err }, "esquema: fallo crítico en la sincronización al arrancar");
  }
}
