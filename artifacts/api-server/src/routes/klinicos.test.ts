import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  sesionesTable,
  pacientesTable,
  turnerasTable,
  turnosTable,
  klinicosTrabajos,
  klinicosReglasSector,
} from "@workspace/db";
import klinicosRouter from "./klinicos";
import { klinicosPrescriptores } from "@workspace/db";
import { encolarTrabajoKlinicos, encolarTurnosFuturosDeTurnera, resolverSectorServicio, esSectorConsultorio, invalidarCacheAutoencolado } from "../integraciones/klinicos-cola";
import { configSistemaTable } from "@workspace/db";
import { elegirPrescriptor } from "../integraciones/klinicos-worker";
import { hoyArgentina } from "../lib/tiempo";

// Tests de integración de la cola y endpoints Klinicos. Crean y limpian sus
// propios datos contra la DB de desarrollo.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TEST_EMAIL = `test-klinicos-${RUN_ID}@test.local`;
const TEST_DNI = `K${RUN_ID}`;
const TOKEN = `test-token-klinicos-${RUN_ID}`;

let server: Server;
let baseUrl: string;
let userId: number;
let pacienteId: number;
let turneraId: number;
let turnoId: number;
// La llave global klinicos_autoencolado de la DB compartida puede estar en
// "off" (operación real). Los tests fijan "on" y restauran el valor previo.
let autoencoladoPrevio: string | undefined;

beforeAll(async () => {
  const [cfg] = await db
    .select({ valor: configSistemaTable.valor })
    .from(configSistemaTable)
    .where(eq(configSistemaTable.clave, "klinicos_autoencolado"))
    .limit(1);
  autoencoladoPrevio = cfg ? cfg.valor : undefined;
  if (cfg) {
    await db
      .update(configSistemaTable)
      .set({ valor: "on" })
      .where(eq(configSistemaTable.clave, "klinicos_autoencolado"));
  }
  invalidarCacheAutoencolado();
  const app = express();
  const silent = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  app.use(express.json());
  app.use("/api", klinicosRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [user] = await db
    .insert(usersTable)
    .values({ email: TEST_EMAIL, passwordHash: "x", nombre: "Test Klinicos", rol: "admin" })
    .returning();
  userId = user!.id;

  await db.insert(sesionesTable).values({
    token: TOKEN,
    usuarioId: userId,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  const [paciente] = await db
    .insert(pacientesTable)
    .values({
      nombre: "Klini",
      apellido: `Test${RUN_ID}`,
      dni: TEST_DNI,
      telefono: "3510000000",
      sexo: "F",
      activo: true,
    })
    .returning();
  pacienteId = paciente!.id;

  const [turnera] = await db
    .insert(turnerasTable)
    .values({ nombre: `Ecografías Test ${RUN_ID}` })
    .returning();
  turneraId = turnera!.id;

  const [turno] = await db
    .insert(turnosTable)
    .values({
      turneraId,
      pacienteId,
      cobertura: "IOMA",
      fecha: hoyArgentina(),
      horaInicio: "08:00",
      horaFin: "08:30",
      estado: "arribo",
      motivoConsulta: "Ecografía de abdomen",
    })
    .returning();
  turnoId = turno!.id;
});

afterAll(async () => {
  if (autoencoladoPrevio !== undefined) {
    await db
      .update(configSistemaTable)
      .set({ valor: autoencoladoPrevio })
      .where(eq(configSistemaTable.clave, "klinicos_autoencolado"));
    invalidarCacheAutoencolado();
  }
  await db.delete(klinicosTrabajos).where(eq(klinicosTrabajos.pacienteId, pacienteId));
  await db.delete(turnosTable).where(eq(turnosTable.pacienteId, pacienteId));
  await db.delete(turnerasTable).where(eq(turnerasTable.id, turneraId));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  await db.delete(sesionesTable).where(eq(sesionesTable.token, TOKEN));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

const auth = { Authorization: `Bearer ${TOKEN}` };

describe("resolverSectorServicio", () => {
  it("mapea especialidades de consulta a CONSULTORIO por regla", async () => {
    expect(await resolverSectorServicio("CARDIOLOGIA")).toBe("CONSULTORIO");
    expect(await resolverSectorServicio("Cardiología")).toBe("CONSULTORIO");
  });

  it("usa la heurística de imágenes cuando no hay regla", async () => {
    expect(await resolverSectorServicio("Ecografías Generales")).toBe("IMAGENES S/C");
    expect(await resolverSectorServicio("Clínica desconocida")).toBe("CONSULTORIO");
  });
});

describe("esSectorConsultorio", () => {
  it("acepta variantes de escritura del sector consultorio", () => {
    expect(esSectorConsultorio("CONSULTORIO")).toBe(true);
    expect(esSectorConsultorio("Consultorios")).toBe(true);
    expect(esSectorConsultorio(" consultorio ")).toBe(true);
  });

  it("rechaza otros sectores", () => {
    expect(esSectorConsultorio("IMAGENES S/C")).toBe(false);
    expect(esSectorConsultorio("Guardia")).toBe(false);
  });
});

describe("encolarTrabajoKlinicos", () => {
  it("encola un trabajo con datos congelados del turno y paciente", async () => {
    await encolarTrabajoKlinicos(turnoId, null, "manual");
    const trabajos = await db
      .select()
      .from(klinicosTrabajos)
      .where(eq(klinicosTrabajos.pacienteId, pacienteId));
    expect(trabajos).toHaveLength(1);
    const t = trabajos[0]!;
    expect(t.dni).toBe(TEST_DNI);
    expect(t.estado).toBe("pendiente");
    expect(t.sectorServicio).toBe("IMAGENES S/C"); // turnera "Ecografías..." → heurística
    expect(t.motivo).toBe("Ecografía de abdomen");
  });

  it("no duplica el trabajo si se encola dos veces el mismo turno", async () => {
    await encolarTrabajoKlinicos(turnoId, null, "manual");
    const trabajos = await db
      .select()
      .from(klinicosTrabajos)
      .where(eq(klinicosTrabajos.pacienteId, pacienteId));
    expect(trabajos).toHaveLength(1);
  });
});

describe("encolarTurnosFuturosDeTurnera", () => {
  // Caso Holter: la agenda se corrige DESPUÉS de la reserva y los turnos
  // futuros deben quedar encolados retroactivamente.
  let turneraPracticasId: number;
  let turneraConsultorioId: number;
  const turnosCreados: number[] = [];

  beforeAll(async () => {
    const [tp] = await db
      .insert(turnerasTable)
      .values({ nombre: `Holter Doppler Test ${RUN_ID}`, klinicosSector: "IMAGENES S/C" })
      .returning();
    turneraPracticasId = tp!.id;
    const [tc] = await db
      .insert(turnerasTable)
      .values({ nombre: `Clínica Test ${RUN_ID}`, klinicosSector: "CONSULTORIO" })
      .returning();
    turneraConsultorioId = tc!.id;

    const base = { pacienteId, cobertura: "IOMA", horaInicio: "09:00", horaFin: "09:30", motivoConsulta: "Holter" };
    const filas = await db
      .insert(turnosTable)
      .values([
        { ...base, turneraId: turneraPracticasId, fecha: hoyArgentina(), estado: "pendiente" },
        { ...base, turneraId: turneraPracticasId, fecha: hoyArgentina(), estado: "cancelado" },
        { ...base, turneraId: turneraPracticasId, fecha: "2000-01-01", estado: "pendiente" },
        { ...base, turneraId: turneraConsultorioId, fecha: hoyArgentina(), estado: "pendiente" },
      ])
      .returning({ id: turnosTable.id });
    turnosCreados.push(...filas.map((f) => f.id));
  });

  afterAll(async () => {
    for (const id of turnosCreados) {
      await db.delete(klinicosTrabajos).where(eq(klinicosTrabajos.turnoId, id));
      await db.delete(turnosTable).where(eq(turnosTable.id, id));
    }
    await db.delete(turnerasTable).where(eq(turnerasTable.id, turneraPracticasId));
    await db.delete(turnerasTable).where(eq(turnerasTable.id, turneraConsultorioId));
  });

  it("encola solo los turnos futuros pendientes de la agenda de prácticas", async () => {
    await encolarTurnosFuturosDeTurnera(turneraPracticasId);
    const trabajos = await db
      .select()
      .from(klinicosTrabajos)
      .where(eq(klinicosTrabajos.turnoId, turnosCreados[0]!));
    expect(trabajos).toHaveLength(1);
    expect(trabajos[0]!.estado).toBe("pendiente");
    // Cancelado y pasado: sin trabajo
    for (const id of [turnosCreados[1]!, turnosCreados[2]!]) {
      const t = await db.select().from(klinicosTrabajos).where(eq(klinicosTrabajos.turnoId, id));
      expect(t).toHaveLength(0);
    }
  });

  it("es idempotente: una segunda pasada no duplica trabajos", async () => {
    await encolarTurnosFuturosDeTurnera(turneraPracticasId);
    const trabajos = await db
      .select()
      .from(klinicosTrabajos)
      .where(eq(klinicosTrabajos.turnoId, turnosCreados[0]!));
    expect(trabajos).toHaveLength(1);
  });

  it("no encola nada en una agenda de consultorio", async () => {
    await encolarTurnosFuturosDeTurnera(turneraConsultorioId);
    const trabajos = await db
      .select()
      .from(klinicosTrabajos)
      .where(eq(klinicosTrabajos.turnoId, turnosCreados[3]!));
    expect(trabajos).toHaveLength(0);
  });
});

describe("endpoints /integraciones/klinicos", () => {
  it("lista la bandeja de trabajos con nombre de paciente", async () => {
    const res = await fetch(`${baseUrl}/api/integraciones/klinicos/trabajos`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ dni: string; pacienteNombre: string | null }>;
    const mio = body.find((t) => t.dni === TEST_DNI);
    expect(mio).toBeDefined();
    expect(mio!.pacienteNombre).toContain(`Test${RUN_ID}`);
  });

  it("rechaza sin token", async () => {
    const res = await fetch(`${baseUrl}/api/integraciones/klinicos/trabajos`);
    expect(res.status).toBe(401);
  });

  it("permite editar campos revisables del trabajo", async () => {
    const [t] = await db
      .select()
      .from(klinicosTrabajos)
      .where(eq(klinicosTrabajos.pacienteId, pacienteId));
    // El worker del server de dev puede tomar trabajos pendiente/error en el
    // medio del test; esperando_aprobacion es editable y el worker lo ignora.
    await db
      .update(klinicosTrabajos)
      .set({ estado: "esperando_aprobacion" })
      .where(eq(klinicosTrabajos.id, t!.id));
    const res = await fetch(`${baseUrl}/api/integraciones/klinicos/trabajos/${t!.id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ consultaPor: "Ecografía abdominal", cie10Codigo: "R10.4" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { consultaPor: string; cie10Codigo: string };
    expect(body.consultaPor).toBe("Ecografía abdominal");
    expect(body.cie10Codigo).toBe("R10.4");
  });

  it("permite cancelar y reintentar un trabajo", async () => {
    const [t] = await db
      .select()
      .from(klinicosTrabajos)
      .where(eq(klinicosTrabajos.pacienteId, pacienteId));
    // Igual que arriba: fijar un estado editable que el worker de dev no toma.
    await db
      .update(klinicosTrabajos)
      .set({ estado: "esperando_aprobacion" })
      .where(eq(klinicosTrabajos.id, t!.id));
    const cancel = await fetch(`${baseUrl}/api/integraciones/klinicos/trabajos/${t!.id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ estado: "cancelado" }),
    });
    expect(cancel.status).toBe(200);

    const retry = await fetch(
      `${baseUrl}/api/integraciones/klinicos/trabajos/${t!.id}/reintentar`,
      { method: "POST", headers: auth },
    );
    expect(retry.status).toBe(200);
    const body = (await retry.json()) as { estado: string; intentos: number };
    expect(body.estado).toBe("pendiente");
    expect(body.intentos).toBe(0);
  });

  it("no permite reabrir con PATCH ni editar trabajos completados", async () => {
    const [t] = await db
      .select()
      .from(klinicosTrabajos)
      .where(eq(klinicosTrabajos.pacienteId, pacienteId));

    // estado: "pendiente" vía PATCH está prohibido (usar /reintentar)
    const reabrir = await fetch(`${baseUrl}/api/integraciones/klinicos/trabajos/${t!.id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ estado: "pendiente" }),
    });
    expect(reabrir.status).toBe(422);

    // Un trabajo completado es inmutable
    await db.update(klinicosTrabajos).set({ estado: "completado" }).where(eq(klinicosTrabajos.id, t!.id));
    const editar = await fetch(`${baseUrl}/api/integraciones/klinicos/trabajos/${t!.id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ consultaPor: "no debería" }),
    });
    expect(editar.status).toBe(422);
    const retry = await fetch(
      `${baseUrl}/api/integraciones/klinicos/trabajos/${t!.id}/reintentar`,
      { method: "POST", headers: auth },
    );
    expect(retry.status).toBe(422);
    await db.update(klinicosTrabajos).set({ estado: "pendiente" }).where(eq(klinicosTrabajos.id, t!.id));
  });

  it("modo asistido: aprobar un trabajo que no espera aprobación da 422 y no cambia el estado", async () => {
    // Independiente de credenciales: sin habilitar → 422 (fail-closed); con
    // credenciales, la máquina de estados rechaza igual porque el trabajo no
    // está esperando aprobación. En ningún caso se dispara ejecución real.
    const [t] = await db
      .select()
      .from(klinicosTrabajos)
      .where(eq(klinicosTrabajos.pacienteId, pacienteId));
    await db.update(klinicosTrabajos).set({ estado: "pendiente" }).where(eq(klinicosTrabajos.id, t!.id));

    const res = await fetch(`${baseUrl}/api/integraciones/klinicos/trabajos/${t!.id}/aprobar`, {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(422);
    const [after] = await db.select().from(klinicosTrabajos).where(eq(klinicosTrabajos.id, t!.id));
    expect(after!.estado).toBe("pendiente");
    expect(after!.aprobadoEn).toBeNull();
  });

  it("modo asistido: editar un trabajo esperando aprobación lo devuelve a la cola e invalida la simulación", async () => {
    const [t] = await db
      .select()
      .from(klinicosTrabajos)
      .where(eq(klinicosTrabajos.pacienteId, pacienteId));
    await db
      .update(klinicosTrabajos)
      .set({ estado: "esperando_aprobacion", simulacionPayload: { modo: "simulacion" }, simulacionEn: new Date() })
      .where(eq(klinicosTrabajos.id, t!.id));
    const res = await fetch(`${baseUrl}/api/integraciones/klinicos/trabajos/${t!.id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ consultaPor: "Ecografía renal" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { estado: string; intentos: number; simulacionPayload: unknown };
    expect(body.estado).toBe("pendiente");
    expect(body.intentos).toBe(0);
    expect(body.simulacionPayload).toBeNull();
  });

  it("modo asistido: rechazar cancela el trabajo con quién lo rechazó", async () => {
    const [t] = await db
      .select()
      .from(klinicosTrabajos)
      .where(eq(klinicosTrabajos.pacienteId, pacienteId));
    await db.update(klinicosTrabajos).set({ estado: "esperando_aprobacion" }).where(eq(klinicosTrabajos.id, t!.id));
    const res = await fetch(`${baseUrl}/api/integraciones/klinicos/trabajos/${t!.id}/rechazar`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ motivo: "código dudoso" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { estado: string; ultimoError: string };
    expect(body.estado).toBe("cancelado");
    expect(body.ultimoError).toContain("Rechazado por");
    expect(body.ultimoError).toContain("código dudoso");

    // Rechazar de nuevo (ya cancelado) → 422
    const otra = await fetch(`${baseUrl}/api/integraciones/klinicos/trabajos/${t!.id}/rechazar`, {
      method: "POST",
      headers: auth,
    });
    expect(otra.status).toBe(422);

    // Restaurar para los tests siguientes
    await db.update(klinicosTrabajos).set({ estado: "pendiente", ultimoError: null }).where(eq(klinicosTrabajos.id, t!.id));
  });

  it("el estado del robot informa modo asistido y esperando aprobación", async () => {
    const res = await fetch(`${baseUrl}/api/integraciones/klinicos/estado`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { modo: string; esperandoAprobacion: number };
    expect(body.modo).toBe("asistido");
    expect(typeof body.esperandoAprobacion).toBe("number");
  });

  it("no permite reintentar un trabajo pendiente", async () => {
    const [t] = await db
      .select()
      .from(klinicosTrabajos)
      .where(eq(klinicosTrabajos.pacienteId, pacienteId));
    const res = await fetch(
      `${baseUrl}/api/integraciones/klinicos/trabajos/${t!.id}/reintentar`,
      { method: "POST", headers: auth },
    );
    expect(res.status).toBe(422);
  });

  it("devuelve el estado del robot", async () => {
    const res = await fetch(`${baseUrl}/api/integraciones/klinicos/estado`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { habilitado: boolean; dryRun: boolean; pendientes: number };
    expect(typeof body.habilitado).toBe("boolean");
    // dryRun refleja la config del entorno (KLINICOS_DRY_RUN)
    expect(body.dryRun).toBe(process.env.KLINICOS_DRY_RUN !== "0");
    expect(body.pendientes).toBeGreaterThanOrEqual(1);
  });

  it("lista reglas de sector y catálogo de prácticas", async () => {
    const reglas = await fetch(`${baseUrl}/api/integraciones/klinicos/reglas-sector`, { headers: auth });
    expect(reglas.status).toBe(200);
    expect(((await reglas.json()) as unknown[]).length).toBeGreaterThan(0);

    const practicas = await fetch(`${baseUrl}/api/integraciones/klinicos/practicas`, { headers: auth });
    expect(practicas.status).toBe(200);
    expect(((await practicas.json()) as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("reglas de sector", () => {
  const ESPECIALIDAD_TEST = `TEST-ESP-${RUN_ID}`;

  afterAll(async () => {
    await db.delete(klinicosReglasSector).where(eq(klinicosReglasSector.especialidad, ESPECIALIDAD_TEST));
  });

  it("upsert crea y actualiza una regla", async () => {
    const crear = await fetch(`${baseUrl}/api/integraciones/klinicos/reglas-sector`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ especialidad: ESPECIALIDAD_TEST, sectorServicio: "CONSULTORIO" }),
    });
    expect(crear.status).toBe(200);

    const actualizar = await fetch(`${baseUrl}/api/integraciones/klinicos/reglas-sector`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ especialidad: ESPECIALIDAD_TEST, sectorServicio: "IMAGENES S/C" }),
    });
    expect(actualizar.status).toBe(200);
    const body = (await actualizar.json()) as { sectorServicio: string };
    expect(body.sectorServicio).toBe("IMAGENES S/C");

    expect(await resolverSectorServicio(ESPECIALIDAD_TEST)).toBe("IMAGENES S/C");
  });
});

describe("prescriptores", () => {
  const NOMBRE_A = `DR TEST A ${RUN_ID}`;
  const NOMBRE_B = `DRA TEST B ${RUN_ID}`;
  const NOMBRE_GINE = `DRA GINE ${RUN_ID}`;

  afterAll(async () => {
    for (const n of [NOMBRE_A, NOMBRE_B, NOMBRE_GINE]) {
      await db.delete(klinicosPrescriptores).where(eq(klinicosPrescriptores.nombre, n));
    }
  });

  it("crea, lista y edita prescriptores; rechaza duplicados", async () => {
    const crear = await fetch(`${baseUrl}/api/integraciones/klinicos/prescriptores`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ nombre: NOMBRE_A }),
    });
    expect(crear.status).toBe(201);
    const creado = (await crear.json()) as { id: number; esGinecologo: boolean; activo: boolean };
    expect(creado.esGinecologo).toBe(false);
    expect(creado.activo).toBe(true);

    const dup = await fetch(`${baseUrl}/api/integraciones/klinicos/prescriptores`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ nombre: NOMBRE_A }),
    });
    expect(dup.status).toBe(409);

    const editar = await fetch(`${baseUrl}/api/integraciones/klinicos/prescriptores/${creado.id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        nombre: NOMBRE_A,
        matricula: "MP 12345",
        especialidad: "Clínica Médica",
        esGinecologo: false,
        activo: true,
      }),
    });
    expect(editar.status).toBe(200);
    const editado = (await editar.json()) as { matricula: string | null; especialidad: string | null };
    expect(editado.matricula).toBe("MP 12345");
    expect(editado.especialidad).toBe("Clínica Médica");

    const crearB = await fetch(`${baseUrl}/api/integraciones/klinicos/prescriptores`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ nombre: NOMBRE_B }),
    });
    expect(crearB.status).toBe(201);
    const creadoB = (await crearB.json()) as { id: number };

    const patchDup = await fetch(`${baseUrl}/api/integraciones/klinicos/prescriptores/${creadoB.id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ nombre: NOMBRE_A, esGinecologo: false, activo: true }),
    });
    expect(patchDup.status).toBe(409);

    // Limpiar B: el test de rotación lo vuelve a crear
    await db.delete(klinicosPrescriptores).where(eq(klinicosPrescriptores.id, creadoB.id));

    const lista = await fetch(`${baseUrl}/api/integraciones/klinicos/prescriptores`, { headers: auth });
    expect(lista.status).toBe(200);
    const body = (await lista.json()) as Array<{ nombre: string }>;
    expect(body.some((p) => p.nombre === NOMBRE_A)).toBe(true);
  });

  it("rota round-robin y excluye ginecólogos para varones", async () => {
    // Aislar la rotación: desactivar temporalmente los demás activos
    const otros = await db
      .select({ id: klinicosPrescriptores.id })
      .from(klinicosPrescriptores)
      .where(eq(klinicosPrescriptores.activo, true));
    const otrosIds = otros.map((o) => o.id);
    try {
      for (const id of otrosIds) {
        await db.update(klinicosPrescriptores).set({ activo: false }).where(eq(klinicosPrescriptores.id, id));
      }
      await db.insert(klinicosPrescriptores).values([
        { nombre: NOMBRE_B, esGinecologo: false, activo: true },
        { nombre: NOMBRE_GINE, esGinecologo: true, activo: true },
      ]);

      // Paciente varón: nunca ginecóloga, alterna con el único apto
      expect(await elegirPrescriptor("M")).toBe(NOMBRE_B);
      expect(await elegirPrescriptor("MASCULINO")).toBe(NOMBRE_B);

      // Paciente mujer: la ginecóloga (nunca usada) va primero, después rota
      expect(await elegirPrescriptor("F")).toBe(NOMBRE_GINE);
      expect(await elegirPrescriptor("F")).toBe(NOMBRE_B);
      expect(await elegirPrescriptor("F")).toBe(NOMBRE_GINE);

      // Sexo desconocido: no excluye a nadie
      expect(await elegirPrescriptor(null)).toBe(NOMBRE_B);
    } finally {
      for (const id of otrosIds) {
        await db.update(klinicosPrescriptores).set({ activo: true }).where(eq(klinicosPrescriptores.id, id));
      }
    }
  });

  it("devuelve null si no hay prescriptores aptos", async () => {
    await db.update(klinicosPrescriptores).set({ activo: false }).where(eq(klinicosPrescriptores.nombre, NOMBRE_B));
    await db.update(klinicosPrescriptores).set({ activo: false }).where(eq(klinicosPrescriptores.nombre, NOMBRE_GINE));
    const otros = await db
      .select({ id: klinicosPrescriptores.id })
      .from(klinicosPrescriptores)
      .where(eq(klinicosPrescriptores.activo, true));
    if (otros.length === 0) {
      expect(await elegirPrescriptor("F")).toBeNull();
    }
  });
});
