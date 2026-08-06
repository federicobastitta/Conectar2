import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import type { KlinicosPractica } from "@workspace/api-client-react";

// ── Selector de estudios del turno ─────────────────────────────────────────
// Un turno puede llevar varios estudios (ej: eco abdomen + eco tiroides).
// Este selector muestra el catálogo Klinicos con tildes múltiples y lo usan
// la ficha de recepción (dialog) y el panel de recepción activo para
// corregir el conjunto de un turno ya cargado.
export function SelectorEstudiosTurno({
  practicas,
  seleccionadas,
  onChange,
  disabled,
}: {
  practicas: KlinicosPractica[];
  seleccionadas: number[];
  onChange: (ids: number[]) => void;
  disabled?: boolean;
}) {
  const [filtro, setFiltro] = useState("");

  const visibles = useMemo(() => {
    const q = filtro.trim().toLowerCase();
    if (!q) return practicas;
    return practicas.filter(
      (p) =>
        p.nombre.toLowerCase().includes(q) ||
        (p.codigos ?? []).some((c) => c.toLowerCase().includes(q)),
    );
  }, [practicas, filtro]);

  const elegidas = useMemo(
    () => practicas.filter((p) => seleccionadas.includes(p.id)),
    [practicas, seleccionadas],
  );

  const toggle = (id: number) => {
    if (disabled) return;
    onChange(
      seleccionadas.includes(id)
        ? seleccionadas.filter((x) => x !== id)
        : [...seleccionadas, id],
    );
  };

  return (
    <div className="space-y-1.5" data-testid="selector-estudios-turno">
      <div className="relative">
        <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="h-8 pl-8 text-sm"
          placeholder="Buscar estudio por nombre o código…"
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
          disabled={disabled}
          data-testid="buscar-estudio"
        />
      </div>
      <div className="max-h-44 overflow-y-auto rounded-md border divide-y">
        {visibles.length === 0 ? (
          <p className="text-xs text-muted-foreground p-2.5">Sin resultados en el catálogo.</p>
        ) : (
          visibles.map((p) => (
            <label
              key={p.id}
              className={`flex items-start gap-2 px-2.5 py-1.5 text-sm select-none ${
                disabled ? "opacity-60" : "cursor-pointer hover:bg-muted/50"
              }`}
              data-testid={`estudio-opcion-${p.id}`}
            >
              <input
                type="checkbox"
                className="h-4 w-4 mt-0.5 accent-primary shrink-0"
                checked={seleccionadas.includes(p.id)}
                onChange={() => toggle(p.id)}
                disabled={disabled}
              />
              <span className="min-w-0">
                <span className="block truncate">{p.nombre}</span>
                {(p.codigos ?? []).length > 0 && (
                  <span className="block text-xs text-muted-foreground truncate">
                    {(p.codigos ?? []).join(", ")}
                  </span>
                )}
              </span>
            </label>
          ))
        )}
      </div>
      <p className="text-xs text-muted-foreground" data-testid="estudios-seleccionados-resumen">
        {elegidas.length === 0
          ? "Sin estudios seleccionados (consulta sin práctica)."
          : `${elegidas.length} estudio${elegidas.length > 1 ? "s" : ""}: ${elegidas
              .map((p) => p.nombre)
              .join(" + ")}`}
      </p>
    </div>
  );
}
