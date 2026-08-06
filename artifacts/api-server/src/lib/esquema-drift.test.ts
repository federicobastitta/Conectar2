import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { ordenesPracticasTable, turnosTable } from "@workspace/db";
import {
  tablasDelEsquema,
  detectarDrift,
  generarDDLColumnaFaltante,
  generarDDLTablaFaltante,
  snapshotBaseActual,
  type SnapshotDB,
} from "./esquema-drift";

function snapshotDe(...tablas: Array<{ nombre: string; sinColumnas?: string[] }>): SnapshotDB {
  const mapa = new Map<string, Set<string>>();
  for (const t of tablasDelEsquema()) {
    const cfg = getTableConfig(t);
    const spec = tablas.find((x) => x.nombre === cfg.name);
    // por defecto todas las tablas completas; las pasadas pueden omitir columnas
    const cols = new Set(cfg.columns.map((c) => c.name));
    if (spec?.sinColumnas) for (const c of spec.sinColumnas) cols.delete(c);
    mapa.set(cfg.name, cols);
  }
  return { tablas: mapa };
}

describe("esquema-drift: detección", () => {
  it("descubre las tablas del esquema Drizzle", () => {
    const nombres = tablasDelEsquema().map((t) => getTableConfig(t).name);
    expect(nombres).toContain("ordenes_practicas");
    expect(nombres).toContain("turnos");
    expect(nombres.length).toBeGreaterThan(20);
  });

  it("sin drift cuando la base tiene todo", () => {
    const drift = detectarDrift(snapshotDe());
    expect(drift.tablasFaltantes).toHaveLength(0);
    expect(drift.columnasFaltantes).toHaveLength(0);
  });

  it("detecta la columna faltante del caso real (ordenes_practicas.turno_id)", () => {
    const drift = detectarDrift(
      snapshotDe({ nombre: "ordenes_practicas", sinColumnas: ["turno_id"] }),
    );
    expect(drift.columnasFaltantes).toHaveLength(1);
    const col = drift.columnasFaltantes[0];
    expect(col.tabla).toBe("ordenes_practicas");
    expect(col.columna).toBe("turno_id");
    expect(col.ddl).toBe(
      'ALTER TABLE "ordenes_practicas" ADD COLUMN IF NOT EXISTS "turno_id" integer',
    );
  });

  it("detecta una tabla faltante completa", () => {
    const mapa = snapshotDe();
    mapa.tablas.delete("ordenes_practicas");
    const drift = detectarDrift(mapa);
    expect(drift.tablasFaltantes.map((t) => t.tabla)).toContain("ordenes_practicas");
  });
});

describe("esquema-drift: generación de DDL", () => {
  it("columna NOT NULL con default se agrega NOT NULL", () => {
    const cfg = getTableConfig(ordenesPracticasTable);
    const estado = cfg.columns.find((c) => c.name === "estado");
    // si el esquema cambia y estado deja de existir, ajustar el test
    expect(estado).toBeDefined();
    if (!estado) return;
    const ddl = generarDDLColumnaFaltante("ordenes_practicas", estado);
    expect(ddl.ddl).toContain("ADD COLUMN IF NOT EXISTS");
    if (estado.notNull && estado.hasDefault) {
      expect(ddl.ddl).toContain("DEFAULT");
      expect(ddl.ddl).toContain("NOT NULL");
      expect(ddl.advertencia).toBeUndefined();
    }
  });

  it("columna NOT NULL sin default se agrega nullable con advertencia", () => {
    const cfg = getTableConfig(turnosTable);
    const sinDefault = cfg.columns.find((c) => c.notNull && !c.hasDefault && !c.primary);
    expect(sinDefault).toBeDefined();
    if (!sinDefault) return;
    const ddl = generarDDLColumnaFaltante("turnos", sinDefault);
    expect(ddl.ddl).not.toContain("NOT NULL");
    expect(ddl.advertencia).toBeTruthy();
  });

  it("tabla faltante genera CREATE TABLE IF NOT EXISTS con PK", () => {
    const t = generarDDLTablaFaltante(ordenesPracticasTable);
    expect(t.ddl[0]).toContain('CREATE TABLE IF NOT EXISTS "ordenes_practicas"');
    expect(t.ddl[0]).toContain("PRIMARY KEY");
    expect(t.ddl[0]).toContain('"turno_id" integer');
  });

  it("todas las tablas del esquema generan DDL sin excepciones", () => {
    for (const t of tablasDelEsquema()) {
      const gen = generarDDLTablaFaltante(t);
      expect(gen.ddl.length).toBeGreaterThan(0);
      for (const cfg of getTableConfig(t).columns) {
        // ADD COLUMN nunca debe tirar para ninguna columna del esquema
        expect(generarDDLColumnaFaltante(gen.tabla, cfg).ddl).toContain("ADD COLUMN IF NOT EXISTS");
      }
    }
  });
});

describe("esquema-drift: contra la base de dev", () => {
  it("la base de dev no tiene drift respecto del esquema", async () => {
    const snapshot = await snapshotBaseActual();
    const drift = detectarDrift(snapshot);
    const faltantes = [
      ...drift.tablasFaltantes.map((t) => `tabla ${t.tabla}`),
      ...drift.columnasFaltantes.map((c) => `${c.tabla}.${c.columna}`),
    ];
    expect(faltantes).toEqual([]);
  });
});
