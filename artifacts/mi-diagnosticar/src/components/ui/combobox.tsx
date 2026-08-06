import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";

export interface ComboboxOption {
  value: string;
  label: string;
  /** Texto extra invisible que también matchea la búsqueda (ej: códigos y prácticas). */
  keywords?: string;
}

function sinAcentos(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * Variante de selección múltiple: mismo buscador, pero cada opción se tilda
 * o destilda sin cerrar la lista. Las elegidas se muestran como chips.
 */
export function MultiCombobox({
  options,
  values,
  onChange,
  placeholder = "Elegir…",
  emptyText = "Sin resultados",
  testId,
  disabled,
}: {
  options: ComboboxOption[];
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  emptyText?: string;
  testId?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [texto, setTexto] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const contenedorRef = useRef<HTMLDivElement>(null);

  const filtradas = useMemo(() => {
    if (texto.trim() === "") return options;
    const palabras = sinAcentos(texto).split(/\s+/).filter(Boolean);
    return options.filter((o) => {
      const blanco = sinAcentos(o.label + " " + (o.keywords ?? ""));
      return palabras.every((p) => blanco.includes(p));
    });
  }, [options, texto]);

  const alternar = (v: string) => {
    onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v]);
  };

  const elegidas = values
    .map((v) => options.find((o) => o.value === v))
    .filter((o): o is ComboboxOption => !!o);

  return (
    <div className="flex flex-col gap-1">
      <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setTexto(""); }}>
        <PopoverAnchor asChild>
          <div className="relative" ref={contenedorRef}>
            <Input
              ref={inputRef}
              data-testid={testId}
              role="combobox"
              aria-expanded={open}
              disabled={disabled}
              value={texto}
              placeholder={values.length > 0 ? `${values.length} elegido${values.length > 1 ? "s" : ""} — agregar otro…` : placeholder}
              className="pr-8"
              onFocus={() => setOpen(true)}
              onClick={() => setOpen(true)}
              onChange={(e) => { setTexto(e.target.value); if (!open) setOpen(true); }}
              onKeyDown={(e) => {
                if (e.key === "Escape") { setOpen(false); setTexto(""); inputRef.current?.blur(); }
              }}
            />
            <ChevronsUpDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 opacity-50" />
          </div>
        </PopoverAnchor>
        <PopoverContent
          className="w-[--radix-popover-trigger-width] p-1"
          align="start"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => {
            if (contenedorRef.current?.contains(e.target as Node)) e.preventDefault();
          }}
          onFocusOutside={(e) => {
            if (contenedorRef.current?.contains(e.target as Node)) e.preventDefault();
          }}
        >
          <div className="max-h-64 overflow-y-auto">
            {filtradas.length === 0 && (
              <div className="px-2 py-3 text-sm text-muted-foreground text-center">{emptyText}</div>
            )}
            {filtradas.map((o) => (
              <button
                key={o.value}
                type="button"
                className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm text-left hover:bg-accent/60"
                onMouseDown={(e) => {
                  // No cerrar la lista: se pueden tildar varias seguidas.
                  e.preventDefault();
                  alternar(o.value);
                }}
                data-testid={testId ? `${testId}-opcion-${o.value}` : undefined}
              >
                <Check
                  className={cn("mr-2 h-4 w-4 shrink-0", values.includes(o.value) ? "opacity-100" : "opacity-0")}
                />
                <span className="truncate">{o.label}</span>
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      {elegidas.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {elegidas.map((o) => (
            <span
              key={o.value}
              className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-xs"
              data-testid={testId ? `${testId}-chip-${o.value}` : undefined}
            >
              <span className="max-w-[220px] truncate">{o.label}</span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => alternar(o.value)}
                aria-label={`Quitar ${o.label}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function Combobox({
  options,
  value,
  onChange,
  placeholder = "Elegir…",
  emptyText = "Sin resultados",
  testId,
  disabled,
  minChars = 0,
}: {
  options: ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  testId?: string;
  disabled?: boolean;
  /** Mínimo de caracteres escritos antes de mostrar opciones (para listas muy largas). */
  minChars?: number;
}) {
  const [open, setOpen] = useState(false);
  const [texto, setTexto] = useState<string | null>(null);
  const [resaltada, setResaltada] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const contenedorRef = useRef<HTMLDivElement>(null);
  const seleccionada = options.find((o) => o.value === value);

  const mostrado = texto !== null ? texto : (seleccionada?.label ?? "");

  const escrito = texto?.trim() ?? "";
  const faltanLetras = minChars > 0 && escrito.length < minChars;

  const filtradas = useMemo(() => {
    if (faltanLetras) return [];
    if (texto === null || texto.trim() === "") return options;
    // Cada palabra escrita tiene que aparecer en algún lado (label o keywords),
    // así "ecografia mamaria" matchea aunque las palabras no estén juntas.
    const palabras = sinAcentos(texto).split(/\s+/).filter(Boolean);
    return options.filter((o) => {
      const blanco = sinAcentos(o.label + " " + (o.keywords ?? ""));
      return palabras.every((p) => blanco.includes(p));
    });
  }, [options, texto]);

  useEffect(() => {
    setResaltada(0);
  }, [texto]);

  const elegir = (o: ComboboxOption) => {
    onChange(o.value);
    setTexto(null);
    setOpen(false);
    inputRef.current?.blur();
  };

  const cerrar = () => {
    setTexto(null);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={(v) => (v ? setOpen(true) : cerrar())}>
      <PopoverAnchor asChild>
        <div className="relative" ref={contenedorRef}>
          <Input
            ref={inputRef}
            data-testid={testId}
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            value={mostrado}
            placeholder={placeholder}
            className="pr-8"
            onFocus={(e) => {
              setOpen(true);
              // Selecciona todo el texto para que al escribir se pise
              // el valor por defecto sin tener que borrarlo a mano.
              e.currentTarget.select();
            }}
            onClick={(e) => {
              setOpen(true);
              e.currentTarget.select();
            }}
            onChange={(e) => {
              setTexto(e.target.value);
              if (!open) setOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setOpen(true);
                setResaltada((i) => Math.min(i + 1, filtradas.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setResaltada((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const o = filtradas[resaltada];
                if (o) elegir(o);
              } else if (e.key === "Escape") {
                cerrar();
                inputRef.current?.blur();
              }
            }}
          />
          <ChevronsUpDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 opacity-50" />
        </div>
      </PopoverAnchor>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-1"
        align="start"
        onOpenAutoFocus={(e) => e.preventDefault()}
        // Clicks sobre el propio campo no cuentan como "click afuera":
        // sin esto el popover se cierra y reabre al instante (efecto rebote).
        onPointerDownOutside={(e) => {
          if (contenedorRef.current?.contains(e.target as Node)) e.preventDefault();
        }}
        onFocusOutside={(e) => {
          if (contenedorRef.current?.contains(e.target as Node)) e.preventDefault();
        }}
      >
        <div className="max-h-64 overflow-y-auto">
          {filtradas.length === 0 && (
            <div className="px-2 py-3 text-sm text-muted-foreground text-center">
              {faltanLetras ? `Escribí al menos ${minChars} letras para buscar` : emptyText}
            </div>
          )}
          {filtradas.map((o, i) => (
            <button
              key={o.value}
              type="button"
              className={cn(
                "flex w-full items-center rounded-sm px-2 py-1.5 text-sm text-left",
                i === resaltada ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
              )}
              onMouseEnter={() => setResaltada(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                elegir(o);
              }}
            >
              <Check
                className={cn("mr-2 h-4 w-4 shrink-0", value === o.value ? "opacity-100" : "opacity-0")}
              />
              <span className="truncate">{o.label}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
