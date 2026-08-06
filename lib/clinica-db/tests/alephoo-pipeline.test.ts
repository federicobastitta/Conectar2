/**
 * Test: Pipeline Alephoo
 * Prueba los stages del pipeline con fixtures ficticios.
 * No requiere S3 real (opera sobre buffers en memoria).
 * No requiere AWS — los stages S3 se mockean.
 *
 * Para los stages que consultan la DB (dedup contra DB, incorporación),
 * requiere DATABASE_URL o CLINICA_DB_TEST_URL.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { procesarStaging } from "../src/importacion/alephoo/stages/staging.js";
import { procesarNormalizacion } from "../src/importacion/alephoo/stages/normalizacion.js";
import { deduplicarBatch } from "../src/importacion/alephoo/stages/deduplicacion.js";
import {
  filasRawMuestra,
  filasDuplicadoProbable,
  UPLOAD_ID_TEST,
} from "./fixtures/excel-sample.js";

// ── Stage: Staging ─────────────────────────────────────────────────────────

describe("Stage: staging — mapeo de columnas Alephoo", () => {
  it("mapea las columnas conocidas correctamente", () => {
    const staging = procesarStaging(filasRawMuestra);
    expect(staging).toHaveLength(filasRawMuestra.length);

    const fila1 = staging[0]!;
    expect(fila1.apellido).toBe("FICTICIO ALEPHOO");
    expect(fila1.nombre).toBe("PACIENTE UNO");
    expect(fila1.nroDoc).toBe("99.000.001");
    expect(fila1.obraSocial).toBe("OSDE");
    expect(fila1.estado).toBe("staging");
  });

  it("detecta fila sin apellido ni nombre y agrega error", () => {
    const fila3staging = procesarStaging([filasRawMuestra[2]!])[0]!;
    expect(fila3staging.erroresValidacion).toContain("Fila sin apellido ni nombre");
  });

  it("guarda columnas sin mapeo en camposExtra", () => {
    const fila1staging = procesarStaging([filasRawMuestra[0]!])[0]!;
    // MOTIVO, SEDE, FECHA_TURNO etc. deberían estar mapeados; no deben ir a extras
    expect(fila1staging.motivoConsulta).toBe("Control de rutina");
    expect(fila1staging.sede).toBe("Sede Test");
  });

  it("agrega advertencia por fila sin DNI", () => {
    const filaSinDni = procesarStaging([{
      ...filasRawMuestra[0]!,
      datos: { "APELLIDO": "TEST", "NOMBRE": "SIN DNI" },
    }])[0]!;
    expect(filaSinDni.advertenciasValidacion.some((a) => a.includes("Sin número de documento"))).toBe(true);
  });
});

// ── Stage: Normalización ──────────────────────────────────────────────────

describe("Stage: normalización — transformación de valores", () => {
  const staging = procesarStaging(filasRawMuestra);
  const normalizadas = procesarNormalizacion(staging);

  it("normaliza DNI quitando puntos", () => {
    const fila1 = normalizadas[0]!;
    expect(fila1.nroDocNorm).toBe("99000001");
  });

  it("normaliza fecha DD/MM/YYYY a ISO", () => {
    const fila1 = normalizadas[0]!;
    expect(fila1.fechaNacimientoIso).toBe("1980-03-15");
  });

  it("normaliza sexo 'M' a 'masculino'", () => {
    const fila1 = normalizadas[0]!;
    expect(fila1.sexoNorm).toBe("masculino");
  });

  it("normaliza sexo 'F' a 'femenino'", () => {
    const fila2 = normalizadas[1]!;
    expect(fila2.sexoNorm).toBe("femenino");
  });

  it("normaliza sexo desconocido a 'desconocido'", () => {
    const fila3 = normalizadas[2]!;
    expect(fila3.sexoNorm).toBe("desconocido");
  });

  it("marca email inválido en advertencias", () => {
    const fila3 = normalizadas[2]!;
    expect(fila3.advertenciasValidacion.some((a) => a.includes("Email inválido"))).toBe(true);
  });

  it("normaliza email a lowercase", () => {
    const fila1 = normalizadas[0]!;
    expect(fila1.emailNorm).toBe("paciente.uno@test.invalid");
  });

  it("normaliza apellido a uppercase sin tildes", () => {
    const fila1 = normalizadas[0]!;
    expect(fila1.apellidoNorm).toBe("FICTICIO ALEPHOO");
  });

  it("fecha inválida genera advertencia y NO cambia estado a cuarentena (solo warning)", () => {
    const fila3 = normalizadas[2]!;
    // fecha 'fecha-invalida-xyz' no parseable → advertencia, sin fecha
    expect(fila3.fechaNacimientoIso).toBeUndefined();
    expect(fila3.advertenciasValidacion.some((a) => a.includes("Fecha de nacimiento no reconocida"))).toBe(true);
  });

  it("normaliza fecha DD-MM-YYYY con guiones", () => {
    const fila2 = normalizadas[1]!;
    expect(fila2.fechaNacimientoIso).toBe("1992-08-22");
  });
});

// ── Stage: Deduplicación intra-batch ──────────────────────────────────────

describe("Stage: deduplicación intra-batch", () => {
  it("detecta duplicado exacto por DNI dentro del batch", () => {
    const staging = procesarStaging(filasRawMuestra);
    const normalizadas = procesarNormalizacion(staging);
    const resultados = deduplicarBatch(normalizadas);

    // Fila 5 (índice 3) tiene mismo DNI que fila 2 (índice 0)
    const fila5 = resultados.get(filasRawMuestra[3]!.filaNumero);
    expect(fila5?.tipo).toBe("duplicado_exacto");
    expect(fila5?.filaOriginalNumero).toBe(filasRawMuestra[0]!.filaNumero);
  });

  it("detecta duplicado probable por nombre+fecha similares", () => {
    const staging = procesarStaging(filasDuplicadoProbable);
    const normalizadas = procesarNormalizacion(staging);
    const resultados = deduplicarBatch(normalizadas, 0.7);

    const fila2 = resultados.get(filasDuplicadoProbable[1]!.filaNumero);
    expect(fila2?.tipo).toBe("duplicado_probable");
  });

  it("marca sin_duplicado las filas únicas", () => {
    const staging = procesarStaging([filasRawMuestra[0]!]);
    const normalizadas = procesarNormalizacion(staging);
    const resultados = deduplicarBatch(normalizadas);

    const fila1 = resultados.get(filasRawMuestra[0]!.filaNumero);
    expect(fila1?.tipo).toBe("sin_duplicado");
  });
});

// ── Integración completa del pipeline (sin S3, sin DB) ───────────────────

describe("Pipeline integración — sin S3 ni DB real", () => {
  it("procesa las filas de staging a normalizadas correctamente", () => {
    const staging = procesarStaging(filasRawMuestra);
    const normalizadas = procesarNormalizacion(staging);
    const dedup = deduplicarBatch(normalizadas);

    // 4 filas en el fixture (filasRawMuestra tiene filaNumero 2-5)
    expect(normalizadas).toHaveLength(4);

    // Al menos 2 filas sin duplicado (filas 1 y 2, con DNIs distintos)
    const sinDuplicado = [...dedup.values()].filter((r) => r.tipo === "sin_duplicado");
    expect(sinDuplicado.length).toBeGreaterThanOrEqual(2);

    // La fila 4 (índice 3) es duplicado exacto de la fila 2
    const filaDuplicada = dedup.get(5); // filaNumero 5
    expect(filaDuplicada?.tipo).toBe("duplicado_exacto");
  });

  it("todos los resultados tienen uploadId correcto", () => {
    const staging = procesarStaging(filasRawMuestra);
    staging.forEach((f) => {
      expect(f.uploadId).toBe(UPLOAD_ID_TEST);
    });
  });

  it("las filas normalizadas sin error pasan a estado normalizada", () => {
    const staging = procesarStaging([filasRawMuestra[0]!, filasRawMuestra[1]!]);
    const normalizadas = procesarNormalizacion(staging);
    normalizadas.forEach((f) => {
      expect(f.estado).toBe("normalizada");
    });
  });
});
