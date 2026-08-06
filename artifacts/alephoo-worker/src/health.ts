/**
 * Health check HTTP mínimo — requerido por ECS para determinar si el task está vivo.
 * El worker es un job de una sola ejecución; este servidor corre solo durante la ejecución.
 * ECS lo usa para health checks del task definition (optional en Fargate scheduled tasks).
 */

import { createServer, type Server } from "node:http";

let server: Server | null = null;
let healthy = true;
let statusDetail = "iniciando";

export function iniciarHealthServer(port: number): void {
  server = createServer((req, res) => {
    if (req.url === "/health" || req.url === "/alephoo-worker/health") {
      res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: healthy, status: statusDetail, ts: new Date().toISOString() }));
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  server.listen(port, () => {
    console.log(`[health] HTTP en :${port}/health`);
  });
}

export function setHealthy(ok: boolean, detail: string): void {
  healthy = ok;
  statusDetail = detail;
}

export function cerrarHealthServer(): void {
  server?.close();
  server = null;
}
