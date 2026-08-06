import { readFileSync } from "node:fs";
import { pool } from "@workspace/db";

const FILE = process.argv[2] ?? "attached_assets/Datos_basicos_(1)_1784525023610.xls";

type Fila = {
  nombre: string;
  apellido: string;
  sexo: string | null;
  fechaNacimiento: string | null;
  dni: string;
  direccion: string | null;
  telefono: string | null;
  email: string | null;
  cobertura: string | null;
  planCobertura: string | null;
};

function limpiar(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parsear(html: string): Fila[] {
  const filas: Fila[] = [];
  const trRe = /<tr align="center">([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html)) !== null) {
    const celdas: string[] = [];
    const tdRe = /<td>([\s\S]*?)<\/td>/g;
    let td: RegExpExecArray | null;
    while ((td = tdRe.exec(m[1])) !== null) celdas.push(limpiar(td[1]));
    if (celdas.length < 15) continue;
    const [nombres, apellidos, genero, fnac, doc, dir, tel, cel, , , email, emailGmail, , os, plan] = celdas;
    const dni = doc.replace(/\D/g, "");
    if (!dni || !nombres) continue;
    const sexo = genero.toLowerCase() === "m" ? "M" : genero.toLowerCase() === "f" ? "F" : null;
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(fnac) && fnac !== "2024-01-01" ? fnac : null;
    filas.push({
      nombre: titulo(nombres),
      apellido: titulo(apellidos),
      sexo,
      fechaNacimiento: fecha,
      dni,
      direccion: dir && dir !== "1 1" ? dir : null,
      telefono: cel || tel || null,
      email: (email || emailGmail || "").toLowerCase() || null,
      cobertura: os ? os.trim() : null,
      planCobertura: plan ? plan.trim() : null,
    });
  }
  // dedupe por DNI (queda la primera aparición)
  const porDni = new Map<string, Fila>();
  for (const f of filas) if (!porDni.has(f.dni)) porDni.set(f.dni, f);
  return [...porDni.values()];
}

function titulo(s: string): string {
  return s
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

async function main() {
  const html = readFileSync(FILE, "latin1");
  const filas = parsear(html);
  console.log(`Filas parseadas (únicas por DNI): ${filas.length}`);

  let insertados = 0;
  const LOTE = 1000;
  for (let i = 0; i < filas.length; i += LOTE) {
    const lote = filas.slice(i, i + LOTE);
    const valores: unknown[] = [];
    const tuplas = lote.map((f, j) => {
      const b = j * 10;
      valores.push(
        f.nombre, f.apellido, f.dni, f.sexo, f.fechaNacimiento,
        f.direccion, f.telefono, f.email, f.cobertura, f.planCobertura,
      );
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10})`;
    });
    const res = await pool.query(
      `INSERT INTO pacientes (nombre, apellido, dni, sexo, fecha_nacimiento, direccion, telefono, email, cobertura, plan_cobertura)
       VALUES ${tuplas.join(",")}
       ON CONFLICT (dni) WHERE dni IS NOT NULL DO NOTHING`,
      valores,
    );
    insertados += res.rowCount ?? 0;
    if ((i / LOTE) % 10 === 0) console.log(`Progreso: ${i + lote.length}/${filas.length} (insertados ${insertados})`);
  }
  console.log(`Listo. Insertados nuevos: ${insertados} de ${filas.length}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
