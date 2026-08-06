import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { format } from "date-fns";
import { es } from "date-fns/locale";

import { useCreateTurno } from "@workspace/api-client-react";
import { TurnoInputModalidad } from "@workspace/api-client-react";

import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { CalendarIcon, Clock, MapPin, UserCircle, CheckCircle2, Loader2 } from "lucide-react";
import { TurnoQr } from "@/components/turnos/turno-qr";

const pacienteSchema = z.object({
  pacienteDni: z.string().min(7, "DNI inválido"),
  pacienteNombre: z.string().min(2, "Nombre requerido"),
  pacienteApellido: z.string().min(2, "Apellido requerido"),
  sexo: z.string().min(1, "Seleccione una opción"),
  email: z.string().email("Email inválido").optional().or(z.literal("")),
  telefono: z.string().min(6, "Teléfono requerido"),
  cobertura: z.string().min(2, "Obra social requerida (o escriba Particular)"),
  nroAfiliado: z.string().optional(),
  motivoConsulta: z.string().min(3, "Cuéntenos brevemente el motivo"),
  // Obligatoria solo para prácticas: se valida al enviar según la turnera.
  regionAnatomica: z.string().optional(),
});

export default function ConfirmarTurno() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { user, isLoading: authLoading } = useAuth();
  const esPacienteLogueado = user?.rol === "paciente" && user?.pacienteId != null;

  const [draft, setDraft] = useState<any>(null);
  const [confirmedData, setConfirmedData] = useState<any>(null);
  // Región anatómica del estudio (obligatoria si la turnera es de práctica).
  const [regionPaciente, setRegionPaciente] = useState("");

  useEffect(() => {
    const savedDraft = sessionStorage.getItem('reserva_draft');
    if (savedDraft) {
      setDraft(JSON.parse(savedDraft));
    } else {
      setLocation("/reservar");
    }
  }, [setLocation]);

  const form = useForm<z.infer<typeof pacienteSchema>>({
    resolver: zodResolver(pacienteSchema),
    defaultValues: {
      pacienteDni: "",
      pacienteNombre: "",
      pacienteApellido: "",
      sexo: "",
      email: "",
      telefono: "",
      cobertura: "",
      nroAfiliado: "",
      motivoConsulta: "",
      regionAnatomica: "",
    },
  });

  const esPractica = draft?.turneraTipo === "practica";

  const createMutation = useCreateTurno();

  const onSubmit = (values: z.infer<typeof pacienteSchema>) => {
    if (!draft) return;
    if (esPractica && !(values.regionAnatomica ?? "").trim()) {
      form.setError("regionAnatomica", { message: "Indique la parte del cuerpo a estudiar" });
      return;
    }

    createMutation.mutate({ 
      data: {
        turneraId: draft.turneraId,
        fecha: format(new Date(draft.fecha), 'yyyy-MM-dd'),
        horaInicio: draft.hora,
        modalidad: TurnoInputModalidad.presencial,
        pacienteDni: values.pacienteDni,
        pacienteNombre: values.pacienteNombre,
        pacienteApellido: values.pacienteApellido,
        pacienteSexo: values.sexo,
        pacienteTelefono: values.telefono,
        pacienteEmail: values.email || undefined,
        cobertura: values.cobertura,
        nroAfiliado: (values.nroAfiliado ?? "").trim() || undefined,
        motivoConsulta: values.motivoConsulta,
        ...((values.regionAnatomica ?? "").trim() && { regionAnatomica: (values.regionAnatomica ?? "").trim() }),
      }
    }, {
      onSuccess: (data) => {
        sessionStorage.removeItem('reserva_draft');
        setConfirmedData({
          ...draft,
          paciente: values,
          turnoId: data.id,
          qrCodigo: data.qrCodigo ?? null,
        });
      },
      onError: () => {
        toast({ title: "Error al confirmar", description: "El turno ya no está disponible", variant: "destructive" });
      }
    });
  };

  // Paciente logueado: reserva directa con su sesión, sin cargar datos personales.
  const confirmarComoPaciente = () => {
    if (!draft) return;
    if (esPractica && !regionPaciente.trim()) {
      toast({
        title: "Falta la región anatómica",
        description: "Indicá qué parte del cuerpo se va a estudiar (ej: rodilla derecha, tórax).",
        variant: "destructive",
      });
      return;
    }

    createMutation.mutate({
      data: {
        turneraId: draft.turneraId,
        fecha: format(new Date(draft.fecha), 'yyyy-MM-dd'),
        horaInicio: draft.hora,
        modalidad: TurnoInputModalidad.presencial,
        ...(regionPaciente.trim() && { regionAnatomica: regionPaciente.trim() }),
      }
    }, {
      onSuccess: (data) => {
        sessionStorage.removeItem('reserva_draft');
        setConfirmedData({
          ...draft,
          paciente: null,
          turnoId: data.id,
          qrCodigo: data.qrCodigo ?? null,
        });
      },
      onError: () => {
        toast({ title: "Error al confirmar", description: "El turno ya no está disponible", variant: "destructive" });
      }
    });
  };

  if (confirmedData) {
    return (
      <div className="max-w-md mx-auto w-full pt-8 animate-in zoom-in duration-500">
        <Card className="border-green-200 shadow-lg">
          <CardHeader className="text-center pb-2">
            <div className="mx-auto bg-green-100 w-16 h-16 rounded-full flex items-center justify-center mb-4">
              <CheckCircle2 className="w-8 h-8 text-green-600" />
            </div>
            <CardTitle className="text-2xl text-green-700">¡Turno Confirmado!</CardTitle>
            <p className="text-muted-foreground mt-2">Su cita ha sido agendada con éxito.</p>
          </CardHeader>
          <CardContent className="space-y-6 pt-4">
            <div className="bg-muted/30 p-4 rounded-lg space-y-3">
              <div className="flex items-start gap-3">
                <CalendarIcon className="w-5 h-5 text-primary mt-0.5" />
                <div>
                  <div className="font-medium capitalize">{format(new Date(confirmedData.fecha), "EEEE d 'de' MMMM, yyyy", { locale: es })}</div>
                  <div className="text-muted-foreground">a las {confirmedData.hora.substring(0, 5)} hs</div>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <UserCircle className="w-5 h-5 text-primary mt-0.5" />
                <div>
                  <div className="font-medium">Dr. {confirmedData.profNombre}</div>
                  <div className="text-muted-foreground">{confirmedData.espNombre}</div>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <MapPin className="w-5 h-5 text-primary mt-0.5" />
                <div className="font-medium">{confirmedData.sedeNombre}</div>
              </div>
            </div>

            {confirmedData.qrCodigo && (
              <div className="pt-2 border-t">
                <div className="text-sm font-medium text-center mb-3">Su código de acceso</div>
                <TurnoQr codigo={confirmedData.qrCodigo} />
              </div>
            )}

            <div className="text-sm text-center text-muted-foreground">
              Hemos enviado los detalles a su correo electrónico. Se le pedirá presentarse 10 minutos antes con su credencial de cobertura.
            </div>
          </CardContent>
          <CardFooter>
            <Link href="/" className="w-full">
              <Button className="w-full">Volver al inicio</Button>
            </Link>
          </CardFooter>
        </Card>
      </div>
    );
  }

  if (!draft) return null;

  return (
    <div className="max-w-3xl mx-auto w-full">
      <div className="mb-8">
        <Link href="/reservar">
          <Button variant="ghost" className="-ml-4 mb-2">← Volver</Button>
        </Link>
        <h1 className="text-3xl font-bold tracking-tight text-primary">
          {esPacienteLogueado ? "Confirmar Reserva" : "Confirmar Datos"}
        </h1>
        <p className="text-muted-foreground mt-2">
          {esPacienteLogueado
            ? "Revisá el resumen y confirmá tu turno."
            : "Complete sus datos para finalizar la reserva."}
        </p>
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        <div className="md:col-span-2">
          {esPacienteLogueado ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Datos del Paciente</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-3 bg-muted/30 p-4 rounded-lg">
                  <UserCircle className="w-8 h-8 text-primary shrink-0" />
                  <div>
                    <div className="font-medium">{user?.nombre}</div>
                    <div className="text-sm text-muted-foreground">
                      El turno se reservará a tu nombre, sin necesidad de volver a cargar tus datos.
                    </div>
                  </div>
                </div>
                {esPractica && (
                  <div className="mt-4 space-y-1.5">
                    <label className="text-sm font-medium">Región anatómica / parte del cuerpo a estudiar *</label>
                    <Input
                      value={regionPaciente}
                      onChange={(e) => setRegionPaciente(e.target.value)}
                      placeholder="Ej: rodilla derecha, abdomen, columna lumbar, tórax"
                      data-testid="input-region-anatomica-paciente"
                    />
                    <p className="text-xs text-muted-foreground">
                      Nos ayuda a preparar el equipo y evitar errores el día del estudio.
                    </p>
                  </div>
                )}
              </CardContent>
              <CardFooter className="bg-muted/20 py-4 border-t flex justify-end">
                <Button onClick={confirmarComoPaciente} disabled={createMutation.isPending || authLoading} className="w-full md:w-auto">
                  {createMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Confirmar Reserva
                </Button>
              </CardFooter>
            </Card>
          ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Datos del Paciente</CardTitle>
            </CardHeader>
            <CardContent>
              <Form {...form}>
                <form id="confirm-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                  <FormField control={form.control} name="pacienteDni" render={({ field }) => (
                    <FormItem>
                      <FormLabel>DNI</FormLabel>
                      <FormControl><Input placeholder="Sin puntos ni espacios" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="pacienteNombre" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Nombre</FormLabel>
                        <FormControl><Input {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="pacienteApellido" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Apellido</FormLabel>
                        <FormControl><Input {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="sexo" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Sexo</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-sexo">
                              <SelectValue placeholder="Seleccionar" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="F">Femenino</SelectItem>
                            <SelectItem value="M">Masculino</SelectItem>
                            <SelectItem value="X">X / Otro</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="telefono" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Teléfono Celular</FormLabel>
                        <FormControl><Input placeholder="Cód área + número" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="cobertura" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Obra Social</FormLabel>
                        <FormControl><Input placeholder='Ej: IOMA — o "Particular"' data-testid="input-cobertura" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="nroAfiliado" render={({ field }) => (
                      <FormItem>
                        <FormLabel>N° de Afiliado (opcional)</FormLabel>
                        <FormControl><Input placeholder="Como figura en su credencial" data-testid="input-nro-afiliado" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>
                  {esPractica && (
                    <FormField control={form.control} name="regionAnatomica" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Región anatómica / parte del cuerpo a estudiar</FormLabel>
                        <FormControl><Input placeholder="Ej: rodilla derecha, abdomen, columna lumbar, tórax" data-testid="input-region-anatomica" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  )}
                  <FormField control={form.control} name="motivoConsulta" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Motivo de Consulta</FormLabel>
                      <FormControl><Textarea rows={2} placeholder="Ej: control anual, dolor de rodilla, ecografía solicitada por su médico…" data-testid="input-motivo-consulta" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="email" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email (Opcional)</FormLabel>
                      <FormControl><Input type="email" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </form>
              </Form>
            </CardContent>
            <CardFooter className="bg-muted/20 py-4 border-t flex justify-end">
              <Button type="submit" form="confirm-form" disabled={createMutation.isPending} className="w-full md:w-auto">
                {createMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Confirmar Reserva
              </Button>
            </CardFooter>
          </Card>
          )}
        </div>

        <div className="md:col-span-1">
          <Card className="bg-primary/5 border-primary/20 sticky top-6">
            <CardHeader>
              <CardTitle className="text-lg">Resumen del Turno</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div className="flex gap-3">
                <CalendarIcon className="w-5 h-5 text-primary shrink-0" />
                <div>
                  <div className="font-medium capitalize">{format(new Date(draft.fecha), "EEEE d 'de' MMMM", { locale: es })}</div>
                  <div className="text-muted-foreground">{draft.hora.substring(0, 5)} hs</div>
                </div>
              </div>
              <div className="flex gap-3">
                <UserCircle className="w-5 h-5 text-primary shrink-0" />
                <div>
                  <div className="font-medium">Dr. {draft.profNombre}</div>
                  <div className="text-muted-foreground">{draft.espNombre}</div>
                </div>
              </div>
              <div className="flex gap-3">
                <MapPin className="w-5 h-5 text-primary shrink-0" />
                <div>
                  <div className="font-medium">{draft.sedeNombre}</div>
                  <div className="text-muted-foreground text-xs mt-1">Presencial</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
