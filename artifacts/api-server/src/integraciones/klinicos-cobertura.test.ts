import { describe, expect, it } from "vitest";
import { coberturaValidaEnKlinicos } from "./klinicos-cola";

// Regla general (Federico 02/08/2026): a Klinicos solo van obras sociales
// habilitadas (hoy IOMA). Particulares, PAMI y otras no llevan token.
describe("coberturaValidaEnKlinicos", () => {
  it("acepta IOMA en sus variantes de escritura", () => {
    expect(coberturaValidaEnKlinicos("IOMA")).toBe(true);
    expect(coberturaValidaEnKlinicos("ioma")).toBe(true);
    expect(coberturaValidaEnKlinicos("I.O.M.A.")).toBe(true);
    expect(coberturaValidaEnKlinicos("IOMA - 12345678")).toBe(true);
  });

  it("rechaza particulares, PAMI y otras obras sociales", () => {
    expect(coberturaValidaEnKlinicos(null)).toBe(false);
    expect(coberturaValidaEnKlinicos(undefined)).toBe(false);
    expect(coberturaValidaEnKlinicos("")).toBe(false);
    expect(coberturaValidaEnKlinicos("Particular")).toBe(false);
    expect(coberturaValidaEnKlinicos("PAMI")).toBe(false);
    expect(coberturaValidaEnKlinicos("OSDE 210")).toBe(false);
    expect(coberturaValidaEnKlinicos("Swiss Medical")).toBe(false);
  });
});
