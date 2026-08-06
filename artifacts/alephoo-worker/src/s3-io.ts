/**
 * Lectura/escritura S3 para el worker Alephoo.
 * Credenciales exclusivamente via IAM Role (ECS Task Role) o AWS_PROFILE.
 * Nunca ACCESS_KEY_ID hardcodeado.
 */

import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import type { WorkerConfig } from "./config.js";

let s3: S3Client | null = null;

function getS3Client(cfg: WorkerConfig): S3Client {
  if (s3) return s3;
  s3 = new S3Client({ region: cfg.s3Region });
  return s3;
}

export async function descargarExcel(cfg: WorkerConfig, key: string): Promise<Buffer> {
  const client = getS3Client(cfg);
  console.log(`[s3] Descargando s3://${cfg.s3Bucket}/${key}`);
  const res = await client.send(new GetObjectCommand({ Bucket: cfg.s3Bucket, Key: key }));
  if (!res.Body) throw new Error(`[s3] Sin cuerpo en la respuesta para ${key}`);

  const chunks: Uint8Array[] = [];
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  const buf = Buffer.concat(chunks);
  console.log(`[s3] Descargados ${buf.length} bytes`);
  return buf;
}

export async function subirReporte(
  cfg: WorkerConfig,
  prefijo: string,
  nombre: string,
  contenido: Buffer | string,
  contentType = "application/json",
): Promise<string> {
  const client = getS3Client(cfg);
  const key = `${prefijo}/${nombre}`;
  await client.send(
    new PutObjectCommand({
      Bucket: cfg.s3Bucket,
      Key: key,
      Body: typeof contenido === "string" ? Buffer.from(contenido, "utf-8") : contenido,
      ContentType: contentType,
      ServerSideEncryption: "AES256",
    }),
  );
  console.log(`[s3] Reporte subido: s3://${cfg.s3Bucket}/${key}`);
  return key;
}

export async function listarArchivosRaw(cfg: WorkerConfig): Promise<{ key: string; size: number; lastModified: Date }[]> {
  const client = getS3Client(cfg);
  const res = await client.send(
    new ListObjectsV2Command({
      Bucket: cfg.s3Bucket,
      Prefix: cfg.s3RawPrefix + "/",
    }),
  );
  return (res.Contents ?? [])
    .filter((o) => o.Key?.endsWith(".xlsx") || o.Key?.endsWith(".xls"))
    .map((o) => ({ key: o.Key!, size: o.Size ?? 0, lastModified: o.LastModified ?? new Date() }));
}
