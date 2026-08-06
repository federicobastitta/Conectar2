/**
 * Carga pacientes desde un reporte de turnos de Alephoo (HTML UTF-16 disfrazado de .xls).
 *
 * Uso:
 *   pnpm --filter @workspace/scripts run cargar-pacientes-turnos <ruta.xls>
 *
 * - Inserta pacientes nuevos (dedup por DNI, ON CONFLICT DO NOTHING)
 * - Completa campos vacíos (NULL) de pacientes existentes vía COALESCE
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pool } from "@workspace/db";

type Fila = {
  nombre: string;
  apellido: string;
  dni: string;
  sexo: string | null;
  fechaNacimiento: string | null;
  direccion: string | null;
  localidad: string | null;
  codigoPostal: string | null;
  cobertura: string | null;
  planCobertura: string | null;
  nroAfiliado: string | null;
};

function decodificar(buf: Buffer): string {
  // El reporte viene en UTF-16 sin BOM y con alineación variable:
  // decodificamos como latin1 y quitamos los bytes nulos intercalados.
  return buf.toString("latin1").replace(/\x00/g, "");
}

function limpiar(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&oacute;/g, "ó")
    .replace(/&aacute;/g, "á")
    .replace(/&eacute;/g, "é")
    .replace(/&iacute;/g, "í")
    .replace(/&uacute;/g, "ú")
    .replace(/&ntilde;/g, "ñ")
    .replace(/&Ntilde;/g, "Ñ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titulo(s: string): string {
  return s
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** "12-10-2025" (DD-MM-YYYY) → "2025-10-12" */
function parsearFecha(s: string): string | null {
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

export function parsear(html: string): Fila[] {
  const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)].map((m) =>
    [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => limpiar(c[1])),
  );
  if (rows.length < 2) return [];
  const H = rows[0];
  const idx = (nombre: string) => H.findIndex((h) => h.toLowerCase() === nombre.toLowerCase());
  const iPac = idx("Paciente");
  const iDni = idx("DNI"); // primera columna DNI = la del paciente
  const iSexo = idx("Sexo");
  const iFnac = idx("F.Nac");
  const iCiudad = idx("Ciudad");
  const iCp = idx("Codigo Postal");
  const iDir = idx("Dirección");
  const iOs = idx("Obra Social");
  const iPlan = idx("Plan");
  const iAfil = idx("Nro. de afiliado");
  if (iPac < 0 || iDni < 0) throw new Error(`Columnas Paciente/DNI no encontradas: ${JSON.stringify(H)}`);

  const filas: Fila[] = [];
  for (const r of rows.slice(1)) {
    if (r.length !== H.length) continue;
    const dni = (r[iDni] ?? "").replace(/\D/g, "");
    const nombreCompleto = (r[iPac] ?? "").trim();
    if (!dni || !nombreCompleto) continue;

    // Formato "Nombre(s) Apellido(s)": última palabra = apellido
    const partes = nombreCompleto.split(/\s+/);
    const apellido = titulo(partes[partes.length - 1]);
    const nombre = titulo(partes.slice(0, -1).join(" ")) || apellido;

    const sexoRaw = (r[iSexo] ?? "").toLowerCase();
    const dir = (r[iDir] ?? "").trim();

    filas.push({
      nombre,
      apellido,
      dni,
      sexo: sexoRaw === "m" ? "M" : sexoRaw === "f" ? "F" : null,
      fechaNacimiento: parsearFecha((r[iFnac] ?? "").trim()),
      direccion: dir && dir !== "1 1" ? dir : null,
      localidad: (r[iCiudad] ?? "").trim() || null,
      codigoPostal: (r[iCp] ?? "").trim() || null,
      cobertura: (r[iOs] ?? "").trim() || null,
      planCobertura: (r[iPlan] ?? "").trim() || null,
      nroAfiliado: (r[iAfil] ?? "").trim() || null,
    });
  }

  // dedupe por DNI fusionando: se completan campos null con los de filas posteriores
  const porDni = new Map<string, Fila>();
  for (const f of filas) {
    const prev = porDni.get(f.dni);
    if (!prev) {
      porDni.set(f.dni, f);
    } else {
      for (const k of Object.keys(f) as (keyof Fila)[]) {
        if (prev[k] == null && f[k] != null) (prev as Record<string, unknown>)[k] = f[k];
      }
    }
  }
  return [...porDni.values()];
}

async function main() {
  const archivoArg = process.argv.slice(2).find((a) => a !== "--");
  if (!archivoArg) {
    console.error("Uso: pnpm --filter @workspace/scripts run cargar-pacientes-turnos <ruta.xls>");
    process.exit(1);
  }
  const archivo = path.resolve(archivoArg);
  console.log(`Leyendo: ${archivo}`);
  const filas = parsear(decodificar(readFileSync(archivo)));
  console.log(`Pacientes únicos por DNI en el archivo: ${filas.length}`);

  let insertados = 0;
  let completados = 0;
  const LOTE = 500;
  for (let i = 0; i < filas.length; i += LOTE) {
    const lote = filas.slice(i, i + LOTE);
    const valores: unknown[] = [];
    const tuplas = lote.map((f, j) => {
      const b = j * 11;
      valores.push(
        f.nombre, f.apellido, f.dni, f.sexo, f.fechaNacimiento, f.direccion,
        f.localidad, f.codigoPostal, f.cobertura, f.planCobertura, f.nroAfiliado,
      );
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11})`;
    });

    const ins = await pool.query(
      `INSERT INTO pacientes (nombre, apellido, dni, sexo, fecha_nacimiento, direccion, localidad, codigo_postal, cobertura, plan_cobertura, nro_afiliado)
       VALUES ${tuplas.join(",")}
       ON CONFLICT (dni) WHERE dni IS NOT NULL DO NOTHING`,
      valores,
    );
    insertados += ins.rowCount ?? 0;

    // Completar campos NULL de existentes (no pisa datos ya cargados)
    const upd = await pool.query(
      `UPDATE pacientes p SET
         sexo             = COALESCE(p.sexo, v.sexo),
         fecha_nacimiento = COALESCE(p.fecha_nacimiento, v.fecha_nacimiento),
         direccion        = COALESCE(p.direccion, v.direccion),
         localidad        = COALESCE(p.localidad, v.localidad),
         codigo_postal    = COALESCE(p.codigo_postal, v.codigo_postal),
         cobertura        = COALESCE(p.cobertura, v.cobertura),
         plan_cobertura   = COALESCE(p.plan_cobertura, v.plan_cobertura),
         nro_afiliado     = COALESCE(p.nro_afiliado, v.nro_afiliado)
       FROM (VALUES ${tuplas.join(",")}) AS v(nombre, apellido, dni, sexo, fecha_nacimiento, direccion, localidad, codigo_postal, cobertura, plan_cobertura, nro_afiliado)
       WHERE p.dni = v.dni
         AND ( (p.sexo IS NULL AND v.sexo IS NOT NULL)
            OR (p.fecha_nacimiento IS NULL AND v.fecha_nacimiento IS NOT NULL)
            OR (p.direccion IS NULL AND v.direccion IS NOT NULL)
            OR (p.localidad IS NULL AND v.localidad IS NOT NULL)
            OR (p.codigo_postal IS NULL AND v.codigo_postal IS NOT NULL)
            OR (p.cobertura IS NULL AND v.cobertura IS NOT NULL)
            OR (p.plan_cobertura IS NULL AND v.plan_cobertura IS NOT NULL)
            OR (p.nro_afiliado IS NULL AND v.nro_afiliado IS NOT NULL) )`,
      valores,
    );
    completados += upd.rowCount ?? 0;
    console.log(`Progreso: ${Math.min(i + LOTE, filas.length)}/${filas.length} (nuevos ${insertados}, completados ${completados})`);
  }

  console.log(`Listo. Nuevos: ${insertados} · Existentes con datos completados: ${completados}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
