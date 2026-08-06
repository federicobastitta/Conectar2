import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import {
  useCreateTurno,
  useCreatePaciente,
  useUpdatePaciente,
  useListPacientes,
  useListObrasSociales,
  type Turnera,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { PacienteBuscador } from "@/components/pacientes/paciente-buscador";

export interface SlotLibre {
  turneraId: number;
  horaInicio: string;
  horaFin: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fecha: string;
  agendaLabel: string;
  turneras: Turnera[];
  slotsLibres: SlotLibre[];
  slotInicial?: SlotLibre | null;
  onCreated: () => void;
  onCargarPacienteNuevo: (dni: string) => void;
}

export function NuevoTurnoDialog({
  open,
  onOpenChange,
  fecha,
  agendaLabel,
  turneras,
  slotsLibres,
  slotInicial,
  onCreated,
  onCargarPacienteNuevo,
}: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [slotKey, setSlotKey] = useState<string>("");
  const [dni, setDni] = useState("");
  const [nombre, setNombre] = useState("");
  const [apellido, setApellido] = useState("");
  const [cobertura, setCobertura] = useState("");
  const [nroAfiliado, setNroAfiliado] = useState("");
  const [celular, setCelular] = useState("");
  const [sexo, setSexo] = useState<"" | "M" | "F" | "otro">("");
  const [fechaNacimiento, setFechaNacimiento] = useState("");
  const [motivo, setMotivo] = useState("");
  // Región anatómica del estudio: obligatoria si la turnera es de práctica
  // (va al PACS como body_part, pedido jul 2026).
  const [regionAnatomica, setRegionAnatomica] = useState("");
  // Si ya creamos el paciente en un intento anterior (y falló el turno),
  // lo reutilizamos en el reintento para no duplicar pacientes.
  const [pacienteCreado, setPacienteCreado] = useState<{
    dni: string;
    id: number;
    nombre: string;
    apellido: string;
  } | null>(null);

  const keyDe = (s: SlotLibre) => `${s.turneraId}|${s.horaInicio}`;

  useEffect(() => {
    if (open) {
      setSlotKey(slotInicial ? keyDe(slotInicial) : "");
      setDni("");
      setNombre("");
      setApellido("");
      setCobertura("");
      setNroAfiliado("");
      setCelular("");
      setSexo("");
      setFechaNacimiento("");
      setMotivo("");
      setRegionAnatomica("");
      setPacienteCreado(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, slotInicial]);

  const { data: pacientesRes, isFetching: buscandoPaciente } = useListPacientes(
    { dni, limit: 1 },
    { query: { enabled: open && dni.trim().length >= 7 } },
  );
  const pacienteEncontrado =
    dni.trim().length >= 7 ? pacientesRes?.data?.[0] ?? null : null;

  useEffect(() => {
    if (pacienteEncontrado) {
      setNombre(pacienteEncontrado.nombre);
      setApellido(pacienteEncontrado.apellido);
      setCobertura(pacienteEncontrado.cobertura ?? "");
      setNroAfiliado(pacienteEncontrado.nroAfiliado ?? "");
      setCelular(pacienteEncontrado.telefono ?? "");
    } else {
      setNombre("");
      setApellido("");
      setCobertura("");
      setNroAfiliado("");
      setCelular("");
      setSexo("");
      setFechaNacimiento("");
    }
  }, [pacienteEncontrado]);

  const { data: obrasSociales } = useListObrasSociales();

  const slotSel = useMemo(
    () => slotsLibres.find((s) => keyDe(s) === slotKey) ?? null,
    [slotsLibres, slotKey],
  );

  // La turnera del horario elegido define si el turno es de práctica.
  const turneraSel = useMemo(
    () => (slotSel ? turneras.find((t) => t.id === slotSel.turneraId) ?? null : null),
    [turneras, slotSel],
  );
  const esPractica = turneraSel?.tipo === "practica";

  const nombreTurnera = (id: number) => {
    const t = turneras.find((x) => x.id === id);
    return t?.sede?.nombre ? ` [${t.sede.nombre}]` : "";
  };

  const createMutation = useCreateTurno();
  const createPaciente = useCreatePaciente();
  const updatePaciente = useUpdatePaciente();

  const guardando =
    createMutation.isPending || createPaciente.isPending || updatePaciente.isPending;

  // Requisitos: paciente existente → confirmar celular. Paciente nuevo →
  // datos mínimos que exige el alta en Klinicos: nombre, apellido, DNI,
  // celular (para notificaciones) y obra social.
  const puedeCrear =
    !!slotSel &&
    dni.trim().length >= 7 &&
    celular.trim().length > 0 &&
    (!esPractica || regionAnatomica.trim().length > 0) &&
    (!!pacienteEncontrado ||
      (nombre.trim().length > 0 && apellido.trim().length > 0 && cobertura.trim().length > 0));

  const errorTurno = (e: unknown) => {
    const msg =
      e && typeof e === "object" && "error" in e
        ? String((e as { error: unknown }).error)
        : "No se pudo cargar el turno";
    toast({ title: "Error", description: msg, variant: "destructive" });
  };

  const crearTurnoCon = (pacienteId: number, pacienteLabel: string) => {
    if (!slotSel) return;
    createMutation.mutate(
      {
        data: {
          turneraId: slotSel.turneraId,
          fecha,
          horaInicio: slotSel.horaInicio,
          pacienteId,
          pacienteDni: dni.trim(),
          ...(cobertura && { cobertura }),
          ...(nroAfiliado && { nroAfiliado }),
          ...(motivo.trim() && { motivoConsulta: motivo.trim() }),
          ...(regionAnatomica.trim() && { regionAnatomica: regionAnatomica.trim() }),
          modalidad: "presencial" as const,
        },
      },
      {
        onSuccess: () => {
          toast({
            title: "Turno cargado",
            description: `${pacienteLabel} — ${slotSel.horaInicio} hs`,
          });
          void queryClient.invalidateQueries();
          onOpenChange(false);
          onCreated();
        },
        onError: errorTurno,
      },
    );
  };

  const crear = () => {
    if (!slotSel || !puedeCrear) return;

    if (pacienteEncontrado) {
      const label = `${pacienteEncontrado.apellido}, ${pacienteEncontrado.nombre}`;
      const celularNuevo = celular.trim();
      if (celularNuevo && celularNuevo !== (pacienteEncontrado.telefono ?? "")) {
        // El operador confirmó/corrigió el celular: lo actualizamos en la ficha.
        updatePaciente.mutate(
          { id: pacienteEncontrado.id, data: { telefono: celularNuevo } },
          {
            onSuccess: () => crearTurnoCon(pacienteEncontrado.id, label),
            onError: errorTurno,
          },
        );
      } else {
        crearTurnoCon(pacienteEncontrado.id, label);
      }
      return;
    }

    // Si el paciente ya fue creado en un intento anterior (falló el turno),
    // lo reutilizamos en lugar de crear un duplicado.
    if (pacienteCreado && pacienteCreado.dni === dni.trim()) {
      crearTurnoCon(pacienteCreado.id, `${pacienteCreado.apellido}, ${pacienteCreado.nombre}`);
      return;
    }

    // Paciente nuevo: lo creamos con los datos que exige Klinicos y luego el turno.
    createPaciente.mutate(
      {
        data: {
          nombre: nombre.trim(),
          apellido: apellido.trim(),
          dni: dni.trim(),
          telefono: celular.trim(),
          cobertura,
          ...(nroAfiliado && { nroAfiliado }),
          ...(sexo && { sexo }),
          ...(fechaNacimiento && { fechaNacimiento }),
          forzarCreacion: true,
        },
      },
      {
        onSuccess: (p) => {
          setPacienteCreado({ dni: dni.trim(), id: p.id, nombre: p.nombre, apellido: p.apellido });
          crearTurnoCon(p.id, `${p.apellido}, ${p.nombre}`);
        },
        onError: (e: unknown) => {
          const msg =
            e && typeof e === "object" && "error" in e
              ? String((e as { error: unknown }).error)
              : "No se pudo crear el paciente";
          toast({ title: "Error", description: msg, variant: "destructive" });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Cargar Turno</DialogTitle>
          <DialogDescription>
            {agendaLabel} — {format(new Date(`${fecha}T00:00:00`), "d 'de' MMMM 'de' yyyy", { locale: es })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Horario *</Label>
            <Select value={slotKey} onValueChange={setSlotKey}>
              <SelectTrigger data-testid="select-slot-nuevo-turno">
                <SelectValue placeholder={slotsLibres.length ? "Elegí un horario libre" : "Sin horarios libres este día"} />
              </SelectTrigger>
              <SelectContent className="max-h-72 overflow-y-auto">
                {slotsLibres.map((s) => (
                  <SelectItem key={keyDe(s)} value={keyDe(s)}>
                    {s.horaInicio} - {s.horaFin}{nombreTurnera(s.turneraId)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Paciente (DNI o nombre) *</Label>
            <PacienteBuscador
              placeholder="Escribí el DNI o el nombre del paciente"
              data-testid="input-dni-nuevo-turno"
              onSelect={(p) => setDni(p.dni ?? "")}
              onTexto={(t) => {
                const digitos = t.replace(/\D/g, "");
                const esNumerico = /^[\d.\s-]+$/.test(t.trim());
                setDni(esNumerico && digitos.length >= 7 ? digitos : "");
              }}
            />
            {dni.trim().length >= 7 && (
              <div className="text-xs">
                {buscandoPaciente ? (
                  <span className="text-muted-foreground">Buscando...</span>
                ) : pacienteEncontrado ? (
                  <span className="text-teal-700 dark:text-teal-300 font-medium">
                    Paciente encontrado: {pacienteEncontrado.apellido}, {pacienteEncontrado.nombre}
                    {pacienteEncontrado.cobertura ? ` · ${pacienteEncontrado.cobertura}` : ""}
                  </span>
                ) : (
                  <span className="text-amber-700 dark:text-amber-400">
                    No está registrado — completá nombre y apellido y se crea junto con el turno,{" "}
                    <button
                      type="button"
                      className="underline font-medium"
                      onClick={() => onCargarPacienteNuevo(dni.trim())}
                    >
                      o cargalo con la ficha completa
                    </button>
                    .
                  </span>
                )}
              </div>
            )}
          </div>

          {!pacienteEncontrado && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Nombre *</Label>
                <Input
                  value={nombre}
                  onChange={(e) => setNombre(e.target.value)}
                  data-testid="input-nombre-nuevo-turno"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Apellido *</Label>
                <Input
                  value={apellido}
                  onChange={(e) => setApellido(e.target.value)}
                  data-testid="input-apellido-nuevo-turno"
                />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>
              {pacienteEncontrado ? "Celular (confirmar) *" : "Celular *"}
            </Label>
            <Input
              value={celular}
              onChange={(e) => setCelular(e.target.value)}
              placeholder="Para notificaciones (WhatsApp)"
              data-testid="input-celular-nuevo-turno"
            />
            {pacienteEncontrado && (
              <p className="text-xs text-muted-foreground">
                Confirmá con el paciente que este número siga vigente. Si lo corregís, se
                actualiza en su ficha.
              </p>
            )}
          </div>

          {!pacienteEncontrado && dni.trim().length >= 7 && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Sexo</Label>
                <Select value={sexo} onValueChange={(v) => setSexo(v as "M" | "F" | "otro")}>
                  <SelectTrigger data-testid="select-sexo-nuevo-turno">
                    <SelectValue placeholder="Seleccionar" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="F">Femenino</SelectItem>
                    <SelectItem value="M">Masculino</SelectItem>
                    <SelectItem value="otro">Otro</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Fecha de nacimiento</Label>
                <Input
                  type="date"
                  value={fechaNacimiento}
                  onChange={(e) => setFechaNacimiento(e.target.value)}
                  data-testid="input-fecha-nacimiento-nuevo-turno"
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{pacienteEncontrado ? "Obra Social" : "Obra Social *"}</Label>
              <Select value={cobertura} onValueChange={setCobertura}>
                <SelectTrigger>
                  <SelectValue placeholder="Seleccionar" />
                </SelectTrigger>
                <SelectContent className="max-h-72 overflow-y-auto">
                  {(obrasSociales ?? [])
                    .filter((o) => o.activa)
                    .map((o) => (
                      <SelectItem key={o.id} value={o.nombre}>{o.nombre}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Nro afiliado</Label>
              <Input value={nroAfiliado} onChange={(e) => setNroAfiliado(e.target.value)} />
            </div>
          </div>

          {esPractica && (
            <div className="space-y-1.5">
              <Label>Región anatómica / parte del cuerpo *</Label>
              <Input
                value={regionAnatomica}
                onChange={(e) => setRegionAnatomica(e.target.value)}
                placeholder='Ej: "Rodilla derecha", "Abdomen", "Columna lumbar", "Tórax"'
                data-testid="input-region-anatomica-nuevo-turno"
              />
              <p className="text-xs text-muted-foreground">
                Obligatoria para prácticas: se envía al PACS y evita errores al preparar al paciente.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Motivo / observación</Label>
            <Input
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Opcional"
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={crear}
            disabled={!puedeCrear || guardando}
            data-testid="boton-confirmar-nuevo-turno"
          >
            {guardando ? "Guardando..." : "Cargar Turno"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
