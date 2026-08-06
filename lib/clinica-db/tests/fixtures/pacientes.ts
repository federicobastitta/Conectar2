/**
 * Fixtures ficticios para tests — conectar-clinica-dev
 * DATOS TOTALMENTE INVENTADOS. Ningún dato real, ningún DNI real.
 * Nombres, fechas y números son generados aleatoriamente para los tests.
 */

import type { NuevoPaciente } from "../../src/schema/pacientes.js";

export const USUARIO_TEST_ID = "00000000-0000-0000-0000-000000000001";
export const USUARIO_TEST_2_ID = "00000000-0000-0000-0000-000000000002";

/** Paciente base sin DNI — para testear el flujo sin documento */
export const pacienteSinDni: Omit<NuevoPaciente, "id" | "createdAt" | "updatedAt"> = {
  apellido: "FICTICIO",
  nombre: "PACIENTE TEST",
  sexo: "desconocido",
  activo: true,
  fallecido: false,
  origen: "migracion_inicial",
  tipoDoc: "dni",
  paisResidencia: "AR",
};

/** Paciente con DNI único por run — evita colisiones entre tests */
export function pacienteConDni(suffix: string): Omit<NuevoPaciente, "id" | "createdAt" | "updatedAt"> {
  return {
    apellido: "GOMEZ TEST",
    nombre: "MARIA FICTICIA",
    nroDoc: `99${suffix.padStart(6, "0")}`,  // DNI ficticio 99XXXXXX (rango inexistente)
    tipoDoc: "dni",
    fechaNacimiento: "1985-06-15",
    sexo: "femenino",
    emailPrincipal: `test.${suffix}@test.invalid`,
    activo: true,
    fallecido: false,
    origen: "importacion_alephoo",
    paisResidencia: "AR",
  };
}

export const pacienteMinimo: Omit<NuevoPaciente, "id" | "createdAt" | "updatedAt"> = {
  apellido: "LOPEZ FICTICIO",
  nombre: "CARLOS TESTEO",
  tipoDoc: "dni",
  sexo: "masculino",
  activo: true,
  fallecido: false,
  origen: "interfaz_clinica",
  paisResidencia: "AR",
};
