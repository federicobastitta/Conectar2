// Verificación post-publicación: corre contra la URL publicada después de
// cada publish para detectar roturas antes de que las descubra el personal.
//
// Uso:
//   BASE_URL=https://<app-publicada> \
//   VERIF_EMAIL=<usuario> VERIF_PASSWORD=<clave> \
//   pnpm --filter @workspace/api-server exec tsx scripts/verificacion-post-publicacion.mts
//
// - BASE_URL: URL publicada, sin barra final (obligatoria).
// - VERIF_EMAIL / VERIF_PASSWORD: credenciales de un usuario real (opcional
//   pero recomendado; sin ellas solo se chequean salud y pantalla pública).
//
// Sale con código 0 si todo pasa; distinto de 0 si algo falla (apto para CI).

const BASE_URL = (process.env.BASE_URL ?? "").replace(/\/+$/, "");
const EMAIL = process.env.VERIF_EMAIL;
const PASSWORD = process.env.VERIF_PASSWORD;

if (!BASE_URL) {
  console.error("Falta BASE_URL (ej: BASE_URL=https://mi-app.replit.app)");
  process.exit(2);
}

type Resultado = { nombre: string; ok: boolean; detalle: string };
const resultados: Resultado[] = [];

function registrar(nombre: string, ok: boolean, detalle: string) {
  resultados.push({ nombre, ok, detalle });
  console.log(`${ok ? "✔" : "✘"} ${nombre} — ${detalle}`);
}

async function pedir(path: string, init?: RequestInit): Promise<Response> {
  const controlador = new AbortController();
  const timer = setTimeout(() => controlador.abort(), 15_000);
  try {
    return await fetch(`${BASE_URL}${path}`, { ...init, signal: controlador.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 1) Salud de la app + base de datos (sin autenticación)
try {
  const res = await pedir("/api/salud");
  const body = (await res.json()) as { ok?: boolean; db?: { ok?: boolean; error?: string }; version?: string };
  registrar(
    "GET /api/salud",
    res.status === 200 && body.ok === true && body.db?.ok === true,
    `HTTP ${res.status}, db=${body.db?.ok ? "ok" : `FALLA (${body.db?.error ?? "?"})`}, version=${body.version ?? "?"}`,
  );
} catch (err) {
  registrar("GET /api/salud", false, String(err));
}

// 2) Pantalla principal (frontend servido)
try {
  const res = await pedir("/");
  const html = await res.text();
  registrar(
    "GET / (frontend)",
    res.status === 200 && html.toLowerCase().includes("<!doctype html"),
    `HTTP ${res.status}, ${html.length} bytes`,
  );
} catch (err) {
  registrar("GET / (frontend)", false, String(err));
}

// 3) Login de prueba + endpoints clave autenticados
if (!EMAIL || !PASSWORD) {
  console.log("⚠ VERIF_EMAIL/VERIF_PASSWORD no configurados: se omiten login y endpoints autenticados.");
} else {
  let token: string | undefined;
  try {
    const res = await pedir("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const body = (await res.json()) as { token?: string };
    token = body.token;
    registrar("POST /api/auth/login", res.status === 200 && !!token, `HTTP ${res.status}`);
  } catch (err) {
    registrar("POST /api/auth/login", false, String(err));
  }

  if (token) {
    const auth = { Authorization: `Bearer ${token}` };
    const endpoints = [
      "/api/auth/me",
      "/api/dashboard/resumen",
      "/api/pacientes?limit=1",
      `/api/turnos?limit=1&fecha=${new Date().toISOString().split("T")[0]}`,
    ];
    for (const ep of endpoints) {
      try {
        const res = await pedir(ep, { headers: auth });
        registrar(`GET ${ep}`, res.status === 200, `HTTP ${res.status}`);
      } catch (err) {
        registrar(`GET ${ep}`, false, String(err));
      }
    }
    // Cerrar la sesión de prueba para no dejar tokens colgados.
    try {
      await pedir("/api/auth/logout", { method: "POST", headers: auth });
    } catch {
      /* no crítico */
    }
  }
}

const fallas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - fallas.length}/${resultados.length} verificaciones OK`);
if (fallas.length > 0) {
  console.error(`FALLARON: ${fallas.map((f) => f.nombre).join(", ")}`);
  process.exit(1);
}
process.exit(0);
