import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { limpiarOrdenesTest } from "@/api/ordenes-practicas";
import {
  useGetRecepcionOrdenesEstudio,
  useGetRecepcionOrdenesPendientes,
  type RecepcionOrdenEstudio,
} from "@workspace/api-client-react";
import { abrirPdfOrdenMedico } from "@/pages/recepcion/ordenes";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import {
  Plus,
  FileText,
  X,
  Loader2,
  Search,
  Trash2,
  ClipboardList,
  CalendarCheck2,
} from "lucide-react";

// "2026-08-01" → "01/08"
function fechaCorta(f: string): string {
  const [, mes, dia] = f.split("-");
  return `${dia}/${mes}`;
}

export default function OrdenesMedicasList() {
  const qc = useQueryClient();
  const [dniFiltro, setDniFiltro] = useState("");
  // Espera a que se termine de tipear el DNI antes de consultar
  const [dniBusqueda, setDniBusqueda] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDniBusqueda(dniFiltro.trim()), 350);
    return () => clearTimeout(t);
  }, [dniFiltro]);

  const { toast } = useToast();
  const { user } = useAuth();
  // El módulo de gestión de órdenes es de administración/recepción. Los médicos
  // generan órdenes desde su espacio (/ordenes/nueva), pero no gestionan la lista.
  const accesoRestringido = user?.rol === "medico";

  // Órdenes de estudios que los médicos generan desde el consultorio
  // (study orders). El backend solo las expone a admin/recepcionista.
  const puedeVerOrdenesMedico = user?.rol === "admin" || user?.rol === "recepcionista";
  const dniValido = dniBusqueda.replace(/\D/g, "").length >= 6;
  const { data: ordenesMedicoDni, error: errorOrdenesDni } = useGetRecepcionOrdenesEstudio(
    { dni: dniBusqueda.replace(/\D/g, "") },
    { query: { enabled: puedeVerOrdenesMedico && dniValido, retry: false } },
  );
  const { data: ordenesMedicoGlobal } = useGetRecepcionOrdenesPendientes({
    query: { enabled: puedeVerOrdenesMedico && !dniValido, retry: false },
  });
  // 404 = el DNI buscado no corresponde a ningún paciente activo
  const pacienteNoEncontrado = dniValido && errorOrdenesDni instanceof Error && /404|no encontrado/i.test(errorOrdenesDni.message);
  const ordenesMedico: Array<{ orden: RecepcionOrdenEstudio; pacienteNombre: string; pacienteDni: string | null }> =
    dniValido
      ? (ordenesMedicoDni?.ordenes ?? []).map((o) => ({
          orden: o,
          pacienteNombre: `${ordenesMedicoDni!.paciente.apellido}, ${ordenesMedicoDni!.paciente.nombre}`,
          pacienteDni: ordenesMedicoDni!.paciente.dni ?? null,
        }))
      : (ordenesMedicoGlobal ?? []).map((o) => ({
          orden: o,
          pacienteNombre: `${o.paciente.apellido}, ${o.paciente.nombre}`,
          pacienteDni: o.paciente.dni ?? null,
        }));

  const limpiarTestMutation = useMutation({
    mutationFn: limpiarOrdenesTest,
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["ordenes-practicas"] });
      toast({
        title: res.ordenesEliminadas === 0 ? "No hay órdenes TEST" : "Órdenes TEST eliminadas",
        description:
          res.ordenesEliminadas === 0
            ? "No quedan órdenes de prueba para borrar"
            : `Se borraron ${res.ordenesEliminadas} órdenes y ${res.turnosEliminados} turnos de prueba`,
      });
    },
    onError: (e: Error) =>
      toast({ title: "Error al borrar órdenes TEST", description: e.message, variant: "destructive" }),
  });

  if (accesoRestringido) {
    return (
      <div className="py-16 text-center text-muted-foreground" data-testid="ordenes-acceso-restringido">
        <ClipboardList className="w-10 h-10 mx-auto mb-3 opacity-40" />
        <p className="font-medium">Acceso restringido</p>
        <p className="text-sm">
          La gestión de órdenes está disponible solo para administración y recepción.
        </p>
        <p className="text-sm mt-1">
          Para generar una orden médica, usá{" "}
          <Link href="/ordenes/nueva" className="text-primary underline underline-offset-2">
            Nueva orden
          </Link>{" "}
          desde tu espacio de consulta.
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <ClipboardList className="h-6 w-6 text-blue-600" />
            Órdenes pedidas por los médicos
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Estudios solicitados desde el consultorio: abrí la orden y cargá el turno por agenda
          </p>
        </div>
        <div className="flex items-center gap-2">
          {user?.rol === "admin" && (
            <Button
              variant="outline"
              className="gap-2 text-red-600 dark:text-red-400 border-red-200 dark:border-red-900 hover:bg-red-50 dark:hover:bg-red-950"
              onClick={() => limpiarTestMutation.mutate()}
              disabled={limpiarTestMutation.isPending}
              data-testid="button-limpiar-test"
            >
              {limpiarTestMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              Borrar órdenes TEST
            </Button>
          )}
          <Link href="/ordenes/nueva">
            <Button className="gap-2">
              <Plus className="h-4 w-4" />
              Nueva orden
            </Button>
          </Link>
        </div>
      </div>

      {/* Búsqueda por DNI */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative">
          <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            className="w-48 pl-8"
            inputMode="numeric"
            value={dniFiltro}
            onChange={(e) => setDniFiltro(e.target.value)}
            placeholder="DNI del paciente"
            data-testid="input-filtro-dni"
          />
          {dniFiltro && (
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setDniFiltro("")}
              aria-label="Limpiar DNI"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Listado */}
      {ordenesMedico.length === 0 ? (
        <div className="border rounded-lg bg-card py-8 text-center text-sm text-muted-foreground/70" data-testid="ordenes-medico-vacio">
          {pacienteNoEncontrado
            ? "No hay ningún paciente activo con ese DNI"
            : dniValido
              ? "El paciente no tiene órdenes de médicos pendientes"
              : "No hay órdenes de médicos pendientes"}
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden bg-card">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted">
                <TableHead>Estudio</TableHead>
                <TableHead>Paciente</TableHead>
                <TableHead>Médico</TableHead>
                <TableHead className="w-32">Pedida el</TableHead>
                <TableHead className="w-36">Estado</TableHead>
                <TableHead className="w-40">Turno</TableHead>
                <TableHead className="w-32">Orden</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ordenesMedico.map(({ orden, pacienteNombre, pacienteDni }) => (
                <TableRow key={`sm-${orden.id}`} data-testid={`row-orden-medico-${orden.id}`}>
                  <TableCell>
                    <div className="font-medium text-sm">{orden.studyName}</div>
                    <div className="text-xs text-muted-foreground/70 capitalize">{orden.studyType}</div>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium text-sm">{pacienteNombre}</div>
                    {pacienteDni && <div className="text-xs text-muted-foreground/70">DNI {pacienteDni}</div>}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{orden.derivante ?? "—"}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {orden.createdAt ? orden.createdAt.slice(0, 10) : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge className="text-xs font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300">
                      {orden.turnoId ? "Programada" : "Pendiente de turno"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {orden.turnoId && orden.turnoFecha ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 dark:text-green-300">
                        <CalendarCheck2 className="h-3.5 w-3.5" />
                        {fechaCorta(orden.turnoFecha)} {orden.turnoHora?.substring(0, 5)}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground/70">Sin turno</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1 text-xs"
                      onClick={() => void abrirPdfOrdenMedico(orden.id, (msg) => toast({ title: "Error", description: msg, variant: "destructive" }))}
                      data-testid={`button-ver-orden-medico-${orden.id}`}
                    >
                      <FileText className="h-3.5 w-3.5" />
                      Ver orden
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
