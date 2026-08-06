import { useEffect, useRef, useState } from "react";
import { useListPacientes, type Paciente } from "@workspace/api-client-react";
import { Search, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface Props {
  onSelect: (paciente: Paciente) => void;
  /** Se llama con el texto crudo en cada tecla (p. ej. para detectar un DNI tipeado) */
  onTexto?: (texto: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  /** Texto inicial del campo (opcional) */
  valorInicial?: string;
  "data-testid"?: string;
}

/**
 * Autocompletado de pacientes por nombre, apellido, DNI o HC.
 * Escribe "perez jua" o "28456789" y sugiere en vivo (insensible a acentos).
 */
export function PacienteBuscador({
  onSelect,
  onTexto,
  placeholder = "Buscar por nombre, apellido o DNI...",
  autoFocus,
  className,
  valorInicial = "",
  "data-testid": testId,
}: Props) {
  const [texto, setTexto] = useState(valorInicial);
  const [q, setQ] = useState("");
  const [abierto, setAbierto] = useState(false);
  const [resaltado, setResaltado] = useState(0);
  const contRef = useRef<HTMLDivElement>(null);

  // Debounce de 250 ms para no pegarle a la API en cada tecla
  useEffect(() => {
    const t = setTimeout(() => setQ(texto.trim()), 250);
    return () => clearTimeout(t);
  }, [texto]);

  const { data: res, isFetching } = useListPacientes(
    { q, limit: 8 },
    { query: { enabled: q.length >= 2 } },
  );
  const sugerencias = q.length >= 2 ? (res?.data ?? []) : [];

  useEffect(() => setResaltado(0), [q]);

  // Ojo: aunque el DNI tipeado coincida exacto con un paciente, NO se
  // autoselecciona — el usuario debe confirmar la coincidencia con un clic
  // o Enter, para evitar cargar un turno al paciente equivocado.

  // Cerrar al hacer clic afuera
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (contRef.current && !contRef.current.contains(e.target as Node)) setAbierto(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const elegir = (p: Paciente) => {
    setAbierto(false);
    setTexto(`${p.apellido}, ${p.nombre} — DNI ${p.dni ?? "s/d"}`);
    onSelect(p);
  };

  return (
    <div ref={contRef} className={cn("relative", className)}>
      {isFetching ? (
        <Loader2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground animate-spin pointer-events-none" />
      ) : (
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
      )}
      <Input
        className="pl-9"
        value={texto}
        autoFocus={autoFocus}
        placeholder={placeholder}
        data-testid={testId}
        onChange={(e) => {
          setTexto(e.target.value);
          setAbierto(true);
          onTexto?.(e.target.value);
        }}
        onFocus={() => setAbierto(true)}
        onKeyDown={(e) => {
          if (!abierto || sugerencias.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setResaltado((i) => Math.min(i + 1, sugerencias.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setResaltado((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const p = sugerencias[resaltado];
            if (p) elegir(p);
          } else if (e.key === "Escape") {
            setAbierto(false);
          }
        }}
      />
      {abierto && q.length >= 2 && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover text-popover-foreground shadow-md max-h-64 overflow-y-auto">
          {sugerencias.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              {isFetching ? "Buscando..." : "Sin resultados"}
            </div>
          ) : (
            sugerencias.map((p, i) => (
              <button
                key={p.id}
                type="button"
                className={cn(
                  "w-full text-left px-3 py-2 text-sm hover:bg-accent",
                  i === resaltado && "bg-accent",
                )}
                onMouseEnter={() => setResaltado(i)}
                onClick={() => elegir(p)}
                data-testid={`opcion-paciente-${p.id}`}
              >
                <span className="font-medium">
                  {p.apellido}, {p.nombre}
                </span>
                <span className="text-muted-foreground">
                  {" "}
                  — DNI {p.dni ?? "s/d"}
                  {p.cobertura ? ` · ${p.cobertura}` : ""}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
