import { useState } from "react";
import {
  useGetDisponibilidadTurnera,
  useCreateTurno,
  useCreatePaciente,
  useListObrasSociales,
  useListKlinicosPracticas,
  getListTurnosQueryKey,
  TurnoInputModalidad,
  PacienteInputSexo,
  type Turnera,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Combobox } from "@/components/ui/combobox";
import { PacienteBuscador } from "@/components/pacientes/paciente-buscador";
import { TokenTurnoDialog } from "@/components/turnos/token-turno-dialog";
import { useToast } from "@/hooks/use-toast";
import { Clock, UserCheck, Siren, Hash } from "lucide-react";
import { FaWhatsapp } from "react-icons/fa";
import { ahoraArgentina } from "@/lib/agenda";

// Formulario compacto para cargar un turno usando la agenda y la fecha ya
// elegidas en la pantalla (sin volver a pedir especialidad ni profesional).
// Pide todos los datos que Klinicos exige para la consulta: teléfono, sexo,
// obra social + nro de afiliado y motivo de consulta.
export function CargarTurnoInline({
  turneras,
  fecha,
  onCreado,
}: {
  turneras: Turnera[];
  fecha: string;
  onCreado?: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createMutation = useCreateTurno();
  const crearPacienteMutation = useCreatePaciente();
  const { data: obrasSociales } = useListObrasSociales();

  const [pacienteId, setPacienteId] = useState<number | undefined>();
  const [dni, setDni] = useState("");
  const [nombre, setNombre] = useState("");
  const [apellido, setApellido] = useState("");
  const [sexo, setSexo] = useState("");
  const [telefono, setTelefono] = useState("");
  const [email, setEmail] = useState("");
  const [cobertura, setCobertura] = useState("");
  const [nroAfiliado, setNroAfiliado] = useState("");
  const [hora, setHora] = useState("");
  const [modalidad, setModalidad] = useState<TurnoInputModalidad>(TurnoInputModalidad.presencial);
  const [motivo, setMotivo] = useState("");
  // Práctica de prestación: "consulta" (420101, por defecto) o una práctica
  // del catálogo Klinicos (eco, RX, etc.) que muestra todos sus códigos.
  const [practicaSel, setPracticaSel] = useState("consulta");
  // Popup "Cargue token": se abre al cargar un turno IOMA del día de hoy.
  // Para turnos programados a futuro no se pide (el token vale solo el día
  // de atención); queda pendiente en la ficha de recepción.
  const [tokenDialog, setTokenDialog] = useState<{ turnoId: number; paciente: string } | null>(null);
  const { data: practicas } = useListKlinicosPracticas();
  const practicasActivas = (practicas ?? []).filter((p) => p.activo !== false);
  const practicaElegida =
    practicaSel !== "consulta"
      ? practicasActivas.find((p) => String(p.id) === practicaSel) ?? null
      : null;
  // Descripción de cada código: nombres de las prácticas del catálogo que lo
  // incluyen (un mismo código puede pertenecer a más de una práctica).
  const descripcionPorCodigo = new Map<string, string>();
  for (const p of practicasActivas) {
    for (const c of p.codigos ?? []) {
      const previa = descripcionPorCodigo.get(c);
      if (previa && !previa.includes(p.nombre)) descripcionPorCodigo.set(c, `${previa} / ${p.nombre}`);
      else if (!previa) descripcionPorCodigo.set(c, p.nombre);
    }
  }
  descripcionPorCodigo.set("420101", "CONSULTA MÉDICA (todas las especialidades)");
  // OJO: no deduplicar — hay prácticas (ej. MAMOGRAFIA) donde el mismo
  // código va dos veces (una por lado) y hay que cargarlo repetido.
  const codigosAMostrar = practicaElegida ? (practicaElegida.codigos ?? []) : ["420101"];

  // La fecha define qué turnera del grupo corresponde (día de semana; si hay
  // más de una ese día, la de horario más temprano).
  const dia = fecha ? new Date(`${fecha}T00:00:00`).getDay() : null;
  const porDia =
    dia === null
      ? null
      : turneras
          .filter((t) => (t.diasAtencion ?? []).includes(dia))
          .sort((a, b) => (a.horaInicio ?? "").localeCompare(b.horaInicio ?? ""))[0] ?? null;
  // Guardia: es por orden de llegada, se puede cargar cualquier día aunque
  // los días configurados de la turnera no incluyan la fecha elegida.
  const turnera =
    porDia ??
    (fecha
      ? turneras
          .filter((t) => t.esGuardia)
          .sort((a, b) => (a.horaInicio ?? "").localeCompare(b.horaInicio ?? ""))[0] ?? null
      : null);

  const esGuardia = !!turnera?.esGuardia;

  const { data: slots, isLoading: loadingSlots } = useGetDisponibilidadTurnera(
    turnera?.id ?? 0,
    fecha,
    { query: { enabled: !!turnera && !!fecha && !esGuardia } },
  );

  const opcionesOS = [
    ...(obrasSociales ?? [])
      .filter((os) => os.activa)
      .map((os) => ({
        value: os.nombre,
        label: os.codigo ? `${os.codigo} · ${os.nombre.toUpperCase()}` : os.nombre.toUpperCase(),
      })),
    ...(cobertura && !(obrasSociales ?? []).some((os) => os.nombre === cobertura)
      ? [{ value: cobertura, label: cobertura.toUpperCase() }]
      : []),
  ];

  const limpiar = () => {
    setPacienteId(undefined);
    setDni("");
    setNombre("");
    setApellido("");
    setSexo("");
    setTelefono("");
    setEmail("");
    setCobertura("");
    setNroAfiliado("");
    setHora("");
    setMotivo("");
    setPracticaSel("consulta");
  };

  // Guarda la ficha del paciente nuevo en la base sin necesidad de asignar turno.
  const guardarPaciente = () => {
    if (!dni.trim() || !nombre.trim() || !apellido.trim()) {
      toast({
        title: "Faltan datos del paciente",
        description: "DNI, nombre y apellido son obligatorios para guardarlo.",
        variant: "destructive",
      });
      return;
    }
    crearPacienteMutation.mutate(
      {
        data: {
          nombre: nombre.trim(),
          apellido: apellido.trim(),
          dni: dni.trim(),
          sexo: sexo === "F" ? PacienteInputSexo.F : sexo === "M" ? PacienteInputSexo.M : sexo ? PacienteInputSexo.otro : undefined,
          telefono: telefono.trim() || undefined,
          email: email.trim() || undefined,
          cobertura: cobertura || undefined,
          nroAfiliado: nroAfiliado.trim() || undefined,
        },
      },
      {
        onSuccess: (p) => {
          setPacienteId(p.id);
          toast({ title: "Paciente guardado", description: `${p.apellido}, ${p.nombre} quedó registrado en la base.` });
        },
        onError: (err) => {
          const status = (err as { response?: { status?: number } })?.response?.status;
          toast({
            title: "No se pudo guardar el paciente",
            description: status === 409 ? "Ya existe un paciente con ese DNI. Buscalo arriba por DNI." : "Revisá los datos e intentá de nuevo.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const confirmar = () => {
    // Guardia: es por orden de llegada, la hora se toma automáticamente
    const horaFinal = esGuardia ? (hora || ahoraArgentina().hora.substring(0, 5)) : hora;
    if (!turnera || !fecha || !horaFinal || !dni) {
      toast({
        title: "Faltan datos para el turno",
        description: "Complete el paciente y elija un horario.",
        variant: "destructive",
      });
      return;
    }
    if (!telefono.trim()) {
      toast({
        title: "Faltan datos obligatorios",
        description: "El teléfono es obligatorio (lo exige Klinicos).",
        variant: "destructive",
      });
      return;
    }
    createMutation.mutate(
      {
        data: {
          pacienteId,
          pacienteDni: dni,
          pacienteNombre: nombre,
          pacienteApellido: apellido,
          pacienteTelefono: telefono.trim(),
          pacienteEmail: email.trim() || undefined,
          pacienteSexo: sexo || undefined,
          cobertura: cobertura || undefined,
          nroAfiliado: nroAfiliado.trim() || undefined,
          turneraId: turnera.id,
          fecha,
          horaInicio: horaFinal,
          modalidad,
          motivoConsulta: motivo.trim() || undefined,
          klinicosPracticaId: practicaElegida ? practicaElegida.id : undefined,
        },
      },
      {
        onSuccess: (turno) => {
          toast({
            title: "Turno asignado exitosamente",
            className:
              "fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-auto min-w-[320px] bg-green-600 text-white border-green-700 shadow-2xl data-[state=open]:slide-in-from-top-0 [&>div]:text-white",
          });
          queryClient.invalidateQueries({ queryKey: getListTurnosQueryKey() });
          const esIoma = (cobertura || "").toUpperCase().includes("IOMA");
          const esHoy = fecha === ahoraArgentina().fecha;
          if (esIoma && esHoy && turno?.id) {
            setTokenDialog({
              turnoId: turno.id,
              paciente: [apellido.trim(), nombre.trim()].filter(Boolean).join(", "),
            });
          }
          limpiar();
          onCreado?.();
        },
        onError: () => {
          toast({ title: "Error al asignar turno", variant: "destructive" });
        },
      },
    );
  };

  if (!turnera) {
    return (
      <p className="text-sm text-muted-foreground py-4 text-center border border-dashed rounded-md">
        {turneras.length === 0
          ? "Elegí un profesional arriba para cargar un turno."
          : "El profesional no atiende el día elegido. Elegí otra fecha en el calendario."}
      </p>
    );
  }

  return (
    <>
    <TokenTurnoDialog
      turnoId={tokenDialog?.turnoId ?? null}
      paciente={tokenDialog?.paciente}
      abierto={!!tokenDialog}
      onClose={() => setTokenDialog(null)}
    />
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Paciente */}
      <div className="space-y-3">
        <label className="text-sm font-medium flex items-center gap-2">
          <UserCheck className="w-4 h-4 text-primary" /> Paciente
        </label>
        <PacienteBuscador
          placeholder="Escribí el DNI o el nombre..."
          data-testid="buscador-paciente-inline"
          onSelect={(p) => {
            setPacienteId(p.id);
            setDni(p.dni || "");
            setNombre(p.nombre);
            setApellido(p.apellido);
            setSexo(p.sexo || "");
            setTelefono(p.telefono || "");
            setEmail(p.email || "");
            setCobertura(p.cobertura || "");
            setNroAfiliado(p.nroAfiliado || "");
          }}
          onTexto={(t) => {
            const digitos = t.replace(/\D/g, "");
            const esNumerico = /^[\d.\s-]+$/.test(t.trim());
            if (esNumerico && digitos.length >= 7) {
              setDni(digitos);
            } else if (pacienteId) {
              setPacienteId(undefined);
            }
          }}
        />
        <div className="grid grid-cols-3 gap-2">
          <Input placeholder="DNI *" value={dni} readOnly={!!pacienteId} onChange={(e) => setDni(e.target.value)} data-testid="input-dni-inline" />
          <Input placeholder="Nombre *" value={nombre} readOnly={!!pacienteId} onChange={(e) => setNombre(e.target.value)} />
          <Input placeholder="Apellido *" value={apellido} readOnly={!!pacienteId} onChange={(e) => setApellido(e.target.value)} />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Select value={sexo} onValueChange={setSexo}>
            <SelectTrigger data-testid="select-sexo-inline"><SelectValue placeholder="Sexo" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="F">Femenino</SelectItem>
              <SelectItem value="M">Masculino</SelectItem>
              <SelectItem value="X">No binario</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative">
            <FaWhatsapp className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-green-500" />
            <Input className="pl-8" placeholder="Celular *" value={telefono} onChange={(e) => setTelefono(e.target.value)} data-testid="input-telefono-inline" />
          </div>
          <Input placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="grid grid-cols-[1fr_140px] gap-2">
          <Combobox
            testId="select-obra-social-inline"
            value={cobertura}
            onChange={setCobertura}
            placeholder="Obra social…"
            options={opcionesOS}
          />
          <Input placeholder="Nro afiliado" value={nroAfiliado} onChange={(e) => setNroAfiliado(e.target.value)} data-testid="input-nro-afiliado-inline" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Select value={modalidad} onValueChange={(v) => setModalidad(v as TurnoInputModalidad)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="presencial">Presencial</SelectItem>
              <SelectItem value="videoconsulta">Videoconsulta</SelectItem>
            </SelectContent>
          </Select>
          <Input placeholder="Motivo de consulta" value={motivo} onChange={(e) => setMotivo(e.target.value)} data-testid="input-motivo-inline" />
        </div>
        <p className="text-xs text-muted-foreground">
          * obligatorios — el celular lo exige Klinicos para la consulta.
        </p>
        {!pacienteId && (
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            onClick={guardarPaciente}
            disabled={crearPacienteMutation.isPending}
            data-testid="boton-guardar-paciente-inline"
          >
            {crearPacienteMutation.isPending ? "Guardando..." : "Guardar paciente"}
          </Button>
        )}
      </div>

      {/* Horarios del día elegido (en guardia no se elige horario: orden de llegada) */}
      <div className="space-y-3">
        {esGuardia ? (
          <div className="rounded-md border border-primary/30 bg-primary/5 p-4 space-y-1" data-testid="aviso-guardia-inline">
            <p className="text-sm font-medium flex items-center gap-2">
              <Siren className="w-4 h-4 text-primary" /> Agenda grupal — atención por orden de llegada
            </p>
            <p className="text-xs text-muted-foreground">
              No hace falta elegir horario ni profesional: el paciente queda en la cola
              y lo puede atender cualquier profesional habilitado de la especialidad.
            </p>
          </div>
        ) : (
        <>
        <label className="text-sm font-medium flex items-center gap-2">
          <Clock className="w-4 h-4 text-primary" /> Horarios disponibles · {turnera.horaInicio?.substring(0, 5)}–{turnera.horaFin?.substring(0, 5)} hs
        </label>
        {loadingSlots ? (
          <div className="text-sm text-center p-4">Cargando horarios...</div>
        ) : slots && slots.some((s) => s.disponible) ? (
          <ScrollArea className="h-[200px] w-full rounded-md border p-2">
            <div className="grid grid-cols-5 gap-1.5">
              {slots.map((slot, idx) => (
                <Button
                  key={idx}
                  type="button"
                  size="sm"
                  variant={hora === slot.horaInicio ? "default" : "outline"}
                  className={!slot.disponible ? "opacity-40" : ""}
                  disabled={!slot.disponible}
                  onClick={() => setHora(slot.horaInicio)}
                  data-testid={`slot-inline-${slot.horaInicio}`}
                >
                  {slot.horaInicio.substring(0, 5)}
                </Button>
              ))}
            </div>
          </ScrollArea>
        ) : (
          <div className="text-sm text-muted-foreground text-center p-4 border border-dashed rounded-md bg-muted/20">
            No hay horarios disponibles para esta fecha.
          </div>
        )}
        </>
        )}
        {/* Códigos de prestación: consulta (420101) por defecto; al elegir
            una práctica (eco, RX, etc.) se muestran todos sus códigos. */}
        <div
          className="rounded-md border bg-muted/30 p-3 space-y-2"
          data-testid="codigo-prestacion-inline"
        >
          <p className="text-sm font-medium flex items-center gap-2">
            <Hash className="w-4 h-4 text-primary" /> Códigos de prestación
          </p>
          <Combobox
            testId="select-practica-inline"
            value={practicaSel}
            onChange={(v) => setPracticaSel(v || "consulta")}
            placeholder="Elegir práctica…"
            options={[
              { value: "consulta", label: "CONSULTA (420101)" },
              ...practicasActivas.map((p) => ({
                value: String(p.id),
                label: `${p.nombre} (${(p.codigos ?? []).join(", ")})`,
              })),
            ]}
          />
          <div className="max-h-[150px] w-full overflow-y-auto rounded-md border bg-background/50">
            <div className="p-2 space-y-1.5" data-testid="lista-codigos-prestacion">
              {codigosAMostrar.map((codigo, idx) => (
                <label key={`${codigo}-${idx}`} className="flex items-start gap-3">
                  <Checkbox checked disabled className="mt-0.5" data-testid={`check-codigo-${codigo}-${idx}`} />
                  <span className="font-mono text-sm font-semibold shrink-0">{codigo}</span>
                  <span className="text-sm text-muted-foreground leading-snug">
                    {descripcionPorCodigo.get(codigo) ?? (practicaElegida?.nombre ?? "CONSULTA")}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <Button
          className="w-full"
          onClick={confirmar}
          disabled={createMutation.isPending}
          data-testid="boton-confirmar-turno-inline"
        >
          {createMutation.isPending ? "Guardando..." : esGuardia ? "Cargar paciente en la cola" : "Confirmar turno"}
        </Button>
      </div>
    </div>
    </>
  );
}
