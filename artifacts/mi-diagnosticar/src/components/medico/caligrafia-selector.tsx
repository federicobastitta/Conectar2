// Elección de la letra manuscrita del médico (la que "escribe" sus recetas,
// certificados y órdenes en PDF). Se elige UNA sola vez y queda definitiva:
// una vez confirmada, el backend rechaza cualquier cambio.
import { useEffect, useMemo, useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { PenLine, Lock } from "lucide-react";

const NOMBRES = [
  "Cursiva ágil",
  "Compacta y derecha",
  "Cursiva redondeada",
  "Grande y marcada",
  "Fina y espaciada",
  "Imprenta (letra de molde)",
];

const FRASE = "Reposo por 48 hs. Control clínico y evaluación general.";

type Estado = { elegida: number | null; estiloActual: number; cantidad: number; tinta: string };

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${localStorage.getItem("auth_token") ?? ""}` };
}

export function CaligrafiaSelector() {
  const { user } = useAuth();
  const { toast } = useToast();
  const esMedico = user?.rol === "medico" && user?.profesionalId != null;
  const [abierto, setAbierto] = useState(false);
  const [estado, setEstado] = useState<Estado | null>(null);
  const [fuentesListas, setFuentesListas] = useState(false);
  const [seleccion, setSeleccion] = useState<number | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    if (!esMedico) return;
    fetch("/api/perfil/caligrafia", { headers: authHeaders() })
      .then(async (r) => (r.ok ? ((await r.json()) as Estado) : null))
      .then((e) => setEstado(e))
      .catch(() => setEstado(null));
  }, [esMedico]);

  const cantidad = estado?.cantidad ?? 6;

  // Carga las fuentes reales del backend para que la vista previa sea EXACTA
  // a lo que sale impreso (misma tipografía que usa el PDF).
  useEffect(() => {
    if (!abierto || fuentesListas || !estado) return;
    let cancelado = false;
    void (async () => {
      try {
        await Promise.all(
          Array.from({ length: cantidad }, async (_, i) => {
            if (document.fonts.check(`16px CaligrafiaMedica${i}`)) return;
            const r = await fetch(`/api/perfil/caligrafia/fuente/${i}`, { headers: authHeaders() });
            if (!r.ok) throw new Error("fuente");
            const fuente = new FontFace(`CaligrafiaMedica${i}`, await r.arrayBuffer());
            await fuente.load();
            document.fonts.add(fuente);
          }),
        );
        if (!cancelado) setFuentesListas(true);
      } catch {
        // Sin las fuentes reales seguimos igual con una cursiva del sistema:
        // peor vista previa, pero la elección nunca queda bloqueada.
        if (!cancelado) {
          setFuentesListas(true);
          toast({ title: "No se pudieron cargar las letras reales", description: "Se muestra una vista previa aproximada.", variant: "destructive" });
        }
      }
    })();
    return () => { cancelado = true; };
  }, [abierto, fuentesListas, estado, cantidad, toast]);

  const tinta = estado?.tinta ?? "#1B3FA8";
  const yaElegida = estado?.elegida != null;

  const muestra = useMemo(() => (i: number, grande = false) => (
    <span
      style={{ fontFamily: `CaligrafiaMedica${i}, cursive`, color: tinta, fontSize: grande ? "1.35rem" : "1.2rem", lineHeight: 1.35 }}
    >
      {FRASE}
    </span>
  ), [tinta]);

  if (!esMedico || !estado) return null;

  const confirmar = async () => {
    if (seleccion == null) return;
    setGuardando(true);
    try {
      const r = await fetch("/api/perfil/caligrafia", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ estilo: seleccion }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.status === 409) {
        // Ya había una elección hecha (otra pestaña / carrera): refrescamos y
        // pasamos directo al estado bloqueado en vez de dejar reintentar.
        const e2 = await fetch("/api/perfil/caligrafia", { headers: authHeaders() })
          .then(async (x) => (x.ok ? ((await x.json()) as Estado) : null)).catch(() => null);
        if (e2) setEstado(e2);
        setConfirmando(false);
        toast({ title: "Tu letra ya estaba elegida", description: "La elección es definitiva.", variant: "destructive" });
        return;
      }
      if (!r.ok) throw new Error(body?.error ?? "No se pudo guardar");
      setEstado({ ...estado, elegida: seleccion, estiloActual: seleccion });
      setConfirmando(false);
      toast({ title: "Letra registrada", description: "A partir de ahora todos tus documentos salen con esta caligrafía. Ya no se puede cambiar." });
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "No se pudo guardar", variant: "destructive" });
    } finally {
      setGuardando(false);
    }
  };

  return (
    <Dialog open={abierto} onOpenChange={(v) => { setAbierto(v); if (!v) { setConfirmando(false); setSeleccion(null); } }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="button-mi-letra">
          <PenLine className="w-4 h-4 mr-1" />
          Mi letra
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Mi letra manuscrita</DialogTitle>
          <DialogDescription>
            {yaElegida
              ? "Tu caligrafía ya quedó registrada de forma definitiva. Así se ve en tus documentos:"
              : "Es la caligrafía con la que salen escritos tus certificados, recetas y órdenes. Se elige una sola vez y no se puede cambiar."}
          </DialogDescription>
        </DialogHeader>

        {!fuentesListas ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Cargando letras…</p>
        ) : yaElegida ? (
          <div className="rounded-lg border p-4 bg-muted/30" data-testid="letra-definitiva">
            <div className="flex items-center gap-2 mb-2 text-sm text-muted-foreground">
              <Lock className="w-4 h-4" />
              {NOMBRES[estado.elegida!] ?? "Tu letra"} — definitiva
            </div>
            {muestra(estado.elegida!, true)}
          </div>
        ) : confirmando && seleccion != null ? (
          <div className="space-y-4">
            <div className="rounded-lg border p-4 bg-muted/30">{muestra(seleccion, true)}</div>
            <p className="text-sm font-medium text-destructive">
              ¿Confirmás "{NOMBRES[seleccion]}"? Esta elección es definitiva: no vas a poder cambiarla después.
            </p>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setConfirmando(false)} disabled={guardando}>Volver</Button>
              <Button onClick={() => void confirmar()} disabled={guardando} data-testid="button-confirmar-letra">
                {guardando ? "Guardando…" : "Confirmar para siempre"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {Array.from({ length: cantidad }, (_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => { setSeleccion(i); setConfirmando(true); }}
                className={`w-full text-left rounded-lg border p-3 transition-colors hover:border-primary hover:bg-muted/40 ${i === estado.estiloActual ? "border-primary/60" : ""}`}
                data-testid={`opcion-letra-${i}`}
              >
                <div className="text-xs text-muted-foreground mb-1">
                  {NOMBRES[i]}{i === estado.estiloActual ? " · tu letra actual (asignada)" : ""}
                </div>
                {muestra(i)}
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
