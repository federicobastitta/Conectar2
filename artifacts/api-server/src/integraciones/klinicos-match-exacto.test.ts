import { describe, expect, it } from "vitest";
import { machearOpcion } from "./klinicos-robot";
import { contienePalabrasCompletas } from "./klinicos-worker";

// Regla 7 (fail-closed): machearOpcion solo elige con coincidencia exacta o
// con TODAS las palabras presentes en exactamente una opción. Nunca "mejor
// puntaje" parcial ni empates.
describe("machearOpcion fail-closed", () => {
  const opciones = [
    { Text: "GARCIA, JUAN", Value: "1" },
    { Text: "GARCIA, JUANA", Value: "2" },
    { Text: "PEREZ, MARIA", Value: "3" },
  ];

  it("machea por igualdad exacta normalizada", () => {
    expect(machearOpcion(opciones, "Pérez, María")?.Value).toBe("3");
  });

  it("machea cuando todas las palabras están en exactamente una opción", () => {
    expect(machearOpcion(opciones, "juana.garcia")?.Value).toBe("2");
  });

  it("NO elige por puntaje parcial: palabra faltante → null", () => {
    // "GARCIA RODRIGO" no existe; antes el mejor puntaje habría elegido un García.
    expect(machearOpcion(opciones, "Garcia Rodrigo")).toBeNull();
  });

  it("ambigüedad (varias candidatas con todas las palabras) → null", () => {
    // "garcia" está en dos opciones → revisión humana, no adivinar.
    expect(machearOpcion(opciones, "garcia")).toBeNull();
  });

  it("sin buscado o sin palabras útiles → null", () => {
    expect(machearOpcion(opciones, null)).toBeNull();
    expect(machearOpcion(opciones, "a b")).toBeNull();
  });

  it("contienePalabrasCompletas: no machea substrings dentro de otra palabra", () => {
    expect(contienePalabrasCompletas("ESTUDIO ECOGRAFICO DE ABDOMEN", "ECO")).toBe(false);
    expect(contienePalabrasCompletas("IMAGENES S C ECO ABDOMINAL", "ECO ABDOMINAL")).toBe(true);
    expect(contienePalabrasCompletas("RX TORAX FRENTE", "RX TORAX")).toBe(true);
    expect(contienePalabrasCompletas("RX TORAX FRENTE", "TORAX PERFIL")).toBe(false);
    expect(contienePalabrasCompletas("ALGO", "")).toBe(false);
  });

  it("prefijo de nombre NO machea: JUAN no elige a JUANA", () => {
    const soloJuana = [{ Text: "GARCIA, JUANA", Value: "2" }, { Text: "PEREZ, MARIA", Value: "3" }];
    // Antes "JUAN" era substring de "JUANA" y la elegía por ser única.
    expect(machearOpcion(soloJuana, "Garcia Juan")).toBeNull();
  });

  it("empate exacto entre opciones duplicadas → null", () => {
    const dup = [
      { Text: "LOPEZ, ANA", Value: "1" },
      { Text: "Lopez, Ana", Value: "2" },
    ];
    expect(machearOpcion(dup, "LOPEZ ANA")).toBeNull();
  });
});
