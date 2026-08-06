import {
  db,
  usersTable,
  sedesTable,
  especialidadesTable,
  profesionalesTable,
  turnerasTable,
  pacientesTable,
  turnosTable,
} from "@workspace/db";
import crypto from "crypto";

function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password + "mi-diagnosticar-salt").digest("hex");
}

async function seed() {
  console.log("Seeding database...");

  // Users
  const existingUsers = await db.select().from(usersTable);
  if (existingUsers.length === 0) {
    await db.insert(usersTable).values([
      { email: "admin@diagnosticar.ar", passwordHash: hashPassword("admin123"), nombre: "Administrador", rol: "admin" },
      { email: "recepcion@diagnosticar.ar", passwordHash: hashPassword("recepcion123"), nombre: "María López", rol: "recepcionista" },
      { email: "medico@diagnosticar.ar", passwordHash: hashPassword("medico123"), nombre: "Dr. Carlos Rodríguez", rol: "medico", profesionalId: "1" },
      { email: "paciente@diagnosticar.ar", passwordHash: hashPassword("paciente123"), nombre: "Juan Pérez", rol: "paciente", pacienteId: "1" },
    ]);
    console.log("Users seeded");
  }

  // Sedes
  const existingSedes = await db.select().from(sedesTable);
  if (existingSedes.length === 0) {
    await db.insert(sedesTable).values([
      { nombre: "Sede Central", direccion: "Av. Corrientes 1234, CABA", telefono: "011-4321-5678", email: "central@diagnosticar.ar", activa: true },
      { nombre: "Sede Norte", direccion: "Av. Cabildo 890, CABA", telefono: "011-4765-4321", email: "norte@diagnosticar.ar", activa: true },
    ]);
    console.log("Sedes seeded");
  }

  // Especialidades
  const existingEsp = await db.select().from(especialidadesTable);
  if (existingEsp.length === 0) {
    await db.insert(especialidadesTable).values([
      { nombre: "Cardiología", descripcion: "Enfermedades del corazón y sistema cardiovascular", color: "#3B82F6" },
      { nombre: "Clínica Médica", descripcion: "Medicina interna general", color: "#10B981" },
      { nombre: "Pediatría", descripcion: "Medicina infantil y adolescente", color: "#F59E0B" },
      { nombre: "Traumatología", descripcion: "Lesiones del sistema músculo-esquelético", color: "#EF4444" },
      { nombre: "Ginecología", descripcion: "Salud de la mujer", color: "#8B5CF6" },
      { nombre: "Neurología", descripcion: "Sistema nervioso central y periférico", color: "#06B6D4" },
    ]);
    console.log("Especialidades seeded");
  }

  const sedes = await db.select().from(sedesTable);
  const especialidades = await db.select().from(especialidadesTable);

  // Profesionales
  const existingProfs = await db.select().from(profesionalesTable);
  if (existingProfs.length === 0) {
    const cardId = especialidades.find(e => e.nombre === "Cardiología")?.id;
    const clinId = especialidades.find(e => e.nombre === "Clínica Médica")?.id;
    const pedId = especialidades.find(e => e.nombre === "Pediatría")?.id;
    const traumId = especialidades.find(e => e.nombre === "Traumatología")?.id;
    const ginId = especialidades.find(e => e.nombre === "Ginecología")?.id;
    await db.insert(profesionalesTable).values([
      { nombre: "Carlos", apellido: "Rodríguez", matricula: "MN 12345", email: "c.rodriguez@diagnosticar.ar", especialidadId: cardId, activo: true },
      { nombre: "Ana", apellido: "García", matricula: "MN 23456", email: "a.garcia@diagnosticar.ar", especialidadId: clinId, activo: true },
      { nombre: "Luis", apellido: "Fernández", matricula: "MN 34567", email: "l.fernandez@diagnosticar.ar", especialidadId: pedId, activo: true },
      { nombre: "Marta", apellido: "Sánchez", matricula: "MN 45678", email: "m.sanchez@diagnosticar.ar", especialidadId: traumId, activo: true },
      { nombre: "Roberto", apellido: "Díaz", matricula: "MN 56789", email: "r.diaz@diagnosticar.ar", especialidadId: ginId, activo: true },
    ]);
    console.log("Profesionales seeded");
  }

  const profesionales = await db.select().from(profesionalesTable);

  // Turneras
  const existingTurneras = await db.select().from(turnerasTable);
  if (existingTurneras.length === 0) {
    const sedeId = sedes[0]?.id;
    const sedeNorteId = sedes[1]?.id;
    for (const prof of profesionales) {
      await db.insert(turnerasTable).values({
        nombre: `Agenda Dr/a. ${prof.apellido}`,
        profesionalId: prof.id,
        especialidadId: prof.especialidadId ?? undefined,
        sedeId: sedeId,
        duracionMinutos: 20,
        diasAtencion: "1,2,3,4,5",
        horaInicio: "08:00",
        horaFin: "13:00",
        cuposDiarios: 15,
        modalidad: "presencial",
        activa: true,
        visibilidad: "online",
      });
    }
    // Extra agenda for first profesional at sede norte
    if (profesionales[0] && sedeNorteId) {
      await db.insert(turnerasTable).values({
        nombre: `Agenda Tarde Dr. ${profesionales[0].apellido}`,
        profesionalId: profesionales[0].id,
        especialidadId: profesionales[0].especialidadId ?? undefined,
        sedeId: sedeNorteId,
        duracionMinutos: 30,
        diasAtencion: "2,4",
        horaInicio: "14:00",
        horaFin: "18:00",
        modalidad: "videoconsulta",
        activa: true,
        visibilidad: "online",
      });
    }
    console.log("Turneras seeded");
  }

  // Pacientes
  const existingPacientes = await db.select().from(pacientesTable);
  if (existingPacientes.length === 0) {
    await db.insert(pacientesTable).values([
      { nombre: "Juan", apellido: "Pérez", dni: "28456789", fechaNacimiento: "1985-03-15", sexo: "M", email: "juan.perez@email.com", telefono: "11-5555-1234", cobertura: "OSDE 210", nroAfiliado: "1-234-567890" },
      { nombre: "María", apellido: "González", dni: "32567890", fechaNacimiento: "1990-07-22", sexo: "F", email: "m.gonzalez@email.com", telefono: "11-5555-2345", cobertura: "Swiss Medical", nroAfiliado: "SM-789012" },
      { nombre: "Pedro", apellido: "Martínez", dni: "25678901", fechaNacimiento: "1978-11-08", sexo: "M", email: "pedro.m@email.com", telefono: "11-5555-3456", cobertura: "Galeno", nroAfiliado: "G-456789" },
      { nombre: "Lucía", apellido: "López", dni: "35789012", fechaNacimiento: "1995-05-30", sexo: "F", email: "lucia.l@email.com", telefono: "11-5555-4567", cobertura: "IOMA", nroAfiliado: "IOMA-123456" },
      { nombre: "Diego", apellido: "Hernández", dni: "20890123", fechaNacimiento: "1970-09-14", sexo: "M", telefono: "11-5555-5678", cobertura: "Particular" },
      { nombre: "Valentina", apellido: "Torres", dni: "40901234", fechaNacimiento: "2000-12-03", sexo: "F", email: "vali.torres@email.com", telefono: "11-5555-6789", cobertura: "OSDE 310", nroAfiliado: "1-567-890123" },
      { nombre: "Nicolás", apellido: "Ramírez", dni: "37012345", fechaNacimiento: "1997-04-18", sexo: "M", email: "nico.r@email.com", telefono: "11-5555-7890", cobertura: "Swiss Medical" },
      { nombre: "Carolina", apellido: "Flores", dni: "29123456", fechaNacimiento: "1983-08-25", sexo: "F", email: "caro.flores@email.com", telefono: "11-5555-8901", cobertura: "OSDE 210" },
    ]);
    console.log("Pacientes seeded");
  }

  // Turnos (today and nearby dates)
  const existingTurnos = await db.select().from(turnosTable);
  if (existingTurnos.length === 0) {
    const turneras = await db.select().from(turnerasTable);
    const pacientes = await db.select().from(pacientesTable);
    const today = new Date().toISOString().split("T")[0];

    if (turneras.length > 0 && pacientes.length > 0) {
      const slots = ["08:00", "08:20", "08:40", "09:00", "09:20", "09:40", "10:00", "10:20"];
      const estados = ["pendiente", "confirmado", "atendido", "en_sala", "pendiente", "confirmado", "pendiente", "ausente"];
      for (let i = 0; i < Math.min(8, pacientes.length); i++) {
        const turnera = turneras[i % turneras.length];
        const [h, m] = slots[i].split(":").map(Number);
        const endM = h * 60 + m + (turnera.duracionMinutos ?? 20);
        const horaFin = `${Math.floor(endM / 60).toString().padStart(2, "0")}:${(endM % 60).toString().padStart(2, "0")}`;
        await db.insert(turnosTable).values({
          turneraId: turnera.id,
          pacienteId: pacientes[i].id,
          profesionalId: turnera.profesionalId ?? undefined,
          fecha: today,
          horaInicio: slots[i],
          horaFin,
          estado: estados[i],
          modalidad: "presencial",
          motivoConsulta: "Control de rutina",
          creadoPor: "seed",
        });
      }
      // A few turnos for tomorrow
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split("T")[0];
      for (let i = 0; i < 4; i++) {
        const turnera = turneras[i % turneras.length];
        const [h, m] = slots[i].split(":").map(Number);
        const endM = h * 60 + m + (turnera.duracionMinutos ?? 20);
        const horaFin = `${Math.floor(endM / 60).toString().padStart(2, "0")}:${(endM % 60).toString().padStart(2, "0")}`;
        await db.insert(turnosTable).values({
          turneraId: turnera.id,
          pacienteId: pacientes[(i + 2) % pacientes.length].id,
          profesionalId: turnera.profesionalId ?? undefined,
          fecha: tomorrowStr,
          horaInicio: slots[i],
          horaFin,
          estado: "pendiente",
          modalidad: "presencial",
          creadoPor: "seed",
        });
      }
      console.log("Turnos seeded");
    }
  }

  console.log("Seeding complete!");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
