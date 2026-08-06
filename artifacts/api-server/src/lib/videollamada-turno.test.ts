import { describe, it, expect } from "vitest";
import { urlVideollamadaTurno } from "./videollamada-turno";

describe("urlVideollamadaTurno", () => {
  const base = { modalidad: "videoconsulta", qrCodigo: "ABC123", estado: "reservado" };

  it("genera la URL Jitsi para un turno de videoconsulta con QR", () => {
    expect(urlVideollamadaTurno(base)).toBe(
      "https://meet.jit.si/ConectarDx-Turno-ABC123#config.prejoinConfig.enabled=false",
    );
  });

  it("devuelve null para turnos presenciales", () => {
    expect(urlVideollamadaTurno({ ...base, modalidad: "presencial" })).toBeNull();
  });

  it("devuelve null sin qrCodigo", () => {
    expect(urlVideollamadaTurno({ ...base, qrCodigo: null })).toBeNull();
    expect(urlVideollamadaTurno({ ...base, qrCodigo: "" })).toBeNull();
  });

  it("devuelve null para turnos cancelados o ausentes", () => {
    expect(urlVideollamadaTurno({ ...base, estado: "cancelado" })).toBeNull();
    expect(urlVideollamadaTurno({ ...base, estado: "ausente" })).toBeNull();
  });

  it("genera URL en estados activos como confirmado o llamado", () => {
    expect(urlVideollamadaTurno({ ...base, estado: "confirmado" })).toContain("meet.jit.si");
    expect(urlVideollamadaTurno({ ...base, estado: "llamado" })).toContain("meet.jit.si");
  });
});
