import { describe, it, expect } from "vitest";
import {
  codigoFacturacionPractica,
  CODIGO_FACTURACION_CONSULTA,
} from "./klinicos-codigo-facturacion";

describe("codigoFacturacionPractica (planilla Conectar)", () => {
  it("prioriza el override manual codigo_facturacion", () => {
    expect(
      codigoFacturacionPractica({ codigoFacturacion: "  999999 ", codigos: ["170101"] }),
    ).toBe("999999");
  });

  it("código único viaja tal cual (ECG, consultas)", () => {
    expect(codigoFacturacionPractica({ codigos: ["170101"] })).toBe("170101");
    expect(codigoFacturacionPractica({ codigos: [CODIGO_FACTURACION_CONSULTA] })).toBe("420101");
  });

  it("combos de la planilla salen con el separador exacto, sin importar el orden", () => {
    expect(codigoFacturacionPractica({ codigos: ["420102", "290101", "290102"] })).toBe(
      "290101-290102-420102",
    );
    expect(codigoFacturacionPractica({ codigos: ["880502", "880501", "280102"] })).toBe(
      "880502-880501-280102",
    );
    expect(codigoFacturacionPractica({ codigos: ["180113", "180112"] })).toBe("180112-180113");
    expect(codigoFacturacionPractica({ codigos: ["180106", "881806"] })).toBe("180106-881806");
  });

  it("mamografía conserva las repeticiones (cantidades) con +", () => {
    expect(
      codigoFacturacionPractica({ codigos: ["340601", "340602", "340601", "340602"] }),
    ).toBe("340601+340601+340602+340602");
  });

  it("dopplers con sufijo /A /B respetan la planilla", () => {
    expect(codigoFacturacionPractica({ codigos: ["881841/B", "881841/A"] })).toBe(
      "881841/A+881841/B",
    );
    expect(codigoFacturacionPractica({ codigos: ["881841/A"] })).toBe("881841/A");
  });

  it("rx frente/perfil usa el formato literal de la planilla", () => {
    expect(codigoFacturacionPractica({ codigos: ["340301", "340302"] })).toBe("340301 / 340302");
  });

  it("codigoEnvio textual tiene máxima prioridad", () => {
    expect(
      codigoFacturacionPractica({
        codigoEnvio: " 881841/A+881841/B ",
        codigoFacturacion: "999999",
        codigos: ["170101"],
      }),
    ).toBe("881841/A+881841/B");
  });

  it("combo desconocido devuelve null (nunca se inventa un código); sin códigos devuelve null", () => {
    expect(codigoFacturacionPractica({ codigos: ["111111", "222222"] })).toBeNull();
    expect(codigoFacturacionPractica({ codigos: [] })).toBeNull();
    expect(codigoFacturacionPractica({ codigos: ["  "] })).toBeNull();
  });
});
