/**
 * Stage staging — Mapea columnas raw al esquema Alephoo y valida tipos.
 * No normaliza valores; solo clasifica y marca errores de tipo básico.
 */

import type { FilaRaw, FilaAlephooStaging } from "../types.js";

// ── Mapeo de nombres de columna Alephoo → campos internos ─────────────────────
// Las columnas de Alephoo pueden variar entre exportaciones; este mapa
// cubre los nombres conocidos. Si una columna no está en el mapa,
// va a camposExtra para no perder información.

const MAPA_COLUMNAS: Record<string, keyof FilaAlephooStaging> = {
  // Nombres de columna conocidos en exportaciones Alephoo (case-insensitive)
  "apellido": "apellido",
  "apellidos": "apellido",
  "nombre": "nombre",
  "nombres": "nombre",
  "tipo_doc": "tipoDoc",
  "tipo documento": "tipoDoc",
  "tipo_documento": "tipoDoc",
  "nro_doc": "nroDoc",
  "nro documento": "nroDoc",
  "numero_documento": "nroDoc",
  "dni": "nroDoc",
  "fecha_nac": "fechaNacimiento",
  "fecha_nacimiento": "fechaNacimiento",
  "fecha nacimiento": "fechaNacimiento",
  "nacimiento": "fechaNacimiento",
  "sexo": "sexo",
  "genero": "sexo",
  "email": "email",
  "correo": "email",
  "telefono": "telefono",
  "teléfono": "telefono",
  "cel": "telefono",
  "celular": "telefono",
  "obra_social": "obraSocial",
  "obra social": "obraSocial",
  "financiador": "obraSocial",
  "nro_afiliado": "nroAfiliado",
  "nro afiliado": "nroAfiliado",
  "afiliado": "nroAfiliado",
  "fecha_turno": "fechaTurno",
  "fecha turno": "fechaTurno",
  "fecha": "fechaTurno",
  "hora": "horaTurno",
  "hora_turno": "horaTurno",
  "profesional": "profesional",
  "medico": "profesional",
  "médico": "profesional",
  "especialidad": "especialidad",
  "sede": "sede",
  "sucursal": "sede",
  "motivo": "motivoConsulta",
  "motivo_consulta": "motivoConsulta",
  "motivo consulta": "motivoConsulta",
  "cie10": "diagnosticoCie10",
  "codigo_cie10": "diagnosticoCie10",
  "diagnostico_cie10": "diagnosticoCie10",
  "diagnostico": "diagnosticoDescripcion",
  "diagnostico_descripcion": "diagnosticoDescripcion",
};

function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quitar tildes
    .trim();
}

function toStringOrUndefined(val: unknown): string | undefined {
  if (val === null || val === undefined || val === "") return undefined;
  return String(val).trim() || undefined;
}

export function mapearFilaStaging(fila: FilaRaw): FilaAlephooStaging {
  const resultado: FilaAlephooStaging = {
    uploadId: fila.uploadId,
    filaNumero: fila.filaNumero,
    archivoS3Key: fila.archivoS3Key,
    estado: "staging",
    erroresValidacion: [],
    advertenciasValidacion: [],
  };

  const camposExtra: Record<string, unknown> = {};

  for (const [columna, valor] of Object.entries(fila.datos)) {
    const clave = normalizeHeader(columna);
    const campo = MAPA_COLUMNAS[clave];

    if (campo && campo !== "uploadId" && campo !== "filaNumero" && campo !== "archivoS3Key" && campo !== "estado" && campo !== "erroresValidacion" && campo !== "advertenciasValidacion" && campo !== "camposExtra") {
      (resultado as unknown as Record<string, unknown>)[campo] = toStringOrUndefined(valor);
    } else {
      if (valor !== null && valor !== undefined && valor !== "") {
        camposExtra[columna] = valor;
      }
    }
  }

  if (Object.keys(camposExtra).length > 0) {
    resultado.camposExtra = camposExtra;
  }

  // Validaciones de staging (tipo básico, no normalización)
  if (!resultado.apellido && !resultado.nombre) {
    resultado.erroresValidacion.push("Fila sin apellido ni nombre");
  }
  if (!resultado.nroDoc) {
    resultado.advertenciasValidacion.push("Sin número de documento — puede generar duplicados");
  }
  if (Object.keys(camposExtra).length > 5) {
    resultado.advertenciasValidacion.push(
      `${Object.keys(camposExtra).length} columnas sin mapeo conocido — revisar configuración`,
    );
  }

  return resultado;
}

export function procesarStaging(filasRaw: FilaRaw[]): FilaAlephooStaging[] {
  return filasRaw.map(mapearFilaStaging);
}
