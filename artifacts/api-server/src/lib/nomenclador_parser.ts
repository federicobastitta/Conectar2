import * as XLSX from "xlsx";

export interface PracticaParseada {
  codigo: string;
  descripcion: string;
  capitulo: string | null;
  honorarios: number | null;
  gastos: number | null;
  valorTotal: number;
  origen: string;
}

type Fila = (string | number | null | undefined)[];

function normalizar(s: unknown): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function esNumero(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function limpiarTexto(v: unknown): string {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

// Busca la fila de encabezados: tiene una celda "codigo" y otra "descripcion"/"practica"/"nombre".
function encontrarEncabezado(filas: Fila[]): { fila: number; colCodigo: number; colDesc: number } | null {
  for (let i = 0; i < Math.min(filas.length, 30); i++) {
    const fila = filas[i] ?? [];
    let colCodigo = -1;
    let colDesc = -1;
    for (let c = 0; c < fila.length; c++) {
      const celda = normalizar(fila[c]);
      if (colCodigo === -1 && /^codigo/.test(celda) && !/modulo/.test(celda)) colCodigo = c;
      if (colDesc === -1 && /(descripcion.*practica|nombre de la practica|^practica$)/.test(celda)) colDesc = c;
    }
    if (colCodigo !== -1 && colDesc !== -1) return { fila: i, colCodigo, colDesc };
  }
  return null;
}

// Parsea una hoja con formato "una fila = una práctica".
// Estrategias de valor, en orden:
//  a) columnas "V.M.T." repetidas por período → usa el último período (con sus H.M. y GASTOS)
//  b) columnas HONORARIOS/BASICO + GASTOS/VALOR → total = suma
function parsearHoja(nombreHoja: string, ws: XLSX.WorkSheet, archivo: string): PracticaParseada[] {
  const filas = XLSX.utils.sheet_to_json<Fila>(ws, { header: 1 });
  const enc = encontrarEncabezado(filas);
  if (!enc) return [];

  // PAMI expresa honorarios/gastos en UNIDADES: si arriba del encabezado hay una
  // celda "UNIDADES" y un número suelto (el valor de la unidad en pesos), multiplicamos.
  let factorUnidad = 1;
  const hayUnidades = filas
    .slice(0, enc.fila)
    .some((f) => (f ?? []).some((v) => normalizar(v) === "unidades"));
  if (hayUnidades) {
    for (let i = 0; i < enc.fila; i++) {
      for (const v of filas[i] ?? []) {
        if (esNumero(v) && v > 1) {
          factorUnidad = v;
          break;
        }
      }
      if (factorUnidad !== 1) break;
    }
  }

  const encFila = filas[enc.fila] ?? [];
  // Sub-encabezado (fila siguiente) para hojas con períodos H.M./GASTOS/V.M.T.
  const subFila = filas[enc.fila + 1] ?? [];
  const vmtCols: number[] = [];
  const hmCols: number[] = [];
  const gastosSubCols: number[] = [];
  for (let c = 0; c < subFila.length; c++) {
    const celda = normalizar(subFila[c]);
    if (celda === "v.m.t.") vmtCols.push(c);
    if (celda === "h.m.") hmCols.push(c);
    if (celda === "gastos") gastosSubCols.push(c);
  }

  // Columnas por nombre en el encabezado principal
  let colHonorarios = -1;
  let colGastosValor = -1;
  let colBasico = -1;
  for (let c = 0; c < encFila.length; c++) {
    const celda = normalizar(encFila[c]);
    if (colHonorarios === -1 && /^honorarios$/.test(celda)) colHonorarios = c;
    if (colBasico === -1 && /^basico$/.test(celda)) colBasico = c;
    // "VALOR" de gastos (IOMA) o "GASTOS" (PAMI)
    if (/^gastos$/.test(celda)) colGastosValor = c;
    if (colGastosValor === -1 && /^valor$/.test(celda)) colGastosValor = c;
  }

  const usaPeriodos = vmtCols.length > 0;
  const inicioDatos = enc.fila + (usaPeriodos ? 2 : 1);
  const resultado: PracticaParseada[] = [];
  let capituloActual: string | null = null;

  for (let i = inicioDatos; i < filas.length; i++) {
    const fila = filas[i] ?? [];
    const codigoRaw = fila[enc.colCodigo];
    const descRaw = fila[enc.colDesc];

    // Fila con solo texto en la primera celda → título de capítulo/sección
    const celdasConDato = fila.filter((v) => v !== null && v !== undefined && v !== "").length;
    if (celdasConDato === 1 && typeof fila[0] === "string" && limpiarTexto(fila[0]).length > 2) {
      capituloActual = limpiarTexto(fila[0]);
      continue;
    }

    const codigo = limpiarTexto(codigoRaw);
    const descripcion = limpiarTexto(descRaw ?? (typeof codigoRaw === "string" ? fila[enc.colDesc + 1] : null));
    if (!codigo || !descripcion) continue;
    // El código tiene que tener al menos un dígito
    if (!/\d/.test(codigo)) continue;

    let honorarios: number | null = null;
    let gastos: number | null = null;
    let valorTotal: number | null = null;

    if (usaPeriodos) {
      // Tomar el último período con V.M.T. numérico
      for (let p = vmtCols.length - 1; p >= 0; p--) {
        const v = fila[vmtCols[p]];
        if (esNumero(v) && v > 0) {
          valorTotal = v;
          const hm = fila[hmCols[p] ?? -1];
          const g = fila[gastosSubCols[p] ?? -1];
          honorarios = esNumero(hm) ? hm : null;
          gastos = esNumero(g) ? g : null;
          break;
        }
      }
    } else {
      const h = colBasico !== -1 ? fila[colBasico] : colHonorarios !== -1 ? fila[colHonorarios] : null;
      const g = colGastosValor !== -1 ? fila[colGastosValor] : null;
      honorarios = esNumero(h) ? h : null;
      gastos = esNumero(g) ? g : null;
      if (honorarios != null || gastos != null) {
        valorTotal = (honorarios ?? 0) + (gastos ?? 0);
      }
    }

    if (valorTotal == null || valorTotal <= 0) continue;

    if (factorUnidad !== 1) {
      valorTotal = valorTotal * factorUnidad;
      honorarios = honorarios != null ? honorarios * factorUnidad : null;
      gastos = gastos != null ? gastos * factorUnidad : null;
    }

    resultado.push({
      codigo,
      descripcion,
      capitulo: capituloActual,
      honorarios,
      gastos,
      valorTotal: Math.round(valorTotal * 100) / 100,
      origen: `${archivo} / ${nombreHoja}`,
    });
  }
  return resultado;
}

// Parsea un workbook completo (xls/xlsx). Devuelve prácticas deduplicadas por código
// (se queda con la primera aparición).
export function parsearNomenclador(buffer: Buffer, nombreArchivo: string): PracticaParseada[] {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const porCodigo = new Map<string, PracticaParseada>();
  for (const nombreHoja of wb.SheetNames) {
    const practicas = parsearHoja(nombreHoja, wb.Sheets[nombreHoja], nombreArchivo);
    for (const p of practicas) {
      if (!porCodigo.has(p.codigo)) porCodigo.set(p.codigo, p);
    }
  }
  return [...porCodigo.values()];
}
