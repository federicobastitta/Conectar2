import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  useGetMe,
  useGetPreferenciasPerfil,
  useUpdatePreferenciasPerfil,
  useMarcarCumpleVisto,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, PartyPopper } from "lucide-react";

// Catálogo de hobbies con emoji y colores para las tarjetas
export const HOBBIES_CATALOGO: { clave: string; emoji: string; etiqueta: string; color: string }[] = [
  { clave: "musica", emoji: "🎵", etiqueta: "Música", color: "from-violet-500/30 to-purple-600/20" },
  { clave: "futbol", emoji: "⚽", etiqueta: "Fútbol", color: "from-green-500/30 to-emerald-600/20" },
  { clave: "cocina", emoji: "🍳", etiqueta: "Cocina", color: "from-orange-500/30 to-amber-600/20" },
  { clave: "lectura", emoji: "📚", etiqueta: "Lectura", color: "from-blue-500/30 to-sky-600/20" },
  { clave: "viajes", emoji: "✈️", etiqueta: "Viajes", color: "from-cyan-500/30 to-teal-600/20" },
  { clave: "mascotas", emoji: "🐶", etiqueta: "Mascotas", color: "from-yellow-500/30 to-amber-500/20" },
  { clave: "cine", emoji: "🎬", etiqueta: "Cine y series", color: "from-red-500/30 to-rose-600/20" },
  { clave: "jardineria", emoji: "🌱", etiqueta: "Jardinería", color: "from-lime-500/30 to-green-600/20" },
  { clave: "tecnologia", emoji: "💻", etiqueta: "Tecnología", color: "from-slate-500/30 to-zinc-600/20" },
  { clave: "arte", emoji: "🎨", etiqueta: "Arte", color: "from-pink-500/30 to-fuchsia-600/20" },
  { clave: "deporte", emoji: "🏃", etiqueta: "Deporte", color: "from-emerald-500/30 to-teal-600/20" },
  { clave: "mate", emoji: "🧉", etiqueta: "Mate y amigos", color: "from-teal-500/30 to-green-600/20" },
];

export function emojiDeHobby(clave: string): string {
  return HOBBIES_CATALOGO.find((h) => h.clave === clave)?.emoji ?? "✨";
}

const FRASES = [
  (n: string) => `¡Claro, ${n}!`,
  (n: string) => `Todo listo, ${n}`,
  (n: string) => `¿Qué hacemos hoy, ${n}?`,
  (n: string) => `¡Buen día, ${n}!`,
  (n: string) => `Contá conmigo, ${n}`,
  (n: string) => `A tu servicio, ${n}`,
];

/** Nombre corto para saludar: apodo elegido o primer nombre. */
export function nombreCorto(apodo: string | null | undefined, nombre: string | undefined): string {
  if (apodo && apodo.trim()) return apodo.trim();
  return (nombre ?? "").split(" ")[0] || "";
}

/** Frase rotativa personalizada ("claro, Natalia") para mostrar en el header. */
export function FrasePersonal() {
  const { data: user } = useGetMe({ query: { retry: false } });
  const { data: prefs } = useGetPreferenciasPerfil({ query: { retry: false, enabled: !!user } });
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * FRASES.length));

  useEffect(() => {
    const t = setInterval(() => setIdx((i) => (i + 1) % FRASES.length), 25_000);
    return () => clearInterval(t);
  }, []);

  const n = nombreCorto(prefs?.apodo, user?.nombre);
  if (!n) return null;

  const emojis = (prefs?.hobbies ?? []).slice(0, 2).map(emojiDeHobby).join(" ");
  return (
    <span className="hidden md:inline-flex items-center gap-1.5 text-[12px] text-sidebar-foreground/70 italic mr-1 select-none" data-testid="text-frase-personal">
      {FRASES[idx](n)} {emojis && <span className="not-italic">{emojis}</span>}
    </span>
  );
}

function EncuestaBienvenida({ nombre, onListo }: { nombre: string; onListo: () => void }) {
  const [seleccion, setSeleccion] = useState<string[]>([]);
  const [apodo, setApodo] = useState("");
  const [fechaNacimiento, setFechaNacimiento] = useState("");
  const [gustos, setGustos] = useState("");
  const queryClient = useQueryClient();
  const guardar = useUpdatePreferenciasPerfil({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries();
        onListo();
      },
    },
  });

  const toggle = (clave: string) =>
    setSeleccion((s) => (s.includes(clave) ? s.filter((x) => x !== clave) : [...s, clave]));

  return (
    <Dialog open>
      <DialogContent className="max-w-lg max-h-[90dvh] overflow-y-auto" data-testid="dialog-encuesta-bienvenida">
        <DialogHeader>
          <DialogTitle className="text-xl">¡Hola, {nombre}! 👋 Queremos conocerte</DialogTitle>
          <DialogDescription>
            Contanos un poco de vos para que Conectar se sienta más tuyo. Es un minuto, una sola vez.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div>
            <Label className="mb-2 block">¿Qué te gusta hacer? Elegí todo lo que quieras</Label>
            <div className="grid grid-cols-3 gap-2">
              {HOBBIES_CATALOGO.map((h) => (
                <button
                  key={h.clave}
                  type="button"
                  onClick={() => toggle(h.clave)}
                  data-testid={`button-hobby-${h.clave}`}
                  className={`rounded-lg border p-2.5 text-center transition-all bg-gradient-to-br ${h.color} ${
                    seleccion.includes(h.clave)
                      ? "border-primary ring-2 ring-primary/50 scale-[1.03]"
                      : "border-border opacity-75 hover:opacity-100"
                  }`}
                >
                  <div className="text-2xl">{h.emoji}</div>
                  <div className="text-[11px] mt-1 font-medium">{h.etiqueta}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="apodo" className="mb-1.5 block">¿Cómo te gusta que te llamen?</Label>
              <Input
                id="apodo"
                data-testid="input-apodo"
                placeholder={nombre}
                value={apodo}
                onChange={(e) => setApodo(e.target.value)}
                maxLength={60}
              />
            </div>
            <div>
              <Label htmlFor="fecha-nac" className="mb-1.5 block">Tu fecha de nacimiento 🎂</Label>
              <Input
                id="fecha-nac"
                data-testid="input-fecha-nacimiento"
                type="date"
                value={fechaNacimiento}
                onChange={(e) => setFechaNacimiento(e.target.value)}
              />
            </div>
          </div>

          <div>
            <Label htmlFor="gustos" className="mb-1.5 block">Algo más que quieras contarnos (opcional)</Label>
            <Textarea
              id="gustos"
              data-testid="input-gustos-libres"
              placeholder="Ej: me gusta el mate amargo, hincha de River, tengo dos gatos..."
              value={gustos}
              onChange={(e) => setGustos(e.target.value)}
              maxLength={500}
              rows={2}
            />
          </div>

          <div className="flex justify-between items-center pt-1">
            <Button
              variant="ghost"
              data-testid="button-encuesta-omitir"
              onClick={() =>
                guardar.mutate({ data: { hobbies: [], gustosLibres: null, fechaNacimiento: null, apodo: null } })
              }
              disabled={guardar.isPending}
            >
              Ahora no
            </Button>
            <Button
              data-testid="button-encuesta-guardar"
              onClick={() =>
                guardar.mutate({
                  data: {
                    hobbies: seleccion,
                    gustosLibres: gustos.trim() || null,
                    fechaNacimiento: fechaNacimiento || null,
                    apodo: apodo.trim() || null,
                  },
                })
              }
              disabled={guardar.isPending}
            >
              {guardar.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              ¡Listo! 🎉
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SaludoCumple({ nombre, hobbies, onCerrar }: { nombre: string; hobbies: string[]; onCerrar: () => void }) {
  const emojis = hobbies.length > 0 ? hobbies.map(emojiDeHobby) : ["🎈", "🎁", "🎊"];
  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-gradient-to-br from-indigo-950 via-purple-900 to-fuchsia-900 text-white text-center p-6"
      data-testid="overlay-cumple"
    >
      <div className="text-6xl mb-4 animate-bounce">🎂</div>
      <h1 className="text-3xl md:text-5xl font-bold mb-3">¡Feliz cumpleaños, {nombre}!</h1>
      <p className="text-lg md:text-xl text-white/80 max-w-md mb-6">
        De parte de todo el equipo de Diagnosticar, te deseamos un día hermoso. Gracias por ser parte de Conectar. 💙
      </p>
      <div className="flex gap-3 text-4xl mb-8">
        {emojis.slice(0, 5).map((e, i) => (
          <span key={i} className="animate-pulse" style={{ animationDelay: `${i * 200}ms` }}>{e}</span>
        ))}
      </div>
      <Button
        size="lg"
        variant="secondary"
        data-testid="button-cerrar-cumple"
        onClick={onCerrar}
        className="gap-2"
      >
        <PartyPopper className="w-5 h-5" /> ¡Gracias!
      </Button>
    </div>
  );
}

/**
 * Gate global de personalización: encuesta de bienvenida (una vez) y
 * saludo de cumpleaños a pantalla completa. Cubre staff y pacientes.
 */
export function PersonalizacionGate() {
  const [location] = useLocation();
  const { data: user } = useGetMe({ query: { retry: false } });
  const { data: prefs } = useGetPreferenciasPerfil({ query: { retry: false, enabled: !!user } });
  const [encuestaCerrada, setEncuestaCerrada] = useState(false);
  const [cumpleCerrado, setCumpleCerrado] = useState(false);
  const queryClient = useQueryClient();
  const marcarVisto = useMarcarCumpleVisto({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).includes("preferencias") }),
    },
  });

  // No molestar en pantallas de dispositivo/kiosco ni en login
  const rutasExcluidas = ["/login", "/pantalla-sala"];
  const excluida = useMemo(() => rutasExcluidas.some((r) => location.startsWith(r)), [location]);

  if (!user || !prefs || excluida) return null;

  const nombre = nombreCorto(prefs.apodo, user.nombre);

  if (prefs.saludoCumplePendiente && !cumpleCerrado) {
    return (
      <SaludoCumple
        nombre={nombre}
        hobbies={prefs.hobbies}
        onCerrar={() => {
          setCumpleCerrado(true);
          marcarVisto.mutate();
        }}
      />
    );
  }

  if (!prefs.encuestaCompletada && !encuestaCerrada) {
    return <EncuestaBienvenida nombre={nombre} onListo={() => setEncuestaCerrada(true)} />;
  }

  return null;
}
