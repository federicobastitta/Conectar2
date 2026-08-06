import { useState } from "react";
import { Link } from "wouter";
import { format } from "date-fns";
import { useListTurnos, useListSedes, useListEspecialidades, useListProfesionales } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { StatusMacroBadge } from "@/components/ui/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarIcon } from "lucide-react";
import { AccionesRapidas } from "@/components/recepcion/acciones-rapidas";
import { getEstadoMacro, ESTADO_MACRO_META, ESTADOS_MACRO_ORDEN, type EstadoMacro } from "@/lib/episodio";
import { PageHeader } from "@/components/layout/page-header";

export default function TurnosList() {
  const [fecha, setFecha] = useState<string>(format(new Date(), 'yyyy-MM-dd'));
  const [estado, setEstado] = useState<string>("all");
  const [sedeId, setSedeId] = useState<string>("all");

  const { data: turnosResponse, isLoading } = useListTurnos({
    fecha: fecha,
    sedeId: sedeId !== "all" ? Number(sedeId) : undefined,
  });

  const { data: sedes } = useListSedes();

  const turnos = (turnosResponse?.data ?? []).filter(
    (t) => estado === "all" || getEstadoMacro(t.estado) === (estado as EstadoMacro),
  );

  return (
    <>
      <PageHeader 
        title="Turnos"
        breadcrumb={[{ label: "Inicio", href: "/" }, { label: "Turnos" }]}
      />
      
      <div className="p-6 space-y-6">
        <AccionesRapidas />

        <Card>
          <CardHeader className="py-4">
            <div className="flex flex-wrap gap-4 items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2 border rounded-md px-3 bg-background">
                  <CalendarIcon className="w-4 h-4 text-muted-foreground" />
                  <Input 
                    type="date" 
                    value={fecha} 
                    onChange={(e) => setFecha(e.target.value)} 
                    className="border-0 focus-visible:ring-0 px-0 w-[140px]"
                  />
                </div>
                
                <Select value={estado} onValueChange={setEstado}>
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Estado" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos los estados</SelectItem>
                    {ESTADOS_MACRO_ORDEN.map((m) => (
                      <SelectItem key={m} value={m}>{ESTADO_MACRO_META[m].label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                
                <Select value={sedeId} onValueChange={setSedeId}>
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Sede" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todas las sedes</SelectItem>
                    {sedes?.map(sede => (
                      <SelectItem key={sede.id} value={sede.id.toString()}>{sede.nombre}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px]">Hora</TableHead>
                  <TableHead>Paciente</TableHead>
                  <TableHead>Profesional / Turnera</TableHead>
                  <TableHead>Modalidad</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="text-right">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell><Skeleton className="h-4 w-12" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-40" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                      <TableCell><Skeleton className="h-6 w-24 rounded-full" /></TableCell>
                      <TableCell><Skeleton className="h-8 w-8 ml-auto" /></TableCell>
                    </TableRow>
                  ))
                ) : turnos.length > 0 ? (
                  turnos.map((turno) => (
                    <TableRow key={turno.id}>
                      <TableCell className="font-medium">
                        {turno.horaInicio.substring(0, 5)}
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{turno.paciente?.apellido}, {turno.paciente?.nombre}</div>
                        <div className="text-xs text-muted-foreground">DNI: {turno.paciente?.dni}</div>
                      </TableCell>
                      <TableCell>
                        <div>{turno.profesional ? `${turno.profesional.nombre} ${turno.profesional.apellido}` : 'Sin profesional asignado'}</div>
                        <div className="text-xs text-muted-foreground">{turno.turnera?.nombre}</div>
                      </TableCell>
                      <TableCell>
                        <span className="capitalize">{turno.modalidad}</span>
                        {turno.sobreturn && <span className="ml-2 text-xs font-semibold text-amber-600 bg-amber-100 px-1.5 py-0.5 rounded">Sobreturno</span>}
                      </TableCell>
                      <TableCell>
                        <StatusMacroBadge estado={turno.estado} conDetalle />
                      </TableCell>
                      <TableCell className="text-right">
                        <Link href={`/turnos/${turno.id}`}>
                          <Button variant="ghost" size="sm">Ver</Button>
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center">
                      No se encontraron turnos.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
