/**
 * Fixtures de Excel ficticios para tests del pipeline Alephoo
 * Todos los datos son inventados: DNIs fuera de rango real (99XXXXXX),
 * nombres claramente ficticios, emails en dominio .invalid
 */

import type { FilaRaw } from "../../src/importacion/alephoo/types.js";

export const UPLOAD_ID_TEST = "test-upload-2026-01-01";
export const S3_KEY_TEST = "importacion/alephoo/test/muestra-ficticia.xlsx";

/** Filas raw simulando la salida de leerExcelRaw() sobre un Excel Alephoo */
export const filasRawMuestra: FilaRaw[] = [
  {
    filaNumero: 2,
    uploadId: UPLOAD_ID_TEST,
    archivoS3Key: S3_KEY_TEST,
    datos: {
      "APELLIDO": "FICTICIO ALEPHOO",
      "NOMBRE": "PACIENTE UNO",
      "DNI": "99.000.001",            // DNI ficticio con puntos
      "FECHA_NAC": "15/03/1980",
      "SEXO": "M",
      "EMAIL": "paciente.uno@test.invalid",
      "TELEFONO": "011-4444-0001",
      "OBRA_SOCIAL": "OSDE",
      "NRO_AFILIADO": "OS-000001",
      "FECHA_TURNO": "2026-01-15",
      "HORA": "09:30",
      "PROFESIONAL": "Dr. Ficticio García",
      "ESPECIALIDAD": "Clínica Médica",
      "SEDE": "Sede Test",
      "MOTIVO": "Control de rutina",
    },
  },
  {
    filaNumero: 3,
    uploadId: UPLOAD_ID_TEST,
    archivoS3Key: S3_KEY_TEST,
    datos: {
      "APELLIDO": "TESTEO FICTICIO",
      "NOMBRE": "SEGUNDA PACIENTE",
      "DNI": "99000002",              // DNI ficticio sin puntos
      "FECHA_NAC": "22-08-1992",
      "SEXO": "F",
      "EMAIL": "segunda@test.invalid",
      "TELEFONO": "1144440002",
      "OBRA_SOCIAL": "Swiss Medical",
      "NRO_AFILIADO": "SM-000002",
      "FECHA_TURNO": "2026-01-15",
      "HORA": "10:00",
      "PROFESIONAL": "Dra. Ficticia López",
      "ESPECIALIDAD": "Cardiología",
      "SEDE": "Sede Test",
      "MOTIVO": "Consulta cardiológica",
    },
  },
  {
    filaNumero: 4,
    uploadId: UPLOAD_ID_TEST,
    archivoS3Key: S3_KEY_TEST,
    datos: {
      "APELLIDO": "",
      "NOMBRE": "",
      "DNI": "99000003",
      "FECHA_NAC": "fecha-invalida-xyz",  // fecha inválida — debe ir a cuarentena/advertencia
      "SEXO": "X",
      "EMAIL": "no-es-un-email",          // email inválido
      "TELEFONO": "",
      "OBRA_SOCIAL": "",
    },
  },
  {
    filaNumero: 5,
    uploadId: UPLOAD_ID_TEST,
    archivoS3Key: S3_KEY_TEST,
    datos: {
      // Duplicado exacto del primero (mismo DNI)
      "APELLIDO": "FICTICIO ALEPHOO",
      "NOMBRE": "PACIENTE UNO DUPLICADO",
      "DNI": "99.000.001",
      "FECHA_NAC": "15/03/1980",
      "SEXO": "M",
    },
  },
];

/** Filas raw para test de duplicado casi-exacto (nombre+fecha similares, sin DNI) */
export const filasDuplicadoProbable: FilaRaw[] = [
  {
    filaNumero: 2,
    uploadId: "test-dedup-probable",
    archivoS3Key: S3_KEY_TEST,
    datos: {
      "APELLIDO": "MARTINEZ FICTICIO",
      "NOMBRE": "JUAN TESTEO",
      "FECHA_NAC": "10/05/1975",
    },
  },
  {
    filaNumero: 3,
    uploadId: "test-dedup-probable",
    archivoS3Key: S3_KEY_TEST,
    datos: {
      "APELLIDO": "MARTINEZ FICTICIO",
      "NOMBRE": "JUAN TESTEO",     // mismo nombre sin DNI — duplicado probable
      "FECHA_NAC": "10/05/1975",
    },
  },
];
