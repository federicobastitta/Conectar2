import { Link, useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import { ArrowLeft, CalendarPlus } from "lucide-react";
import { NuevoTurnoForm, type PrefillTurno } from "@/components/turnos/nuevo-turno-form";
import { DemandaEspontaneaBoton } from "@/components/turnos/demanda-espontanea-boton";

export default function TurnoNuevo() {
  // Precarga desde otras pantallas (ej. "Asignar turno" en órdenes de prácticas):
  // /turnos/nuevo?dni=...&nombre=...&practica=<código nomenclador>&busqueda=...
  const search = useSearch();
  const q = new URLSearchParams(search);
  const prefill: PrefillTurno | undefined = q.size > 0
    ? {
        pacienteId: q.get("pacienteId") ? Number(q.get("pacienteId")) : undefined,
        dni: q.get("dni") ?? undefined,
        nombre: q.get("nombre") ?? undefined,
        apellido: q.get("apellido") ?? undefined,
        telefono: q.get("telefono") ?? undefined,
        cobertura: q.get("cobertura") ?? undefined,
        nroAfiliado: q.get("nroAfiliado") ?? undefined,
        practica: q.get("practica") ?? undefined,
        busqueda: q.get("busqueda") ?? undefined,
      }
    : undefined;
  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-4">
        <Link href="/turnos">
          <Button variant="outline" size="icon">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <CalendarPlus className="w-7 h-7 text-primary" /> Nuevo Turno
          </h1>
          <p className="text-muted-foreground">Elegí la especialidad y seleccioná una agenda del tablero</p>
        </div>
        <DemandaEspontaneaBoton />
      </div>
      {/* Tras cargar un turno nos quedamos acá, con el formulario limpio para cargar el siguiente. */}
      <NuevoTurnoForm prefill={prefill} />
    </div>
  );
}
