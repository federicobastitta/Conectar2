import { describe, it, expect, vi, beforeEach } from "vitest";

// Test unitario del semáforo interno: la salud debe probar el login real
// (mockeado acá) y cachear ~5 minutos. No toca la DB ni Klinicos real.
vi.mock("./klinicos-robot", () => ({
  klinicosHabilitado: vi.fn(() => true),
  validarTokenConsultaKlinicos: vi.fn(),
  loginKlinicos: vi.fn(),
  seleccionarContextoKlinicos: vi.fn(),
  CookieJar: class {
    header() {
      return "";
    }
    store() {}
  },
}));

import {
  internoTokenValidationProvider,
  _resetSaludKlinicosCache,
} from "./token-validation-provider";
import {
  klinicosHabilitado,
  loginKlinicos,
  seleccionarContextoKlinicos,
} from "./klinicos-robot";

const mockHabilitado = vi.mocked(klinicosHabilitado);
const mockLogin = vi.mocked(loginKlinicos);
const mockContexto = vi.mocked(seleccionarContextoKlinicos);

beforeEach(() => {
  _resetSaludKlinicosCache();
  vi.clearAllMocks();
  mockHabilitado.mockReturnValue(true);
});

describe("internoTokenValidationProvider.checkRobotHealth", () => {
  it("sin credenciales: no disponible con motivo, sin llamar a Klinicos", async () => {
    mockHabilitado.mockReturnValue(false);
    const estado = await internoTokenValidationProvider.checkRobotHealth();
    expect(estado.disponible).toBe(false);
    expect(estado.motivo).toMatch(/credenciales/i);
    expect(mockLogin).not.toHaveBeenCalled();
  });

  it("login + contexto OK: disponible y sesión activa", async () => {
    mockLogin.mockResolvedValue({ ok: true, detalle: "Login OK" });
    mockContexto.mockResolvedValue({ ok: true, detalle: "Contexto OK" });
    const estado = await internoTokenValidationProvider.checkRobotHealth();
    expect(estado.disponible).toBe(true);
    expect(estado.sesionKlinicos).toBe("activa");
    expect(estado.motivo).toBeNull();
  });

  it("credenciales rechazadas: no disponible con motivo de revisar usuario/clave", async () => {
    mockLogin.mockResolvedValue({
      ok: false,
      detalle: "El portal rechazó las credenciales (usuario o contraseña incorrecta)",
    });
    const estado = await internoTokenValidationProvider.checkRobotHealth();
    expect(estado.disponible).toBe(false);
    expect(estado.motivo).toMatch(/usuario\/clave de Klinicos/i);
    expect(mockContexto).not.toHaveBeenCalled();
  });

  it("falla la selección de contexto: no disponible con detalle", async () => {
    mockLogin.mockResolvedValue({ ok: true, detalle: "Login OK" });
    mockContexto.mockResolvedValue({ ok: false, detalle: "POST contexto → 200" });
    const estado = await internoTokenValidationProvider.checkRobotHealth();
    expect(estado.disponible).toBe(false);
    expect(estado.motivo).toMatch(/selección de contexto/i);
  });

  it("error técnico (excepción): no disponible, no explota", async () => {
    mockLogin.mockRejectedValue(new Error("ECONNRESET"));
    const estado = await internoTokenValidationProvider.checkRobotHealth();
    expect(estado.disponible).toBe(false);
    expect(estado.motivo).toMatch(/ECONNRESET/);
  });

  it("cachea el resultado ~5 minutos: segunda consulta no vuelve a loguear", async () => {
    mockLogin.mockResolvedValue({ ok: true, detalle: "Login OK" });
    mockContexto.mockResolvedValue({ ok: true, detalle: "Contexto OK" });
    await internoTokenValidationProvider.checkRobotHealth();
    await internoTokenValidationProvider.checkRobotHealth();
    expect(mockLogin).toHaveBeenCalledTimes(1);
  });

  it("reprueba forzada: tras corregir la clave, resetear la caché muestra el verde al instante", async () => {
    // Primera prueba: clave incorrecta → rojo cacheado.
    mockLogin.mockResolvedValue({
      ok: false,
      detalle: "usuario o contraseña incorrecta",
    });
    const rojo = await internoTokenValidationProvider.checkRobotHealth();
    expect(rojo.disponible).toBe(false);

    // El operador corrige la clave, pero sin forzar la caché sigue en rojo.
    mockLogin.mockResolvedValue({ ok: true, detalle: "Login OK" });
    mockContexto.mockResolvedValue({ ok: true, detalle: "Contexto OK" });
    const cacheado = await internoTokenValidationProvider.checkRobotHealth();
    expect(cacheado.disponible).toBe(false);

    // ?forzar=true en el endpoint invoca este reset: la próxima consulta reprueba.
    _resetSaludKlinicosCache();
    const verde = await internoTokenValidationProvider.checkRobotHealth();
    expect(verde.disponible).toBe(true);
    expect(verde.sesionKlinicos).toBe("activa");
  });

  it("consultas concurrentes se coalescen en una sola prueba", async () => {
    mockLogin.mockResolvedValue({ ok: true, detalle: "Login OK" });
    mockContexto.mockResolvedValue({ ok: true, detalle: "Contexto OK" });
    await Promise.all([
      internoTokenValidationProvider.checkRobotHealth(),
      internoTokenValidationProvider.checkRobotHealth(),
      internoTokenValidationProvider.checkRobotHealth(),
    ]);
    expect(mockLogin).toHaveBeenCalledTimes(1);
  });
});
