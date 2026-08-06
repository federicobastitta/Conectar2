import { useState } from "react";
import { Link, useLocation } from "wouter";
import { format, addDays } from "date-fns";
import { es } from "date-fns/locale";
import { useListSedes, useListEspecialidades, useListProfesionales, useListTurneras, useGetDisponibilidadTurnera } from "@workspace/api-client-react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Calendar } from "@/components/ui/calendar";
import { Hospital, Stethoscope, UserCircle, Calendar as CalendarIcon, Clock, ArrowRight } from "lucide-react";

export default function Reservar() {
  const [, setLocation] = useLocation();
  const [step, setStep] = useState(1);
  const [reserva, setReserva] = useState<{
    sedeId?: number;
    especialidadId?: number;
    profesionalId?: number; // 0 significa 'Cualquiera'
    turneraId?: number;
    fecha?: Date;
    hora?: string;
  }>({});

  const { data: sedes, isLoading: loadingSedes } = useListSedes({ activa: true });

  // Todas las agendas online de la sede elegida: sirven para filtrar
  // especialidades y profesionales que realmente tienen turnos reservables.
  const { data: turnerasSede, isLoading: loadingTurnerasSede } = useListTurneras(
    { sedeId: reserva.sedeId, activa: true, visibilidad: 'online' },
    { query: { enabled: step >= 2 && !!reserva.sedeId } }
  );

  const { data: especialidadesTodas, isLoading: loadingEsp } = useListEspecialidades({
    query: { enabled: step >= 2 }
  });

  const especialidades = especialidadesTodas?.filter(esp =>
    turnerasSede?.some(t => t.especialidadId === esp.id)
  );

  const { data: profesionalesTodos, isLoading: loadingProf } = useListProfesionales(
    { especialidadId: reserva.especialidadId, sedeId: reserva.sedeId, activo: true },
    { query: { enabled: step >= 3 } }
  );

  const profesionales = profesionalesTodos?.filter(prof =>
    turnerasSede?.some(t => t.especialidadId === reserva.especialidadId && t.profesionalId === prof.id)
  );

  const loadingTurneras = loadingTurnerasSede;

  // Seleccionamos la primera turnera disponible para la búsqueda de slots
  const turnerasFiltradas = turnerasSede?.filter(t =>
    t.especialidadId === reserva.especialidadId &&
    (reserva.profesionalId === 0 || t.profesionalId === reserva.profesionalId)
  );
  const turneraActiva = turnerasFiltradas && turnerasFiltradas.length > 0 ? turnerasFiltradas[0] : null;

  const { data: slots, isLoading: loadingSlots } = useGetDisponibilidadTurnera(
    turneraActiva?.id || 0,
    reserva.fecha ? format(reserva.fecha, 'yyyy-MM-dd') : format(new Date(), 'yyyy-MM-dd'),
    { query: { enabled: step >= 4 && !!turneraActiva && !!reserva.fecha } }
  );

  const nextStep = () => setStep(s => s + 1);
  const prevStep = () => setStep(s => s - 1);

  const handleSedeSelect = (id: number) => {
    setReserva({ ...reserva, sedeId: id });
    nextStep();
  };

  const handleEspSelect = (id: number) => {
    setReserva({ ...reserva, especialidadId: id });
    nextStep();
  };

  const handleProfSelect = (id: number) => {
    setReserva({ ...reserva, profesionalId: id });
    nextStep();
  };

  const handleSlotSelect = (hora: string) => {
    setReserva({ ...reserva, hora, turneraId: turneraActiva?.id });
    
    // Store in sessionStorage to pass to confirmation page
    sessionStorage.setItem('reserva_draft', JSON.stringify({
      ...reserva,
      hora,
      turneraId: turneraActiva?.id,
      turneraNombre: turneraActiva?.nombre,
      // La confirmación necesita saber si es práctica: la región anatómica es obligatoria.
      turneraTipo: turneraActiva?.tipo,
      sedeNombre: sedes?.find(s => s.id === reserva.sedeId)?.nombre,
      espNombre: especialidades?.find(e => e.id === reserva.especialidadId)?.nombre,
      profNombre: reserva.profesionalId === 0 ? 'Primer Profesional Disponible' : 
        profesionales?.find(p => p.id === reserva.profesionalId)?.apellido,
    }));
    
    setLocation('/reservar/confirmar');
  };

  return (
    <div className="max-w-2xl mx-auto w-full">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold tracking-tight text-primary">Reservar Turno</h1>
        <p className="text-muted-foreground mt-2">Siga los pasos para programar su cita médica.</p>
      </div>

      {/* Stepper progress */}
      <div className="flex items-center justify-center mb-8">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
              step === i ? "bg-primary text-primary-foreground" :
              step > i ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
            }`}>
              {i}
            </div>
            {i < 4 && <div className={`w-12 h-1 mx-1 rounded ${step > i ? "bg-primary/50" : "bg-muted"}`} />}
          </div>
        ))}
      </div>

      {step > 1 && (
        <Button variant="ghost" onClick={prevStep} className="mb-4">
          ← Volver al paso anterior
        </Button>
      )}

      {/* Step 1: Sede */}
      {step === 1 && (
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Hospital className="w-5 h-5 text-primary" /> ¿Dónde desea atenderse?
          </h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {loadingSedes ? (
              Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)
            ) : (
              sedes?.map(sede => (
                <Card 
                  key={sede.id} 
                  className="cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-all"
                  onClick={() => handleSedeSelect(sede.id)}
                >
                  <CardContent className="p-6">
                    <div className="font-semibold text-lg">{sede.nombre}</div>
                    {sede.direccion && <div className="text-sm text-muted-foreground mt-1">{sede.direccion}</div>}
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </div>
      )}

      {/* Step 2: Especialidad */}
      {step === 2 && (
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Stethoscope className="w-5 h-5 text-primary" /> ¿Qué especialidad busca?
          </h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {loadingEsp || loadingTurnerasSede ? (
              Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)
            ) : especialidades?.length === 0 ? (
              <div className="sm:col-span-2 text-center py-8 text-muted-foreground border rounded-lg">
                Esta sede no tiene agendas online disponibles por el momento.
              </div>
            ) : (
              especialidades?.map(esp => (
                <Button 
                  key={esp.id} 
                  variant="outline" 
                  className="h-auto p-4 justify-start text-left font-normal"
                  onClick={() => handleEspSelect(esp.id)}
                >
                  {esp.nombre}
                </Button>
              ))
            )}
          </div>
        </div>
      )}

      {/* Step 3: Profesional */}
      {step === 3 && (
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <UserCircle className="w-5 h-5 text-primary" /> Seleccione un profesional
          </h2>
          <div className="grid gap-4">
            <Card 
              className="cursor-pointer hover:border-primary/50 border-primary/20 bg-primary/5 transition-all"
              onClick={() => handleProfSelect(0)}
            >
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <div className="font-semibold text-primary">Cualquier profesional disponible</div>
                  <div className="text-sm text-muted-foreground">Veré el primer turno más cercano</div>
                </div>
                <ArrowRight className="w-5 h-5 text-primary" />
              </CardContent>
            </Card>

            <div className="text-sm font-medium text-muted-foreground pt-4 pb-2 border-b">
              O elija un profesional específico:
            </div>

            {loadingProf || loadingTurnerasSede ? (
              Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)
            ) : profesionales?.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground border rounded-lg">
                No hay profesionales disponibles para esta selección.
              </div>
            ) : (
              profesionales?.map(prof => (
                <Card 
                  key={prof.id} 
                  className="cursor-pointer hover:border-primary/50 transition-all"
                  onClick={() => handleProfSelect(prof.id)}
                >
                  <CardContent className="p-4 flex items-center gap-4">
                    <div className="bg-muted w-12 h-12 rounded-full flex items-center justify-center">
                      <UserCircle className="w-6 h-6 text-muted-foreground" />
                    </div>
                    <div>
                      <div className="font-semibold">Dr. {prof.apellido}, {prof.nombre}</div>
                      <div className="text-sm text-muted-foreground">Matrícula: {prof.matricula || '-'}</div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </div>
      )}

      {/* Step 4: Fecha y Hora */}
      {step === 4 && (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <CalendarIcon className="w-5 h-5 text-primary" /> Seleccione fecha y hora
          </h2>

          {loadingTurneras ? (
            <div className="grid md:grid-cols-2 gap-8"><Skeleton className="h-[300px] w-full" /><Skeleton className="h-[300px] w-full" /></div>
          ) : !turneraActiva ? (
            <div className="text-center py-12 border-2 border-dashed rounded-lg bg-muted/10">
              <p className="text-muted-foreground mb-4">No hay agendas disponibles con estas opciones.</p>
              <Button variant="outline" onClick={() => setStep(1)}>Volver al inicio</Button>
            </div>
          ) : (
            <div className="grid md:grid-cols-2 gap-8 items-start">
              <Card>
                <CardContent className="p-4 flex justify-center">
                  <Calendar
                    mode="single"
                    selected={reserva.fecha}
                    onSelect={(date) => date && setReserva({...reserva, fecha: date})}
                    disabled={(date) => {
                      // Deshabilitar fechas pasadas y días que no atiende la turnera
                      const isPast = date < new Date(new Date().setHours(0,0,0,0));
                      const isNotAtencion = !turneraActiva.diasAtencion?.includes(date.getDay());
                      return isPast || isNotAtencion;
                    }}
                    modifiers={{
                      atiende: (date) => {
                        const isPast = date < new Date(new Date().setHours(0, 0, 0, 0));
                        return !isPast && !!turneraActiva.diasAtencion?.includes(date.getDay());
                      },
                    }}
                    modifiersClassNames={{
                      atiende: "bg-emerald-100 text-emerald-900 font-semibold hover:bg-emerald-200",
                    }}
                    className="rounded-md"
                    locale={es}
                  />
                </CardContent>
              </Card>

              <div>
                <h3 className="font-medium mb-4 flex items-center gap-2">
                  <Clock className="w-4 h-4 text-primary" /> 
                  Horarios para el {reserva.fecha ? format(reserva.fecha, "d 'de' MMMM", { locale: es }) : 'día seleccionado'}
                </h3>
                
                {!reserva.fecha ? (
                  <div className="text-sm text-muted-foreground border border-dashed p-6 rounded-lg text-center">
                    Seleccione un día en el calendario para ver los horarios disponibles.
                  </div>
                ) : loadingSlots ? (
                  <div className="grid grid-cols-2 gap-2">
                    {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
                  </div>
                ) : slots && slots.length > 0 ? (
                  <div className="grid grid-cols-3 gap-2">
                    {slots.filter(s => s.disponible).map((slot, idx) => (
                      <Button
                        key={idx}
                        variant="outline"
                        className="w-full font-mono hover:border-primary hover:bg-primary/5"
                        onClick={() => handleSlotSelect(slot.horaInicio)}
                      >
                        {slot.horaInicio.substring(0, 5)}
                      </Button>
                    ))}
                    {slots.filter(s => s.disponible).length === 0 && (
                      <div className="col-span-3 text-sm text-center text-muted-foreground py-4">
                        No hay horarios disponibles este día.
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-sm text-center text-muted-foreground py-8 border rounded-lg bg-muted/20">
                    No hay turnos programados para este día.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
