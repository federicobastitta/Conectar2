import { Router, type IRouter } from "express";
import { UpdatePreferenciasPerfilBody } from "@workspace/api-zod";
import { getUserIdFromToken } from "./auth";
import { hoyArgentina } from "../lib/tiempo";
import {
  obtenerPreferencias,
  guardarPreferencias,
  marcarSaludoCumpleVisto,
  type PreferenciasRow,
} from "../integraciones/preferencias-db";

const router: IRouter = Router();

async function autenticar(req: Parameters<Parameters<IRouter["get"]>[1]>[0]): Promise<number | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  return getUserIdFromToken(auth.slice(7));
}

function esCumpleHoy(fechaNacimiento: string | null, hoy: string): boolean {
  if (!fechaNacimiento) return false;
  return fechaNacimiento.slice(5) === hoy.slice(5);
}

function serializar(row: PreferenciasRow | null) {
  const hoy = hoyArgentina();
  const cumple = esCumpleHoy(row?.fecha_nacimiento ?? null, hoy);
  return {
    hobbies: row?.hobbies ? row.hobbies.split(",").filter(Boolean) : [],
    gustosLibres: row?.gustos_libres ?? null,
    fechaNacimiento: row?.fecha_nacimiento ?? null,
    apodo: row?.apodo ?? null,
    encuestaCompletada: row?.encuesta_completada ?? false,
    esCumpleHoy: cumple,
    saludoCumplePendiente: cumple && row?.ultimo_saludo_cumple !== hoy,
  };
}

router.get("/perfil/preferencias", async (req, res): Promise<void> => {
  const userId = await autenticar(req);
  if (userId == null) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  try {
    const row = await obtenerPreferencias(userId);
    res.json(serializar(row));
  } catch (err) {
    req.log.error({ err }, "Error obteniendo preferencias de usuario");
    res.status(500).json({ error: "Error obteniendo preferencias" });
  }
});

router.put("/perfil/preferencias", async (req, res): Promise<void> => {
  const userId = await autenticar(req);
  if (userId == null) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  const parsed = UpdatePreferenciasPerfilBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { hobbies, gustosLibres, fechaNacimiento, apodo } = parsed.data;
  try {
    await guardarPreferencias(userId, {
      hobbies: hobbies.map((h) => h.trim()).filter(Boolean).join(","),
      gustosLibres: gustosLibres?.trim() || null,
      fechaNacimiento: fechaNacimiento ?? null,
      apodo: apodo?.trim() || null,
    });
    const row = await obtenerPreferencias(userId);
    res.json(serializar(row));
  } catch (err) {
    req.log.error({ err }, "Error guardando preferencias de usuario");
    res.status(500).json({ error: "Error guardando preferencias" });
  }
});

router.post("/perfil/preferencias/cumple-visto", async (req, res): Promise<void> => {
  const userId = await autenticar(req);
  if (userId == null) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  try {
    await marcarSaludoCumpleVisto(userId, hoyArgentina());
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Error marcando saludo de cumpleaños");
    res.status(500).json({ error: "Error marcando saludo" });
  }
});

export default router;
