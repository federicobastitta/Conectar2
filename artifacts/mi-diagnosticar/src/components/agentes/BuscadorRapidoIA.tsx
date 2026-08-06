/**
 * BuscadorRapidoIA — buscador rápido con el muñeco bailarín.
 *
 * Detección inteligente del lado del servidor:
 *   - "eco" (especialidad)      → 3 primeros turnos libres en días distintos
 *   - "villagran" (profesional) → 3 turnos de ese profesional
 *   - "30123456" (DNI)          → paciente con próximos turnos y estudios
 *   - cualquier otra cosa       → se deriva la pregunta al asistente IA
 */

import { useState } from "react";
import { Link } from "wouter";
import { busquedaRapida, type BusquedaRapidaResult } from "@workspace/api-client-react";
import { MuniecoBailarin, MuniecoBailarinMini } from "@/components/ui/munieco-bailarin";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sparkles, Loader2, CalendarDays, FileText, UserCircle } from "lucide-react";

export const EVENTO_PREGUNTAR_AGENTE = "conectar:preguntar-agente";

export function preguntarAgente(pregunta?: string) {
  window.dispatchEvent(
    new CustomEvent(EVENTO_PREGUNTAR_AGENTE, { detail: { pregunta } })
  );
}

function fechaLegible(f: string): string {
  const d = new Date(`${f}T00:00:00.000Z`);
  return d.toLocaleDateString("es-AR", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

type SlotBuscador = NonNullable<BusquedaRapidaResult["slots"]>[number];

export function BuscadorRapidoIA({
  mensaje,
  onSelectSlot,
  mostrarMunieco = true,
}: {
  mensaje: string;
  onSelectSlot?: (slot: SlotBuscador) => void;
  mostrarMunieco?: boolean;
}) {
  const [pregunta, setPregunta] = useState("");
  const [buscando, setBuscando] = useState(false);
  const [resultado, setResultado] = useState<BusquedaRapidaResult | null>(null);

  const enviar = async () => {
    const q = pregunta.trim();
    if (!q) {
      preguntarAgente();
      return;
    }
    setBuscando(true);
    setResultado(null);
    try {
      const r = await busquedaRapida({ q });
      if (r.tipo === "ninguno" && !r.titulo) {
        // No matcheó nada concreto → que responda el asistente IA
        preguntarAgente(q);
        setPregunta("");
      } else {
        setResultado(r);
      }
    } catch {
      // Ante cualquier error, derivar al asistente IA
      preguntarAgente(q);
      setPregunta("");
    } finally {
      setBuscando(false);
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-3" data-testid="buscador-rapido-ia">
      <form
        className="flex w-full max-w-md items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void enviar();
        }}
      >
        <Input
          data-testid="input-buscador-ia"
          value={pregunta}
          onChange={(e) => setPregunta(e.target.value)}
          placeholder="Preguntame turnos, informes o lo que quieras…"
          className="flex-1 h-11 border-2 border-primary/40 focus-visible:border-primary shadow-sm rounded-xl"
        />
        <Button
          type="submit"
          size="icon"
          variant="outline"
          data-testid="boton-buscador-ia"
          title="Buscar"
          disabled={buscando}
          className="h-11 w-11 border-2 border-primary/40 rounded-xl hover:border-primary"
        >
          {buscando ? <Loader2 className="w-4 h-4 animate-spin" /> : <MuniecoBailarinMini size={40} />}
        </Button>
      </form>

      {!resultado && mostrarMunieco && <MuniecoBailarin mensaje={mensaje} />}

      {resultado && (
        <div className="w-full max-w-md space-y-2 text-sm" data-testid="resultado-buscador-ia">
          {resultado.titulo && (
            <p className="font-medium text-center">{resultado.titulo}</p>
          )}

          {resultado.tipo === "slots" && resultado.slots && resultado.slots.length > 0 && (
            <div className="space-y-1.5">
              {resultado.slots.map((s) => (
                <button
                  key={`${s.turneraId}-${s.fecha}-${s.horaInicio}`}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors hover:bg-accent hover:border-primary/50 cursor-pointer"
                  data-testid={`slot-buscador-${s.fecha}`}
                  onClick={() => {
                    // Los resultados quedan visibles: si el usuario se
                    // equivocó puede elegir otro turno sin volver a buscar.
                    onSelectSlot?.(s);
                  }}
                >
                  <CalendarDays className="w-4 h-4 text-primary shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium capitalize">
                      {fechaLegible(s.fecha)} · {s.horaInicio} hs
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {[s.profesional, s.especialidad, s.sede].filter(Boolean).join(" · ") || s.turneraNombre}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs font-medium text-primary">Asignar →</span>
                </button>
              ))}
            </div>
          )}

          {resultado.tipo === "paciente" && resultado.paciente && (
            <div className="space-y-1.5">
              <Link
                href={`/pacientes/${resultado.paciente.id}`}
                className="flex items-center gap-2 rounded-lg border px-3 py-2 hover:bg-accent"
                data-testid="paciente-buscador"
              >
                <UserCircle className="w-4 h-4 text-primary shrink-0" />
                <span className="font-medium">Ver ficha del paciente</span>
              </Link>
              {resultado.paciente.turnos.map((t) => (
                <div key={t.id} className="flex items-center gap-2 rounded-lg border px-3 py-2">
                  <CalendarDays className="w-4 h-4 text-primary shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium capitalize">
                      {fechaLegible(t.fecha)} · {t.horaInicio} hs
                    </p>
                    <p className="text-xs text-muted-foreground truncate">{t.turneraNombre ?? "Turno"}</p>
                  </div>
                  <Badge variant="outline" className="shrink-0 text-xs">{t.estado}</Badge>
                </div>
              ))}
              {resultado.paciente.turnos.length === 0 && (
                <p className="text-xs text-muted-foreground text-center">Sin turnos próximos</p>
              )}
              {resultado.paciente.estudios.map((e, i) => (
                <div key={i} className="flex items-center gap-2 rounded-lg border px-3 py-2">
                  <FileText className="w-4 h-4 text-primary shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{e.descripcion}</p>
                    <p className="text-xs text-muted-foreground">
                      {e.origen}{e.fecha ? ` · ${fechaLegible(e.fecha)}` : ""}
                    </p>
                  </div>
                  <Badge variant="outline" className="shrink-0 text-xs">{e.estado}</Badge>
                </div>
              ))}
            </div>
          )}

          {resultado.tipo === "ninguno" && (
            <div className="text-center space-y-2">
              <Button
                variant="outline"
                size="sm"
                data-testid="boton-preguntar-ia"
                onClick={() => {
                  preguntarAgente(resultado.consulta);
                  setResultado(null);
                  setPregunta("");
                }}
              >
                <Sparkles className="w-3.5 h-3.5 mr-1.5" /> Preguntarle al asistente IA
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
