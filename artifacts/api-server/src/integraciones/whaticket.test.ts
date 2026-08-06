import { describe, it, expect } from "vitest";
import {
  extraerErrorWhaticket,
  enmascararNumero,
  normalizarTelefonoWhatsapp,
} from "./whaticket";

describe("whaticket", () => {
  it("extrae el error JSON de la API", () => {
    expect(extraerErrorWhaticket('{"error":"templateId is require when connection channel is WABA"}', 400)).toBe(
      "Whaticket rechazó el envío: templateId is require when connection channel is WABA",
    );
  });

  it("cae al mensaje genérico si la respuesta no es JSON o no trae error", () => {
    expect(extraerErrorWhaticket("<html>oops</html>", 500)).toBe("Whaticket respondió 500");
    expect(extraerErrorWhaticket('{"mensaje":"x"}', 400)).toBe("Whaticket respondió 400");
    expect(extraerErrorWhaticket('{"error":""}', 400)).toBe("Whaticket respondió 400");
  });

  it("enmascara números para logs", () => {
    expect(enmascararNumero("5493511234567")).toBe("****4567");
    expect(enmascararNumero("123")).toBe("****");
  });

  it("normaliza teléfonos argentinos", () => {
    expect(normalizarTelefonoWhatsapp("351 123-4567")).toBe("543511234567");
    expect(normalizarTelefonoWhatsapp("0351 1234567")).toBe("543511234567");
    expect(normalizarTelefonoWhatsapp("5493511234567")).toBe("5493511234567");
    expect(normalizarTelefonoWhatsapp("123")).toBeNull();
  });
});
