import { useCallback, useEffect, useRef, useState } from "react";
import type { MiSalaEsperaTurno } from "@workspace/api-client-react";

type EstadoPermiso = "granted" | "denied" | "default" | "unsupported";

const STORAGE_KEY = "mi-turno-avisos-activados";

function getNotifPermission(): EstadoPermiso {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

function getPreferenciaGuardada(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function guardarPreferencia() {
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // localStorage no disponible (modo privado, etc.)
  }
}

export function useLlamadoAlert(turnos: MiSalaEsperaTurno[]) {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const yaAvisadosRef = useRef<Set<number>>(new Set());
  const [notifPermission, setNotifPermission] = useState<EstadoPermiso>(getNotifPermission);
  const [sonidoActivado, setSonidoActivado] = useState(false);

  const desbloquearAudio = useCallback(async () => {
    try {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctx) {
        if (!audioCtxRef.current) audioCtxRef.current = new Ctx();
        await audioCtxRef.current.resume();
        if (audioCtxRef.current.state === "running") {
          setSonidoActivado(true);
          return true;
        }
      }
    } catch {
      // sin soporte de audio: la experiencia visual sigue igual
    }
    return false;
  }, []);

  const activarAvisos = useCallback(async () => {
    const ok = await desbloquearAudio();
    if (ok) guardarPreferencia();
    try {
      if ("Notification" in window && Notification.permission === "default") {
        const p = await Notification.requestPermission();
        setNotifPermission(p);
      } else {
        setNotifPermission(getNotifPermission());
      }
    } catch {
      setNotifPermission(getNotifPermission());
    }
  }, [desbloquearAudio]);

  // Si el paciente ya había activado los avisos, re-desbloquear el audio con la
  // primera interacción en la página (los navegadores exigen un gesto del usuario)
  useEffect(() => {
    if (!getPreferenciaGuardada()) return;

    let activo = true;
    const eventos: (keyof WindowEventMap)[] = ["pointerdown", "keydown", "touchstart"];

    const intentar = () => {
      void desbloquearAudio().then((ok) => {
        if (ok && activo) limpiar();
      });
    };
    const limpiar = () => {
      for (const ev of eventos) window.removeEventListener(ev, intentar);
    };

    // Algunos navegadores permiten reanudar sin gesto si ya hubo permiso previo
    intentar();
    for (const ev of eventos) window.addEventListener(ev, intentar);

    return () => {
      activo = false;
      limpiar();
    };
  }, [desbloquearAudio]);

  const reproducirTono = useCallback(() => {
    const ctx = audioCtxRef.current;
    if (!ctx || ctx.state !== "running") return;
    try {
      const ahora = ctx.currentTime;
      [0, 0.35, 0.7].forEach((offset, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(i === 2 ? 1175 : 880, ahora + offset);
        gain.gain.setValueAtTime(0.0001, ahora + offset);
        gain.gain.exponentialRampToValueAtTime(0.35, ahora + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ahora + offset + 0.3);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ahora + offset);
        osc.stop(ahora + offset + 0.32);
      });
    } catch {
      // ignorar errores de audio
    }
  }, []);

  const dispararAlerta = useCallback(
    (turno: MiSalaEsperaTurno) => {
      reproducirTono();

      if (typeof navigator !== "undefined" && "vibrate" in navigator) {
        try {
          navigator.vibrate([300, 120, 300, 120, 500]);
        } catch {
          // sin soporte de vibración
        }
      }

      if ("Notification" in window && Notification.permission === "granted") {
        try {
          const donde = turno.profesionalNombre
            ? `${turno.turneraNombre} — ${turno.profesionalNombre}`
            : turno.turneraNombre;
          new Notification("¡Te están llamando!", {
            body: `Acercate al consultorio ahora. ${donde}`,
            tag: `llamado-${turno.turnoId}`,
            icon: "/favicon.ico",
          });
        } catch {
          // algunos navegadores móviles requieren service worker; ignorar
        }
      }
    },
    [reproducirTono]
  );

  useEffect(() => {
    for (const turno of turnos) {
      if (turno.estado === "llamado") {
        if (!yaAvisadosRef.current.has(turno.turnoId)) {
          yaAvisadosRef.current.add(turno.turnoId);
          dispararAlerta(turno);
        }
      } else {
        // si vuelve a espera y lo llaman de nuevo, avisar otra vez
        yaAvisadosRef.current.delete(turno.turnoId);
      }
    }
  }, [turnos, dispararAlerta]);

  useEffect(() => {
    return () => {
      audioCtxRef.current?.close().catch(() => undefined);
    };
  }, []);

  return {
    activarAvisos,
    sonidoActivado,
    notifPermission,
    preferenciaGuardada: getPreferenciaGuardada(),
  };
}
