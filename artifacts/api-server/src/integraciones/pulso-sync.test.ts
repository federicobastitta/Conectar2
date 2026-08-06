import { describe, it, expect } from "vitest";
import { mapPulsoPaciente } from "./pulso-sync";
import type { PulsoPaciente } from "./pulso-client";

function base(overrides: Partial<PulsoPaciente> = {}): PulsoPaciente {
  return {
    id: "uuid-1",
    dni: "30111222",
    nombre: "Juan",
    apellido: "Pérez",
    fecha_nacimiento: "1985-06-15",
    sexo: "M",
    telefono: "1133334444",
    whatsapp: "1155556666",
    email: "juan@example.com",
    obra_social: { nombre: "IOMA" },
    numero_afiliado: "AF-123",
    created_at: "2026-01-01T10:00:00Z",
    updated_at: "2026-01-02T10:00:00Z",
    ...overrides,
  };
}

describe("mapPulsoPaciente", () => {
  it("mapea todos los campos presentes", () => {
    const m = mapPulsoPaciente(base());
    expect(m.nombre).toBe("Juan");
    expect(m.apellido).toBe("Pérez");
    expect(m.dni).toBe("30111222");
    expect(m.campos).toEqual({
      fechaNacimiento: "1985-06-15",
      sexo: "M",
      telefono: "1155556666",
      email: "juan@example.com",
      cobertura: "IOMA",
      nroAfiliado: "AF-123",
    });
  });

  it("el móvil (whatsapp) es el teléfono principal y el fijo se descarta", () => {
    const conAmbos = mapPulsoPaciente(base());
    expect(conAmbos.campos.telefono).toBe("1155556666");
    expect(conAmbos.campos.telefonoAlternativo).toBeUndefined();

    const soloFijo = mapPulsoPaciente(base({ whatsapp: null }));
    expect(soloFijo.campos.telefono).toBe("1133334444");
  });

  it("omite campos nulos o vacíos (no pisa datos locales)", () => {
    const m = mapPulsoPaciente(
      base({ telefono: null, whatsapp: "", email: null, obra_social: null, numero_afiliado: "  " }),
    );
    expect(m.campos.telefono).toBeUndefined();
    expect(m.campos.telefonoAlternativo).toBeUndefined();
    expect(m.campos.email).toBeUndefined();
    expect(m.campos.cobertura).toBeUndefined();
    expect(m.campos.nroAfiliado).toBeUndefined();
    expect(m.campos.fechaNacimiento).toBe("1985-06-15");
  });

  it("normaliza obra_social anidada a cobertura", () => {
    const m = mapPulsoPaciente(base({ obra_social: { nombre: "OSDE" } }));
    expect(m.campos.cobertura).toBe("OSDE");
  });

  it("dni null se preserva como null", () => {
    const m = mapPulsoPaciente(base({ dni: null }));
    expect(m.dni).toBeNull();
  });

  it("usa placeholders cuando falta nombre/apellido", () => {
    const m = mapPulsoPaciente(base({ nombre: null, apellido: "" }));
    expect(m.nombre).toBe("Sin nombre");
    expect(m.apellido).toBe("Sin apellido");
  });

  it("recorta espacios en los valores", () => {
    const m = mapPulsoPaciente(base({ nombre: "  Ana  ", dni: " 27888999 " }));
    expect(m.nombre).toBe("Ana");
    expect(m.dni).toBe("27888999");
  });
});
