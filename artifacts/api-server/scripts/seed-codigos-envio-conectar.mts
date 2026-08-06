// Superseded: la planilla vive en src/lib/seed-planilla-conectar.ts y se
// aplica sola al arrancar el server (dev y prod). Este script solo la corre
// a mano: pnpm --filter @workspace/api-server exec tsx scripts/seed-codigos-envio-conectar.mts
import { seedPlanillaConectar } from "../src/lib/seed-planilla-conectar";

await seedPlanillaConectar();
process.exit(0);
