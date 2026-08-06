import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetDemandaEspontanea,
  useCreateTurno,
  getListTurnosQueryKey,
  type DemandaEspontaneaItem,
  type Paciente,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { PacienteBuscador } from "@/components/pacientes/paciente-buscador";
import { TokenTurnoDialog } from "@/components/turnos/token-turno-dialog";
import { Zap, Clock, MapPin, ArrowLeft, UserCheck, Loader2 } from "lucide-react";

function ahoraArgentina() {
  const fecha = new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
  const hora = new Date().toLocaleTimeString("en-GB", {
    timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit",
  });
  return { fecha, hora };
}

// Ingreso ambulatorio (demanda espontánea): pacientes que llegan sin turno.
// Recepción elige la especialidad que está atendiendo ahora, carga los datos
// del paciente y el ingreso entra directo a la sala de hoy (sin fecha ni
// hora a elegir). Los médicos lo toman desde su consultorio.
export function DemandaEspontaneaBoton() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [abierto, setAbierto] = useState(false);
  const [elegida, setElegida] = useState<DemandaEspontaneaItem | null>(null);
  const [paciente, setPaciente] = useState<Paciente | null>(null);
  const [dni, setDni] = useState("");
  const [nombre, setNombre] = useState("");
  const [apellido, setApellido] = useState("");
  const [telefono, setTelefono] = useState("");
  const [cobertura, setCobertura] = useState("");
  const [nroAfiliado, setNroAfiliado] = useState("");
  const [motivo, setMotivo] = useState("");
  // Popup "Cargue token": el ingreso ambulatorio es siempre de hoy, así que
  // si la cobertura es IOMA se pide el token igual que en cualquier carga
  // de turno (mismas reglas del robot).
  const [tokenDialog, setTokenDialog] = useState<{ turnoId: number; paciente: string } | null>(null);

  const { data, isLoading } = useGetDemandaEspontanea({ query: { enabled: abierto } });
  const createMutation = useCreateTurno();

  const limpiar = () => {
    setElegida(null);
    setPaciente(null);
    setDni(""); setNombre(""); setApellido(""); setTelefono("");
    setCobertura(""); setNroAfiliado(""); setMotivo("");
  };

  const cerrar = (open: boolean) => {
    setAbierto(open);
    if (!open) limpiar();
  };

  const datosValidos = paciente !== null || (dni.trim() && nombre.trim() && apellido.trim());

  const ingresar = () => {
    if (!elegida || !datosValidos) return;
    const { fecha, hora } = ahoraArgentina();
    createMutation.mutate(
      {
        data: {
          turneraId: elegida.turneraId,
          fecha,
          horaInicio: hora,
          modalidad: "presencial",
          ...(paciente
            ? { pacienteId: paciente.id, ...(telefono.trim() ? { pacienteTelefono: telefono.trim() } : {}) }
            : {
                pacienteDni: dni.trim(),
                pacienteNombre: nombre.trim(),
                pacienteApellido: apellido.trim(),
                ...(telefono.trim() ? { pacienteTelefono: telefono.trim() } : {}),
              }),
          ...(cobertura.trim() ? { cobertura: cobertura.trim() } : {}),
          ...(nroAfiliado.trim() ? { nroAfiliado: nroAfiliado.trim() } : {}),
          motivoConsulta: motivo.trim() || "Ingreso ambulatorio (demanda espontánea)",
        },
      },
      {
        onSuccess: (turno) => {
          toast({
            title: "Paciente ingresado",
            description: `Entró a la sala de ${elegida.especialidad?.nombre ?? elegida.turneraNombre}. El primer médico libre lo va a atender.`,
          });
          queryClient.invalidateQueries({ queryKey: getListTurnosQueryKey() });
          const cob = (paciente?.cobertura ?? cobertura ?? "").toUpperCase();
          if (cob.includes("IOMA") && turno?.id) {
            setTokenDialog({
              turnoId: turno.id,
              paciente: paciente
                ? `${paciente.apellido}, ${paciente.nombre}`
                : [apellido.trim(), nombre.trim()].filter(Boolean).join(", "),
            });
          }
          cerrar(false);
        },
        onError: () => toast({ title: "No se pudo ingresar al paciente", variant: "destructive" }),
      },
    );
  };

  return (
    <>
    <TokenTurnoDialog
      turnoId={tokenDialog?.turnoId ?? null}
      paciente={tokenDialog?.paciente}
      abierto={!!tokenDialog}
      onClose={() => setTokenDialog(null)}
    />
    <Dialog open={abierto} onOpenChange={cerrar}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2" data-testid="button-demanda-espontanea">
          <Zap className="w-4 h-4 text-amber-500" />
          Ingreso ambulatorio
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-500" />
            {elegida ? `Ingreso a ${elegida.especialidad?.nombre ?? elegida.turneraNombre}` : "Ingreso ambulatorio"}
          </DialogTitle>
          <DialogDescription>
            {elegida
              ? "Cargá los datos del paciente. Entra ahora a la sala: sin fecha ni hora, el primer médico libre lo atiende."
              : "Pacientes sin turno. Especialidades atendiendo ahora que aceptan demanda espontánea."}
          </DialogDescription>
        </DialogHeader>

        {!elegida ? (
          isLoading ? (
            <div className="space-y-2">
              {[1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
            </div>
          ) : !data || data.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              Ahora mismo ningún médico tiene prendida la demanda espontánea.
            </p>
          ) : (
            <div className="space-y-2 max-h-[60vh] overflow-y-auto">
              {data.map((item) => (
                <button
                  key={item.turneraId}
                  type="button"
                  onClick={() => setElegida(item)}
                  className="w-full text-left border rounded-lg p-3 hover:bg-muted/50 transition-colors"
                  data-testid={`demanda-especialidad-${item.turneraId}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-sm">{item.especialidad?.nombre ?? item.turneraNombre}</p>
                    {item.sede && (
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <MapPin className="w-3 h-3" /> {item.sede.nombre}
                      </span>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {item.medicos.map((m) => (
                      <Badge key={m.id} variant="secondary" className="font-normal gap-1">
                        {m.nombre}
                        {m.hastaHora && (
                          <span className="inline-flex items-center gap-0.5 text-muted-foreground">
                            <Clock className="w-3 h-3" /> hasta {m.hastaHora}
                          </span>
                        )}
                      </Badge>
                    ))}
                  </div>
                </button>
              ))}
            </div>
          )
        ) : (
          <div className="space-y-3">
            {paciente ? (
              <div className="border rounded-lg p-3 flex items-center justify-between gap-2 bg-muted/40">
                <div className="flex items-center gap-2 text-sm">
                  <UserCheck className="w-4 h-4 text-primary" />
                  <span className="font-medium">{paciente.apellido}, {paciente.nombre}</span>
                  <span className="text-muted-foreground">DNI {paciente.dni}</span>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setPaciente(null)}>Cambiar</Button>
              </div>
            ) : (
              <>
                <PacienteBuscador
                  onSelect={(p) => {
                    // Igual que el formulario de turnos: traer los datos
                    // guardados del paciente (teléfono, cobertura, afiliado).
                    setPaciente(p);
                    setTelefono(p.telefono || "");
                    setCobertura(p.cobertura || "");
                    setNroAfiliado(p.nroAfiliado || "");
                  }}
                  onTexto={(t) => { if (/^\d{6,9}$/.test(t.trim())) setDni(t.trim()); }}
                  placeholder="Buscar paciente por nombre o DNI..."
                  autoFocus
                  data-testid="input-buscar-paciente-ambulatorio"
                />
                <p className="text-xs text-muted-foreground">Si no existe, cargalo acá:</p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">DNI *</Label>
                    <Input value={dni} onChange={(e) => setDni(e.target.value)} data-testid="input-dni-ambulatorio" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Teléfono</Label>
                    <Input value={telefono} onChange={(e) => setTelefono(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Nombre *</Label>
                    <Input value={nombre} onChange={(e) => setNombre(e.target.value)} data-testid="input-nombre-ambulatorio" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Apellido *</Label>
                    <Input value={apellido} onChange={(e) => setApellido(e.target.value)} data-testid="input-apellido-ambulatorio" />
                  </div>
                </div>
              </>
            )}

            <div className="grid grid-cols-2 gap-2">
              {paciente && (
                <div className="space-y-1">
                  <Label className="text-xs">Teléfono</Label>
                  <Input value={telefono} onChange={(e) => setTelefono(e.target.value)} data-testid="input-telefono-ambulatorio" />
                </div>
              )}
              <div className="space-y-1">
                <Label className="text-xs">Cobertura / Obra social</Label>
                <Input value={cobertura} onChange={(e) => setCobertura(e.target.value)} placeholder="Particular, IOMA..." />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">N° de afiliado</Label>
                <Input value={nroAfiliado} onChange={(e) => setNroAfiliado(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Motivo de consulta</Label>
              <Input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Opcional" />
            </div>

            <div className="flex justify-between gap-2 pt-1">
              <Button variant="ghost" onClick={() => setElegida(null)} className="gap-1">
                <ArrowLeft className="w-4 h-4" /> Volver
              </Button>
              <Button
                onClick={ingresar}
                disabled={!datosValidos || createMutation.isPending}
                className="gap-2"
                data-testid="button-confirmar-ingreso-ambulatorio"
              >
                {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                Ingresar paciente
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
    </>
  );
}
