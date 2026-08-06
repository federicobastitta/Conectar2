import { describe, it, expect } from "vitest";
import { mapPulsoEstudio } from "./pulso-estudios-sync";
import type { PulsoEstudio } from "./pulso-client";

function base(overrides: Partial<PulsoEstudio> = {}): PulsoEstudio {
  return {
    id: "estudio-uuid-1",
    id_legible: "RM-2026-000145",
    paciente: { id: "pac-uuid-1", dni: "30111222", nombre: "Juan", apellido: "Pérez" },
    tipo_estudio: { id: "te-1", nombre: "Cerebro simple", modalidad: "RM" },
    modalidad: "RM",
    sede: { id: "s-1", nombre: "Sede Centro", direccion: "Av. Colón 100" },
    medico_asignado: { first_name: "Ana", last_name: "López", matricula: "12345" },
    medico_derivante: { nombre: "Carlos", apellido: "Gómez", matricula: "999" },
    estado: "firmado",
    fecha_estudio: "2026-07-09",
    observaciones: "Sin contraste",
    tiene_informe: true,
    created_at: "2026-07-09T09:58:49Z",
    updated_at: "2026-07-10T10:00:00Z",
    informe: { id: "inf-uuid-1", firmado: true, firmado_at: "2026-07-10T10:00:00Z" },
    ...overrides,
  };
}

describe("mapPulsoEstudio", () => {
  it("mapea todos los campos presentes", () => {
    const m = mapPulsoEstudio(base());
    expect(m.pulsoId).toBe("estudio-uuid-1");
    expect(m.pacienteDni).toBe("30111222");
    expect(m.idLegible).toBe("RM-2026-000145");
    expect(m.modalidad).toBe("RM");
    expect(m.tipoEstudio).toBe("Cerebro simple");
    expect(m.sedeNombre).toBe("Sede Centro");
    expect(m.estado).toBe("firmado");
    expect(m.fechaEstudio).toBe("2026-07-09");
    expect(m.medicoAsignado).toBe("Ana López");
    expect(m.medicoDerivante).toBe("Carlos Gómez");
    expect(m.tieneInforme).toBe(true);
    expect(m.informePulsoId).toBe("inf-uuid-1");
    expect(m.informeFirmado).toBe(true);
    expect(m.informeFirmadoAt).toEqual(new Date("2026-07-10T10:00:00Z"));
  });

  it("cae a la modalidad del tipo_estudio si falta modalidad directa", () => {
    const m = mapPulsoEstudio(base({ modalidad: null }));
    expect(m.modalidad).toBe("RM");
  });

  it("recorta la fecha ISO a solo día", () => {
    const m = mapPulsoEstudio(base({ fecha_estudio: "2026-07-09T09:58:49Z" }));
    expect(m.fechaEstudio).toBe("2026-07-09");
  });

  it("maneja paciente/informe ausentes sin romper", () => {
    const m = mapPulsoEstudio(
      base({ paciente: null, informe: null, tiene_informe: false, medico_asignado: null }),
    );
    expect(m.pacienteDni).toBeNull();
    expect(m.tieneInforme).toBe(false);
    expect(m.informePulsoId).toBeNull();
    expect(m.informeFirmado).toBe(false);
    expect(m.informeFirmadoAt).toBeNull();
    expect(m.medicoAsignado).toBeNull();
  });

  it("infiere tieneInforme cuando hay objeto informe aunque falte el flag", () => {
    const m = mapPulsoEstudio(
      base({ tiene_informe: null, informe: { id: "inf-2", firmado: false, firmado_at: null } }),
    );
    expect(m.tieneInforme).toBe(true);
    expect(m.informeFirmado).toBe(false);
    expect(m.informeFirmadoAt).toBeNull();
  });
});
