/**
 * Stage raw — Lee el Excel desde S3 y produce filas crudas.
 * No transforma ni valida datos; solo extrae y registra el origen.
 * El Excel puede tener cualquier cabecera — se mapea en staging.
 */

import type { FilaRaw } from "../types.js";

/**
 * Lee un archivo Excel (buffer) y produce filas raw.
 * El índice de cabecera es configurable (default fila 1 del Excel).
 * Usa ExcelJS si está disponible; de lo contrario lanza error descriptivo.
 */
export async function leerExcelRaw(
  buffer: Buffer,
  opts: {
    uploadId: string;
    archivoS3Key: string;
    hojaIndex?: number;      // índice de hoja (0-based, default 0)
    filaEncabezado?: number; // fila de cabeceras (1-based, default 1)
    log?: (msg: string) => void;
  },
): Promise<FilaRaw[]> {
  const { uploadId, archivoS3Key, hojaIndex = 0, filaEncabezado = 1, log = console.log } = opts;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ExcelJS: any;
  try {
    // Importación dinámica — exceljs es peer dependency opcional.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    ExcelJS = await import("exceljs");
  } catch {
    throw new Error(
      "[alephoo:raw] exceljs no está instalado. " +
        "Instalar con: pnpm --filter @workspace/api-server add exceljs",
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const workbook = new ExcelJS.default.Workbook();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  await workbook.xlsx.load(buffer);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
  const sheet = workbook.worksheets[hojaIndex];
  if (!sheet) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    throw new Error(
      `[alephoo:raw] Hoja de índice ${hojaIndex} no encontrada en el archivo. ` +
        `El libro tiene ${workbook.worksheets.length} hoja(s).`,
    );
  }

  // Leer cabeceras
  const cabeceras: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const filaHeader = sheet.getRow(filaEncabezado);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  filaHeader.eachCell((cell: { value: unknown }, colNum: number) => {
    cabeceras[colNum - 1] = String(cell.value ?? `columna_${colNum}`).trim();
  });

  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  log(`[alephoo:raw] Hoja: "${sheet.name}" — ${cabeceras.length} columnas, ${sheet.rowCount - filaEncabezado} filas de datos`);

  const filasRaw: FilaRaw[] = [];

  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  sheet.eachRow((row: { values: unknown[]; eachCell: (opts: unknown, cb: (cell: { value: unknown }, col: number) => void) => void }, rowNum: number) => {
    if (rowNum <= filaEncabezado) return;
    if (row.values.every((v) => v === null || v === undefined || v === "")) return;

    const datos: Record<string, unknown> = {};
    row.eachCell({ includeEmpty: true }, (cell: { value: unknown }, colNum: number) => {
      const cabecera = cabeceras[colNum - 1] ?? `col_${colNum}`;
      let valor: unknown = cell.value;
      if (valor instanceof Date) {
        valor = valor.toISOString();
      } else if (typeof valor === "object" && valor !== null && "result" in valor) {
        valor = (valor as { result: unknown }).result;
      }
      datos[cabecera] = valor;
    });

    filasRaw.push({
      filaNumero: rowNum,
      datos,
      archivoS3Key,
      uploadId,
    });
  });

  log(`[alephoo:raw] ${filasRaw.length} filas crudas extraídas`);
  return filasRaw;
}

/**
 * Descarga el buffer del Excel desde S3.
 * Requiere @aws-sdk/client-s3 instalado en el servicio.
 */
export async function descargarExcelDeS3(params: {
  bucket: string;
  key: string;
  log?: (msg: string) => void;
}): Promise<Buffer> {
  const { log = console.log } = params;
  log(`[alephoo:raw] Descargando Excel: s3://${params.bucket}/${params.key}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { S3Client, GetObjectCommand } = await (import("@aws-sdk/client-s3") as Promise<any>).catch(() => {
    throw new Error("[alephoo:raw] @aws-sdk/client-s3 no está instalado.");
  }) as { S3Client: new (cfg: unknown) => unknown; GetObjectCommand: new (cfg: unknown) => unknown };

  const client = new S3Client({
    region: process.env.CLINICA_S3_REGION ?? "us-east-1",
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const response: { Body?: AsyncIterable<Uint8Array> } = await (client as any).send(
    new GetObjectCommand({ Bucket: params.bucket, Key: params.key }),
  );

  if (!response.Body) {
    throw new Error(`[alephoo:raw] S3 devolvió body vacío para ${params.key}`);
  }

  const { Readable } = await import("node:stream");
  const stream = Readable.from(response.Body);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  const buffer = Buffer.concat(chunks);
  log(`[alephoo:raw] Descargado: ${buffer.length} bytes`);
  return buffer;
}
