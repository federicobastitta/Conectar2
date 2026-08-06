import { useState } from "react";
import { Tv, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useListSedes, useListTurneras, useListSalasLlamado, useCanjearCodigoTv } from "@workspace/api-client-react";

function abrirPantalla(sedeId?: number) {
  const base = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/pantalla-sala`;
  const url = sedeId ? `${base}?sedeId=${sedeId}` : base;
  window.open(url, "_blank", "noopener");
}

function abrirPantallaTurnera(turneraId: number) {
  const base = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/pantalla-sala`;
  window.open(`${base}?turneraId=${turneraId}`, "_blank", "noopener");
}

function abrirPantallaSala(salaId: number) {
  const base = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/pantalla-sala`;
  window.open(`${base}?salaId=${salaId}`, "_blank", "noopener");
}

// Diálogo para vincular una SmartTV por código corto: la TV en /tv muestra un
// código de 6 caracteres; acá se ingresa y se elige qué sala verá esa TV.
function VincularTvDialog({
  open,
  onOpenChange,
  sedes,
  guardias,
  salas,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sedes: { id: number; nombre: string }[];
  guardias: { id: number; etiqueta: string }[];
  salas: { id: number; nombre: string }[];
}) {
  const { toast } = useToast();
  const [codigo, setCodigo] = useState("");
  const [destino, setDestino] = useState<string>("todas");
  const { mutate: canjear, isPending } = useCanjearCodigoTv({
    mutation: {
      onSuccess: () => {
        toast({
          title: "Pantalla vinculada",
          description: "La TV va a pasar sola a la sala elegida en unos segundos.",
        });
        onOpenChange(false);
        setCodigo("");
        setDestino("todas");
      },
      onError: (error) => {
        const mensaje =
          (error as { error?: string } | null)?.error ??
          "No se pudo vincular: verificá el código que muestra la TV";
        toast({ title: "Error al vincular", description: mensaje, variant: "destructive" });
      },
    },
  });

  const vincular = () => {
    const limpio = codigo.trim().toUpperCase();
    if (limpio.length !== 6) {
      toast({
        title: "Código incompleto",
        description: "El código que muestra la TV tiene 6 caracteres.",
        variant: "destructive",
      });
      return;
    }
    const data =
      destino === "todas"
        ? {}
        : destino.startsWith("sala-")
          ? { salaId: Number(destino.slice(5)) }
          : destino.startsWith("sede-")
            ? { sedeId: Number(destino.slice(5)) }
            : { turneraId: Number(destino.slice(8)) };
    canjear({ codigo: limpio, data });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Vincular pantalla TV</DialogTitle>
          <DialogDescription>
            En la TV abrí <span className="font-mono">/tv</span>: va a mostrar un código de 6
            caracteres. Ingresalo acá y elegí qué sala tiene que mostrar.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="codigo-tv">Código de la TV</Label>
            <Input
              id="codigo-tv"
              data-testid="input-codigo-tv"
              value={codigo}
              onChange={(e) => setCodigo(e.target.value.toUpperCase())}
              placeholder="Ej: K7PQ2M"
              maxLength={6}
              autoComplete="off"
              className="font-mono text-lg tracking-[0.3em] uppercase"
            />
          </div>
          <div className="space-y-2">
            <Label>Sala que va a mostrar</Label>
            <Select value={destino} onValueChange={setDestino}>
              <SelectTrigger data-testid="select-destino-tv">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="todas">Todas las sedes</SelectItem>
                {salas.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Por sala de espera</SelectLabel>
                    {salas.map((s) => (
                      <SelectItem key={`sala-${s.id}`} value={`sala-${s.id}`}>
                        {s.nombre}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
                {/* Sedes solo como fallback cuando no hay salas creadas */}
                {salas.length === 0 && sedes.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Por sede</SelectLabel>
                    {sedes.map((s) => (
                      <SelectItem key={s.id} value={`sede-${s.id}`}>
                        {s.nombre}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
                {guardias.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Por guardia</SelectLabel>
                    {guardias.map((g) => (
                      <SelectItem key={g.id} value={`turnera-${g.id}`}>
                        {g.etiqueta}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={vincular} disabled={isPending} data-testid="button-vincular-tv">
            {isPending ? "Vinculando…" : "Vincular"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Botón "Sala de espera" con selector de sede: cada sede tiene su propia
// pantalla y solo anuncia los llamados de sus consultorios.
export function SalaEsperaBoton({ modo = "completo" }: { modo?: "completo" | "icono" }) {
  const { data: sedes } = useListSedes();
  const lista = (sedes ?? []).filter((s) => s.activa !== false);
  const { data: salasData } = useListSalasLlamado();
  const salas = (salasData ?? []).filter((s) => s.activa !== false);
  const [vincularAbierto, setVincularAbierto] = useState(false);

  // Guardias activas: cada una puede tener su propia pantalla de sala que
  // muestra SOLO los pacientes en espera de esa guardia (ej: Guardia Clínica
  // de Berazategui). Se deduplica por nombre+sede por si hay agendas repetidas.
  const { data: turneras } = useListTurneras({ activa: true });
  const guardias = (() => {
    const vistas = new Map<string, { id: number; etiqueta: string }>();
    for (const t of turneras ?? []) {
      if (!t.esGuardia || t.activa === false) continue;
      const clave = `${t.nombre.trim().toLowerCase()}|${t.sedeId ?? ""}`;
      if (vistas.has(clave)) continue;
      const sede = lista.find((s) => s.id === t.sedeId);
      vistas.set(clave, {
        id: t.id,
        etiqueta: sede ? `${t.nombre} — ${sede.nombre}` : t.nombre,
      });
    }
    return [...vistas.values()].sort((a, b) => a.etiqueta.localeCompare(b.etiqueta));
  })();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {modo === "icono" ? (
          <Button
            variant="ghost"
            size="icon"
            className="relative h-9 w-9 rounded-lg bg-fuchsia-600 text-white hover:bg-fuchsia-500 hover:text-white ring-1 ring-fuchsia-400/60"
            title="Pantalla de sala de espera"
            data-testid="boton-header-sala-espera"
          >
            <Tv className="w-4 h-4" />
          </Button>
        ) : (
          <Button variant="outline" className="shrink-0" data-testid="button-sala-espera">
            <Tv className="w-4 h-4 mr-2" />
            Sala de espera
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {salas.length > 0 ? (
          <>
            <DropdownMenuLabel>Pantalla por sala</DropdownMenuLabel>
            {salas.map((s) => (
              <DropdownMenuItem
                key={`sala-${s.id}`}
                onClick={() => abrirPantallaSala(s.id)}
                data-testid={`sala-espera-sala-${s.id}`}
              >
                {s.nombre}
              </DropdownMenuItem>
            ))}
          </>
        ) : (
          <>
            <DropdownMenuLabel>Pantalla por sede</DropdownMenuLabel>
            {lista.map((s) => (
              <DropdownMenuItem
                key={s.id}
                onClick={() => abrirPantalla(s.id)}
                data-testid={`sala-espera-sede-${s.id}`}
              >
                {s.nombre}
              </DropdownMenuItem>
            ))}
          </>
        )}
        {guardias.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Pantalla por guardia</DropdownMenuLabel>
            {guardias.map((g) => (
              <DropdownMenuItem
                key={g.id}
                onClick={() => abrirPantallaTurnera(g.id)}
                data-testid={`sala-espera-guardia-${g.id}`}
              >
                {g.etiqueta}
              </DropdownMenuItem>
            ))}
          </>
        )}
        {lista.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onClick={() => abrirPantalla()} data-testid="sala-espera-todas">
          Todas las sedes
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => setVincularAbierto(true)}
          data-testid="sala-espera-vincular-tv"
        >
          <Link2 className="w-4 h-4 mr-2" />
          Vincular pantalla TV…
        </DropdownMenuItem>
      </DropdownMenuContent>
      <VincularTvDialog
        open={vincularAbierto}
        onOpenChange={setVincularAbierto}
        sedes={lista}
        guardias={guardias}
        salas={salas}
      />
    </DropdownMenu>
  );
}
