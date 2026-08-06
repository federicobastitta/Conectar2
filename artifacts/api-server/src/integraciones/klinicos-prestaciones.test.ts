import { describe, it, expect } from "vitest";
import {
  esPracticaExcluida,
  enmascararToken,
  parsePrestaciones,
  elegirPrestacionParaAutorizar,
  evaluarRelectura,
  armarPlanPracticaSimulado,
  extraerAtencionId,
  pathDetalleAtencion,
  descubrirEndpoint,
  resultadoAutorizacionDesdeRelectura,
  resolverReintentoAutorizacion,
  type PrestacionFila,
  elegirNumeroNuevo,
  filaDesdeTextoCrudo,
} from "./klinicos-prestaciones";
import { flagsCreacionTrasSimulacion } from "./klinicos-worker";

// Tests puros (sin DB ni red) de las reglas fail-closed de la pantalla
// Prestaciones → Autorizar y del modo simulación (tarea RPA etapas 1-3).

describe("esPracticaExcluida (decisión 22/07/2026)", () => {
  it("excluye eco Doppler en cualquier texto", () => {
    expect(esPracticaExcluida(["ECO DOPPLER CARDIACO"])).toBe("eco Doppler");
    expect(esPracticaExcluida(["Ecografía doppler de miembros"])).toBe("eco Doppler");
  });
  it("excluye resonancias (RESONANCIA / RMN / RNM)", () => {
    expect(esPracticaExcluida([null, "Resonancia magnética de rodilla"])).toBe("resonancia");
    expect(esPracticaExcluida(["RMN cerebro"])).toBe("resonancia (RMN)");
    expect(esPracticaExcluida(["pedido RNM"])).toBe("resonancia (RNM)");
  });
  it("no excluye prácticas comunes ni matchea RMN dentro de otra palabra", () => {
    expect(esPracticaExcluida(["ELECTROCARDIOGRAMA EN CONSULTORIO"])).toBeNull();
    expect(esPracticaExcluida(["ECOGRAFIA ABDOMINAL", "control"])).toBeNull();
    expect(esPracticaExcluida(["ENFERMERIA"])).toBeNull();
  });
});

describe("enmascararToken", () => {
  it("solo muestra los últimos 4", () => {
    expect(enmascararToken("123456789")).toBe("••••6789");
  });
  it("tokens cortos muestran solo el último carácter", () => {
    expect(enmascararToken("123")).toBe("••••3");
  });
  it("null/vacío → null", () => {
    expect(enmascararToken(null)).toBeNull();
    expect(enmascararToken("   ")).toBeNull();
  });
});

// HTML mínimo con la estructura observada en el video (31/07/2026)
const HTML_GRILLA = `
<table><tbody>
<tr><td></td><td>C-2026-198668<br>31/07/2026</td><td>FRANGIS, PATRICIO (MP 238877)</td>
<td><span class="badge">CONFIRMADO</span> 31/07/2026</td><td><input type="text"></td><td>90123456</td><td></td></tr>
<tr><td></td><td>P-2026-198669<br>31/07/2026</td><td>FRANGIS, PATRICIO (MP 238877)</td>
<td><span class="badge">CONFIRMADO</span> 31/07/2026</td><td><input type="text"></td><td></td><td></td></tr>
</tbody></table>`;

describe("parsePrestaciones", () => {
  it("lee número, tipo, estado y bono de la grilla del detalle de atención", () => {
    const filas = parsePrestaciones(HTML_GRILLA);
    expect(filas).toHaveLength(2);
    expect(filas[0]).toMatchObject({ numero: "C-2026-198668", tipo: "C", estado: "CONFIRMADO", nroBono: "90123456" });
    expect(filas[1]).toMatchObject({ numero: "P-2026-198669", tipo: "P", estado: "CONFIRMADO", nroBono: null });
  });
  it("HTML inesperado → [] (fail-closed)", () => {
    expect(parsePrestaciones("<html><body>login</body></html>")).toEqual([]);
  });
});

describe("elegirPrestacionParaAutorizar (fail-closed del manual)", () => {
  const conf = (numero: string, nroBono: string | null = null, estado = "CONFIRMADO"): PrestacionFila => ({
    numero,
    tipo: numero.split("-")[0]!,
    estado,
    nroBono,
  });

  it("exactamente una CONFIRMADA sin bono → esa", () => {
    const r = elegirPrestacionParaAutorizar([conf("C-2026-1", "90123456"), conf("P-2026-2")]);
    expect(r).toMatchObject({ ok: true, fila: { numero: "P-2026-2" } });
  });
  it("cero candidatas → revisión (no adivinar)", () => {
    const r = elegirPrestacionParaAutorizar([conf("C-2026-1", "90123456")]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain("revisión");
  });
  it("más de una candidata → revisión (no adivinar)", () => {
    const r = elegirPrestacionParaAutorizar([conf("C-2026-1"), conf("P-2026-2")]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain("2 prestaciones");
  });
  it("grilla vacía → revisión (fail-closed)", () => {
    expect(elegirPrestacionParaAutorizar([]).ok).toBe(false);
  });
});

describe("elegirNumeroNuevo (prestación de consulta: fila nueva tras el POST)", () => {
  it("sin filas nuevas → null", () => {
    expect(elegirNumeroNuevo(["C-2026-1"], ["C-2026-1"])).toBeNull();
  });
  it("una fila nueva → esa", () => {
    expect(elegirNumeroNuevo([], ["C-2026-1"])).toBe("C-2026-1");
  });
  it("varias nuevas → prefiere la consulta C-", () => {
    expect(elegirNumeroNuevo(["P-2026-1"], ["P-2026-1", "P-2026-2", "C-2026-3"])).toBe("C-2026-3");
  });
  it("varias nuevas sin C- → la primera", () => {
    expect(elegirNumeroNuevo([], ["P-2026-2", "P-2026-3"])).toBe("P-2026-2");
  });
});

describe("evaluarRelectura (aceptado solo con bono/confirmación real)", () => {
  const fila = (estado: string, nroBono: string | null): PrestacionFila => ({
    numero: "P-2026-2",
    tipo: "P",
    estado,
    nroBono,
  });
  it("bono presente → aceptado", () => {
    expect(evaluarRelectura([fila("CONFIRMADO", "90123456")], "P-2026-2")).toMatchObject({ resultado: "aceptado", nroBono: "90123456" });
  });
  it("pasó a autorizada → aceptado", () => {
    expect(evaluarRelectura([fila("AUTORIZADA POR REALIZAR", null)], "P-2026-2")).toMatchObject({ resultado: "aceptado" });
  });
  it("sigue CONFIRMADO sin bono → rechazado", () => {
    expect(evaluarRelectura([fila("CONFIRMADO", null)], "P-2026-2")).toMatchObject({ resultado: "rechazado" });
  });
  it("desaparece de la grilla → incierto (nunca reintentar consumo)", () => {
    expect(evaluarRelectura([], "P-2026-2").resultado).toBe("incierto");
  });
});

describe("armarPlanPracticaSimulado", () => {
  it("enmascara el token y arma el plan del form calibrado", () => {
    const plan = armarPlanPracticaSimulado({
      practicaCodigos: ["170101"],
      prescriptorNombre: "SAEZ, IGNACIO",
      prescriptorMatricula: "237810",
      prescriptorEspecialidad: "CLINICA MEDICA",
      efectorNombre: "FRANGIS, PATRICIO",
      cie10Codigo: "I10",
      cie10Descripcion: "hipertensión arterial",
      tokenAutorizacion: "987654321",
    });
    expect(plan.url).toBe("/ordenPrestacion/create/{atencionId}/3");
    expect(plan.practicaCodigos).toEqual(["170101"]);
    expect(plan.tokenEnmascarado).toBe("••••4321");
    expect(JSON.stringify(plan)).not.toContain("987654321");
    expect(plan.advertencias).toEqual([]);
  });
  it("advierte diagnóstico faltante (el portal lo rechaza) y matrícula faltante", () => {
    const plan = armarPlanPracticaSimulado({
      practicaCodigos: ["170101"],
      prescriptorNombre: null,
      prescriptorMatricula: null,
      prescriptorEspecialidad: null,
      efectorNombre: null,
      cie10Codigo: null,
      cie10Descripcion: null,
      tokenAutorizacion: null,
    });
    expect(plan.advertencias.length).toBe(3);
  });
});

// ── Etapa 4: modo asistido (ejecución real con confirmación del operador) ──

describe("extraerAtencionId / pathDetalleAtencion", () => {
  it("extrae un GUID de la URL del detalle", () => {
    expect(extraerAtencionId("/atencion/detalle/atencionesEstados/a1b2c3d4-e5f6-7890-abcd-ef0123456789")).toBe(
      "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
    );
  });
  it("extrae un id numérico como último recurso", () => {
    expect(extraerAtencionId("/atencion/detalle/atencionesEstados/123456")).toBe("123456");
  });
  it("URL sin id → null", () => {
    expect(extraerAtencionId("/atencion/detalle")).toBeNull();
  });
  it("pathDetalleAtencion normaliza URLs absolutas", () => {
    expect(pathDetalleAtencion("https://klinicos.aceapp.ar/atencion/detalle/x?y=1")).toBe("/atencion/detalle/x?y=1");
    expect(pathDetalleAtencion("/atencion/detalle/x")).toBe("/atencion/detalle/x");
  });
});

describe("descubrirEndpoint (calibración en vivo, fail-closed)", () => {
  it("descubre una URL de autorización en el JS de la página", () => {
    const html = `<script>$.ajax({ url: '/ordenPrestacion/autorizarToken', type: 'POST' });</script>`;
    expect(descubrirEndpoint(html, /autoriza/i)).toBe("/ordenPrestacion/autorizarToken");
  });
  it("ignora URLs externas y sin match → null", () => {
    const html = `<a href="https://otra.web/autorizar">x</a><form action="/ordenPrestacion/create/1/3">`;
    expect(descubrirEndpoint(html, /autoriza/i)).toBeNull();
  });
});

describe("resultadoAutorizacionDesdeRelectura (exigir N° de bono)", () => {
  const fila = (estado: string, nroBono: string | null): PrestacionFila => ({
    numero: "P-2026-2",
    tipo: "P",
    estado,
    nroBono,
  });
  it("aceptado SOLO con bono visible", () => {
    expect(resultadoAutorizacionDesdeRelectura([fila("CONFIRMADO", "90123456")], "P-2026-2")).toMatchObject({
      resultado: "aceptado",
      nroBono: "90123456",
    });
  });
  it("AUTORIZADA sin bono → incierto (verificación manual, sin reintento)", () => {
    const r = resultadoAutorizacionDesdeRelectura([fila("AUTORIZADA POR REALIZAR", null)], "P-2026-2");
    expect(r.resultado).toBe("incierto");
    expect(r.detalle).toMatch(/SIN N° de bono/i);
  });
  it("CONFIRMADO intacto sin bono → rechazado", () => {
    expect(resultadoAutorizacionDesdeRelectura([fila("CONFIRMADO", null)], "P-2026-2").resultado).toBe("rechazado");
  });
  it("fila desaparecida → incierto, nunca reintentar", () => {
    const r = resultadoAutorizacionDesdeRelectura([], "P-2026-2");
    expect(r.resultado).toBe("incierto");
    expect(r.detalle).toMatch(/NO reintentar/i);
  });
});

describe("resolverReintentoAutorizacion (POST previo con resultado desconocido)", () => {
  const fila = (numero: string, nroBono: string | null): PrestacionFila => ({
    numero,
    tipo: numero.startsWith("P") ? "P" : "C",


    estado: "CONFIRMADO",
    nroBono,
  });
  it("aceptado SOLO si la prestación objetivo tiene bono", () => {
    const r = resolverReintentoAutorizacion([fila("C-2026-1", "111"), fila("P-2026-2", "90123456")], "P-2026-2");
    expect(r).toMatchObject({ resultado: "aceptado", nroBono: "90123456" });
  });
  it("bono en OTRA prestación (histórica/consulta) NO cuenta → incierto", () => {
    const r = resolverReintentoAutorizacion([fila("C-2026-1", "111"), fila("P-2026-2", null)], "P-2026-2");
    expect(r.resultado).toBe("incierto");
    expect(r.detalle).toMatch(/NO se reenvía/i);
  });
  it("sin número de prestación objetivo conocido → siempre incierto", () => {
    const r = resolverReintentoAutorizacion([fila("P-2026-2", "90123456")], null);
    expect(r.resultado).toBe("incierto");
  });
  it("prestación objetivo desaparecida de la grilla → incierto", () => {
    expect(resolverReintentoAutorizacion([fila("C-2026-1", null)], "P-2026-9").resultado).toBe("incierto");
  });
});

describe("flagsCreacionTrasSimulacion (re-simular no borra lo ya creado)", () => {
  it("preserva prestación creada en un intento real previo aunque la simulación no cree nada", () => {
    expect(
      flagsCreacionTrasSimulacion(
        { ingresoCreado: false, prestacionCreada: false },
        { klinicosIngresoCreado: true, klinicosPrestacionCreada: true },
      ),
    ).toEqual({ klinicosIngresoCreado: true, klinicosPrestacionCreada: true });
  });
  it("marca lo creado en esta corrida sin exigir estado previo", () => {
    expect(
      flagsCreacionTrasSimulacion(
        { ingresoCreado: true, prestacionCreada: true },
        { klinicosIngresoCreado: false, klinicosPrestacionCreada: false },
      ),
    ).toEqual({ klinicosIngresoCreado: true, klinicosPrestacionCreada: true });
  });
  it("prestacionCreada ausente no degrada el flag previo", () => {
    expect(
      flagsCreacionTrasSimulacion({ ingresoCreado: false }, { klinicosIngresoCreado: false, klinicosPrestacionCreada: true }),
    ).toEqual({ klinicosIngresoCreado: false, klinicosPrestacionCreada: true });
  });
});

describe("filaDesdeTextoCrudo (grilla AJAX DataTables — el HTML del detalle no trae filas)", () => {
  it("parsea número, estado y bono de una row JSON con HTML escapado", () => {
    const crudo = JSON.stringify([
      '<td><a href="/ordenPrestacion/detalle/123">C-2026-198765</a></td>',
      "<td>CONSULTA MEDICA</td>",
      '<td><span class="badge">FACTURABLE</span></td>',
      "<td>18409856</td>",
      '<td><button data-idOrdenPrestacion="456789">Autorizar</button></td>',
    ]);
    const fila = filaDesdeTextoCrudo(crudo);
    expect(fila).toEqual({ numero: "C-2026-198765", tipo: "C", estado: "FACTURABLE", nroBono: "18409856" });
  });
  it("CONFIRMADO sin bono → nroBono null", () => {
    const crudo = JSON.stringify(["<td>C-2026-1</td>", "<td>CONFIRMADO</td>", '<td><input value=""/></td>']);
    expect(filaDesdeTextoCrudo(crudo)).toEqual({ numero: "C-2026-1", tipo: "C", estado: "CONFIRMADO", nroBono: null });
  });
  it("row sin número de prestación → null (fail-closed)", () => {
    expect(filaDesdeTextoCrudo(JSON.stringify(["<td>sin datos</td>"]))).toBeNull();
  });
  it("unicode escapes \\u003c de DataTables no rompen el parseo", () => {
    const crudo = '["\\u003ctd\\u003eC-2026-7\\u003c/td\\u003e","\\u003ctd\\u003eAUTORIZADA POR REALIZAR\\u003c/td\\u003e"]';
    const fila = filaDesdeTextoCrudo(crudo);
    expect(fila?.numero).toBe("C-2026-7");
    expect(fila?.estado).toBe("AUTORIZADA POR REALIZAR");
  });
});
