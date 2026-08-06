import { useState } from "react";
import { Link, useParams } from "wouter";
import {
  useGetPaciente,
  useUpdatePaciente,
  useInactivarPaciente,
  useReactivarPaciente,
  useGetPacienteTurnos,
  useGetContactoEmergencia,
  useCreateContactoEmergencia,
  useDeleteContactoEmergencia,
  useGetDocumentosPaciente,
  useCreateDocumentoPaciente,
  useDeleteDocumentoPaciente,
  useGetGrupoFamiliar,
  useCreateGrupoFamiliarVinculo,
  useDeleteGrupoFamiliarVinculo,
  useGetAuditoriaPaciente,
  useGetMe,
  useGetLinksIngresoPaciente,
  useRevocarLinksIngresoPaciente,
  useGetPatientPrescriptions,
  useGetPatientCertificates,
  getGetLinksIngresoPacienteQueryKey,
  getGetAuditoriaPacienteQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ArrowLeft,
  UserCircle,
  Phone,
  Mail,
  MapPin,
  Activity,
  Heart,
  Shield,
  Users,
  FileText,
  Calendar,
  History,
  Plus,
  Trash2,
  Pencil,
  CheckCircle,
  Ban,
  ExternalLink,
  Printer,
  Loader2,
  ClipboardList,
} from "lucide-react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { useToast } from "@/hooks/use-toast";

export default function PacienteDetail() {
  const { id } = useParams<{ id: string }>();
  const pacienteId = Number(id);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [editando, setEditando] = useState(false);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [confirmandoBaja, setConfirmandoBaja] = useState(false);

  const [dialogContacto, setDialogContacto] = useState(false);
  const [formContacto, setFormContacto] = useState({ nombre: "", apellido: "", relacion: "", telefono: "", telefonoAlternativo: "", observaciones: "" });

  const [dialogDocumento, setDialogDocumento] = useState(false);
  const [formDocumento, setFormDocumento] = useState({ nombre: "", tipo: "", descripcion: "", url: "", fuente: "" });

  const [dialogFamiliar, setDialogFamiliar] = useState(false);
  const [formFamiliar, setFormFamiliar] = useState({ nombre: "", apellido: "", relacion: "", dni: "", fechaNacimiento: "", telefono: "", observaciones: "" });

  const { data: paciente, isLoading } = useGetPaciente(pacienteId, {
    query: { enabled: !!pacienteId },
  });
  const { data: turnos } = useGetPacienteTurnos(pacienteId, {
    query: { enabled: !!pacienteId },
  });
  const { data: contactos } = useGetContactoEmergencia(pacienteId, {
    query: { enabled: !!pacienteId },
  });
  const { data: documentos } = useGetDocumentosPaciente(pacienteId, {
    query: { enabled: !!pacienteId },
  });
  const { data: familiar } = useGetGrupoFamiliar(pacienteId, {
    query: { enabled: !!pacienteId },
  });
  const { data: auditoria } = useGetAuditoriaPaciente(pacienteId, {
    query: { enabled: !!pacienteId },
  });

  // ── Links de ingreso (autologin permanente): solo gestión (rol admin) ──
  const { data: me } = useGetMe();
  const esGestion = me?.rol === "admin";
  const { data: linksIngreso } = useGetLinksIngresoPaciente(pacienteId, {
    query: { enabled: !!pacienteId && esGestion },
  });
  const revocarLinks = useRevocarLinksIngresoPaciente();
  const [confirmandoAnularLinks, setConfirmandoAnularLinks] = useState(false);
  const anularLinksIngreso = () => {
    revocarLinks.mutate(
      { id: pacienteId },
      {
        onSuccess: (r) => {
          toast({
            title: "Links anulados",
            description: `Se anularon ${r.revocados} link(s) de ingreso. El paciente necesitará uno nuevo para entrar a la app.`,
          });
          queryClient.invalidateQueries({ queryKey: getGetLinksIngresoPacienteQueryKey(pacienteId) });
          queryClient.invalidateQueries({ queryKey: getGetAuditoriaPacienteQueryKey(pacienteId) });
          setConfirmandoAnularLinks(false);
        },
        onError: () => {
          toast({ title: "No se pudieron anular los links", variant: "destructive" });
          setConfirmandoAnularLinks(false);
        },
      },
    );
  };

  const updateMutation = useUpdatePaciente();
  const inactivarMutation = useInactivarPaciente();
  const reactivarMutation = useReactivarPaciente();
  const createContactoMutation = useCreateContactoEmergencia();
  const deleteContactoMutation = useDeleteContactoEmergencia();
  const createDocumentoMutation = useCreateDocumentoPaciente();
  const deleteDocumentoMutation = useDeleteDocumentoPaciente();
  const createFamiliarMutation = useCreateGrupoFamiliarVinculo();
  const deleteFamiliarMutation = useDeleteGrupoFamiliarVinculo();

  function invalidar() {
    void queryClient.invalidateQueries({ queryKey: [`/pacientes/${pacienteId}`] });
    void queryClient.invalidateQueries({ queryKey: ["/pacientes"] });
  }

  function abrirEdicion() {
    if (!paciente) return;
    setEditForm({
      nombre: paciente.nombre ?? "",
      apellido: paciente.apellido ?? "",
      dni: paciente.dni ?? "",
      fechaNacimiento: paciente.fechaNacimiento ?? "",
      sexo: paciente.sexo ?? "",
      estadoCivil: paciente.estadoCivil ?? "",
      nacionalidad: paciente.nacionalidad ?? "",
      grupoSanguineo: paciente.grupoSanguineo ?? "",
      telefono: paciente.telefono ?? "",
      telefonoAlternativo: paciente.telefonoAlternativo ?? "",
      email: paciente.email ?? "",
      direccion: paciente.direccion ?? "",
      localidad: paciente.localidad ?? "",
      provincia: paciente.provincia ?? "",
      codigoPostal: paciente.codigoPostal ?? "",
      cobertura: paciente.cobertura ?? "",
      planCobertura: paciente.planCobertura ?? "",
      nroAfiliado: paciente.nroAfiliado ?? "",
      observaciones: paciente.observaciones ?? "",
      observacionesAdmin: paciente.observacionesAdmin ?? "",
    });
    setEditando(true);
  }

  function guardarEdicion() {
    const changes: Record<string, string | undefined> = {};
    Object.entries(editForm).forEach(([k, v]) => {
      const orig = (paciente as unknown as Record<string, unknown>)?.[k];
      if (v !== (orig ?? "")) changes[k] = v || undefined;
    });
    updateMutation.mutate(
      { id: pacienteId, data: changes as Parameters<typeof updateMutation.mutate>[0]["data"] },
      {
        onSuccess: () => {
          toast({ title: "Paciente actualizado" });
          setEditando(false);
          invalidar();
        },
        onError: () => toast({ title: "Error al guardar", variant: "destructive" }),
      }
    );
  }

  function handleBajaReactivar() {
    if (!paciente) return;
    if (paciente.activo) {
      inactivarMutation.mutate(
        { id: pacienteId },
        {
          onSuccess: () => { toast({ title: "Paciente dado de baja" }); invalidar(); setConfirmandoBaja(false); },
        }
      );
    } else {
      reactivarMutation.mutate(
        { id: pacienteId },
        {
          onSuccess: () => { toast({ title: "Paciente reactivado" }); invalidar(); },
        }
      );
    }
  }

  if (isLoading) {
    return (
      <div className="p-8 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-[500px] w-full" />
      </div>
    );
  }

  if (!paciente) {
    return (
      <div className="p-8">
        <p className="text-muted-foreground">Paciente no encontrado.</p>
        <Link href="/pacientes">
          <Button variant="outline" className="mt-4">
            <ArrowLeft className="w-4 h-4 mr-2" /> Volver
          </Button>
        </Link>
      </div>
    );
  }

  const edad = paciente.fechaNacimiento
    ? Math.floor(
        (Date.now() - new Date(paciente.fechaNacimiento + "T12:00:00").getTime()) /
          (1000 * 60 * 60 * 24 * 365.25)
      )
    : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          <Link href="/pacientes">
            <Button variant="outline" size="icon">
              <ArrowLeft className="w-4 h-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-3xl font-bold tracking-tight">
                {paciente.apellido}, {paciente.nombre}
              </h1>
              {paciente.numeroHc && (
                <span className="font-mono text-sm bg-primary/10 text-primary px-2 py-0.5 rounded font-semibold">
                  {paciente.numeroHc}
                </span>
              )}
              {paciente.activo ? (
                <Badge variant="outline" className="text-green-700 border-green-300 bg-green-50">
                  Activo
                </Badge>
              ) : (
                <Badge variant="outline" className="text-red-700 border-red-300 bg-red-50">
                  Inactivo
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground text-sm mt-0.5">
              {paciente.dni ? `DNI ${paciente.dni}` : "Sin DNI"}
              {edad !== null ? ` · ${edad} años` : ""}
              {paciente.sexo ? ` · Sexo: ${paciente.sexo === "M" ? "Masculino" : paciente.sexo === "F" ? "Femenino" : "Otro"}` : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link href={`/pacientes/${pacienteId}/hce`}>
            <Button variant="default" className="gap-2">
              <Activity className="w-4 h-4" />
              Historia Clínica
              <ExternalLink className="w-3 h-3" />
            </Button>
          </Link>
          <Button variant="outline" onClick={abrirEdicion}>
            <Pencil className="w-4 h-4 mr-2" />
            Editar
          </Button>
          {paciente.activo ? (
            <Button
              variant="outline"
              className="text-destructive border-destructive/30"
              onClick={() => setConfirmandoBaja(true)}
            >
              <Ban className="w-4 h-4 mr-2" />
              Dar de baja
            </Button>
          ) : (
            <Button
              variant="outline"
              className="text-green-700 border-green-300"
              onClick={handleBajaReactivar}
            >
              <CheckCircle className="w-4 h-4 mr-2" />
              Reactivar
            </Button>
          )}
        </div>
      </div>

      {/* Tabs principales */}
      <Tabs defaultValue="datos">
        <TabsList className="flex flex-wrap h-auto gap-1">
          <TabsTrigger value="datos">
            <UserCircle className="w-4 h-4 mr-1.5" />
            Datos
          </TabsTrigger>
          <TabsTrigger value="cobertura">
            <Shield className="w-4 h-4 mr-1.5" />
            Cobertura
          </TabsTrigger>
          <TabsTrigger value="contacto">
            <Heart className="w-4 h-4 mr-1.5" />
            Contacto emerg.
          </TabsTrigger>
          <TabsTrigger value="familiar">
            <Users className="w-4 h-4 mr-1.5" />
            Grupo familiar
          </TabsTrigger>
          <TabsTrigger value="documentos">
            <FileText className="w-4 h-4 mr-1.5" />
            Documentos
          </TabsTrigger>
          <TabsTrigger value="documentacion">
            <ClipboardList className="w-4 h-4 mr-1.5" />
            Documentación
          </TabsTrigger>
          <TabsTrigger value="turnos">
            <Calendar className="w-4 h-4 mr-1.5" />
            Turnos
          </TabsTrigger>
          <TabsTrigger value="auditoria">
            <History className="w-4 h-4 mr-1.5" />
            Auditoría
          </TabsTrigger>
        </TabsList>

        {/* ── Datos Personales ── */}
        <TabsContent value="datos" className="pt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Datos personales</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-x-8 gap-y-4 text-sm">
                <DataRow label="Nombre" value={paciente.nombre} />
                <DataRow label="Apellido" value={paciente.apellido} />
                <DataRow
                  label="Fecha de nacimiento"
                  value={
                    paciente.fechaNacimiento
                      ? format(new Date(paciente.fechaNacimiento + "T12:00:00"), "dd/MM/yyyy")
                      : null
                  }
                />
                <DataRow
                  label="Sexo"
                  value={
                    paciente.sexo === "M"
                      ? "Masculino"
                      : paciente.sexo === "F"
                      ? "Femenino"
                      : paciente.sexo
                  }
                />
                <DataRow label="Estado civil" value={paciente.estadoCivil} />
                <DataRow label="Nacionalidad" value={paciente.nacionalidad} />
                <DataRow label="Grupo sanguíneo" value={paciente.grupoSanguineo} />
                <div className="col-span-full border-t my-1" />
                <DataRow
                  label="Teléfono principal"
                  value={paciente.telefono}
                  icon={<Phone className="w-3.5 h-3.5" />}
                />
                <DataRow
                  label="Teléfono alternativo"
                  value={paciente.telefonoAlternativo}
                  icon={<Phone className="w-3.5 h-3.5" />}
                />
                <DataRow
                  label="Email"
                  value={paciente.email}
                  icon={<Mail className="w-3.5 h-3.5" />}
                />
                <div className="col-span-full border-t my-1" />
                <DataRow
                  label="Dirección"
                  value={paciente.direccion}
                  icon={<MapPin className="w-3.5 h-3.5" />}
                />
                <DataRow label="Localidad" value={paciente.localidad} />
                <DataRow label="Provincia" value={paciente.provincia} />
                <DataRow label="CP" value={paciente.codigoPostal} />
                {paciente.observaciones && (
                  <div className="col-span-full">
                    <span className="text-muted-foreground">Observaciones:</span>
                    <p className="mt-1 bg-muted/50 rounded p-2 text-sm">
                      {paciente.observaciones}
                    </p>
                  </div>
                )}
                {paciente.observacionesAdmin && (
                  <div className="col-span-full">
                    <span className="text-muted-foreground text-xs uppercase tracking-wide">
                      Nota interna (admin):
                    </span>
                    <p className="mt-1 bg-yellow-50 border border-yellow-200 rounded p-2 text-sm">
                      {paciente.observacionesAdmin}
                    </p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Cobertura ── */}
        <TabsContent value="cobertura" className="pt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Datos de cobertura</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid sm:grid-cols-2 gap-x-8 gap-y-4 text-sm">
                <DataRow label="Obra social / prepaga" value={paciente.cobertura} />
                <DataRow label="Plan" value={paciente.planCobertura} />
                <DataRow label="Número de afiliado" value={paciente.nroAfiliado} />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Contacto de emergencia ── */}
        <TabsContent value="contacto" className="pt-4 space-y-4">
          <div className="flex justify-between items-center">
            <p className="text-sm text-muted-foreground">
              {contactos?.length ?? 0} contacto
              {(contactos?.length ?? 0) !== 1 ? "s" : ""} registrado
              {(contactos?.length ?? 0) !== 1 ? "s" : ""}
            </p>
            <Button size="sm" onClick={() => setDialogContacto(true)}>
              <Plus className="w-4 h-4 mr-1.5" />
              Agregar contacto
            </Button>
          </div>
          {contactos && contactos.length > 0 ? (
            <div className="space-y-3">
              {contactos.map((c) => (
                <Card key={c.id}>
                  <CardContent className="p-4 flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <p className="font-medium">
                        {c.apellido ? `${c.apellido}, ${c.nombre}` : c.nombre}
                        {c.relacion && (
                          <span className="ml-2 text-xs text-muted-foreground font-normal">
                            ({c.relacion})
                          </span>
                        )}
                      </p>
                      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <Phone className="w-3.5 h-3.5" />
                        {c.telefono}
                        {c.telefonoAlternativo && (
                          <span className="ml-2">/ {c.telefonoAlternativo}</span>
                        )}
                      </div>
                      {c.observaciones && (
                        <p className="text-xs text-muted-foreground">
                          {c.observaciones}
                        </p>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-destructive shrink-0"
                      onClick={() =>
                        deleteContactoMutation.mutate(
                          { id: pacienteId, contactoId: c.id },
                          {
                            onSuccess: () => {
                              toast({ title: "Contacto eliminado" });
                              void queryClient.invalidateQueries({
                                queryKey: [`/pacientes/${pacienteId}/contacto-emergencia`],
                              });
                            },
                          }
                        )
                      }
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <EmptyState mensaje="No hay contactos de emergencia registrados." />
          )}
        </TabsContent>

        {/* ── Grupo familiar ── */}
        <TabsContent value="familiar" className="pt-4 space-y-4">
          <div className="flex justify-between items-center">
            <p className="text-sm text-muted-foreground">
              {familiar?.length ?? 0} vínculo
              {(familiar?.length ?? 0) !== 1 ? "s" : ""} registrado
              {(familiar?.length ?? 0) !== 1 ? "s" : ""}
            </p>
            <Button size="sm" onClick={() => setDialogFamiliar(true)}>
              <Plus className="w-4 h-4 mr-1.5" />
              Agregar vínculo
            </Button>
          </div>
          {familiar && familiar.length > 0 ? (
            <div className="space-y-3">
              {familiar.map((v) => (
                <Card key={v.id}>
                  <CardContent className="p-4 flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <p className="font-medium">
                        {v.apellido ? `${v.apellido}, ${v.nombre}` : v.nombre}
                        <span className="ml-2 text-xs text-muted-foreground font-normal">
                          ({v.relacion})
                        </span>
                      </p>
                      <div className="flex gap-4 text-sm text-muted-foreground flex-wrap">
                        {v.dni && <span>DNI: {v.dni}</span>}
                        {v.fechaNacimiento && (
                          <span>
                            Nac:{" "}
                            {format(
                              new Date(v.fechaNacimiento + "T12:00:00"),
                              "dd/MM/yyyy"
                            )}
                          </span>
                        )}
                        {v.telefono && (
                          <span className="flex items-center gap-1">
                            <Phone className="w-3 h-3" />
                            {v.telefono}
                          </span>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-destructive shrink-0"
                      onClick={() =>
                        deleteFamiliarMutation.mutate(
                          { id: pacienteId, vinculoId: v.id },
                          {
                            onSuccess: () => {
                              toast({ title: "Vínculo eliminado" });
                              void queryClient.invalidateQueries({
                                queryKey: [`/pacientes/${pacienteId}/grupo-familiar`],
                              });
                            },
                          }
                        )
                      }
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <EmptyState mensaje="No hay vínculos familiares registrados." />
          )}
        </TabsContent>

        {/* ── Documentos ── */}
        <TabsContent value="documentos" className="pt-4 space-y-4">
          <div className="flex justify-between items-center">
            <p className="text-sm text-muted-foreground">
              {documentos?.length ?? 0} documento
              {(documentos?.length ?? 0) !== 1 ? "s" : ""}
            </p>
            <Button size="sm" onClick={() => setDialogDocumento(true)}>
              <Plus className="w-4 h-4 mr-1.5" />
              Agregar documento
            </Button>
          </div>
          {documentos && documentos.length > 0 ? (
            <div className="space-y-3">
              {documentos.map((d) => (
                <Card key={d.id}>
                  <CardContent className="p-4 flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <p className="font-medium">{d.nombre}</p>
                      <div className="flex gap-3 text-xs text-muted-foreground flex-wrap">
                        {d.tipo && <span className="capitalize">{d.tipo}</span>}
                        {d.fuente && <span>Origen: {d.fuente}</span>}
                        {d.createdAt && (
                          <span>
                            {format(new Date(d.createdAt), "dd/MM/yyyy")}
                          </span>
                        )}
                      </div>
                      {d.descripcion && (
                        <p className="text-sm text-muted-foreground">
                          {d.descripcion}
                        </p>
                      )}
                      {d.url && (
                        <a
                          href={d.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                        >
                          Ver documento
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-destructive shrink-0"
                      onClick={() =>
                        deleteDocumentoMutation.mutate(
                          { id: pacienteId, docId: d.id },
                          {
                            onSuccess: () => {
                              toast({ title: "Documento eliminado" });
                              void queryClient.invalidateQueries({
                                queryKey: [`/pacientes/${pacienteId}/documentos`],
                              });
                            },
                          }
                        )
                      }
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <EmptyState mensaje="No hay documentos adjuntos registrados." />
          )}
        </TabsContent>

        {/* ── Documentación (certificados y recetas para imprimir) ── */}
        <TabsContent value="documentacion" className="pt-4">
          <DocumentacionTab pacienteId={pacienteId} />
        </TabsContent>

        {/* ── Turnos ── */}
        <TabsContent value="turnos" className="pt-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            {turnos?.length ?? 0} turno
            {(turnos?.length ?? 0) !== 1 ? "s" : ""} en el historial
          </p>
          {turnos && turnos.length > 0 ? (
            <div className="space-y-2">
              {turnos.map((t) => (
                <Card key={t.id}>
                  <CardContent className="p-3 flex items-center justify-between gap-4">
                    <div>
                      <p className="font-medium text-sm">
                        {format(
                          new Date(t.fecha),
                          "EEEE d MMM yyyy",
                          { locale: es }
                        )}{" "}
                        — {t.horaInicio}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t.turnera?.especialidad?.nombre ?? "Sin especialidad"}
                        {" · "}
                        {t.profesional?.apellido
                          ? `Dr/a. ${t.profesional.apellido}`
                          : "Sin profesional"}
                      </p>
                    </div>
                    <Badge variant="outline" className="capitalize">
                      {t.estado}
                    </Badge>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <EmptyState mensaje="No hay turnos en el historial." />
          )}
        </TabsContent>

        {/* ── Auditoría ── */}
        <TabsContent value="auditoria" className="pt-4 space-y-3">
          {esGestion && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">Links de ingreso a la app</CardTitle>
                {linksIngreso && linksIngreso.length > 0 && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setConfirmandoAnularLinks(true)}
                    data-testid="button-anular-links-ingreso"
                  >
                    <Ban className="h-4 w-4 mr-1" />
                    Anular links
                  </Button>
                )}
              </CardHeader>
              <CardContent>
                {linksIngreso && linksIngreso.length > 0 ? (
                  <div className="space-y-2">
                    {linksIngreso.map((l, i) => (
                      <div key={i} className="flex flex-wrap gap-x-4 gap-y-1 text-sm border-b pb-2 last:border-0" data-testid={`row-link-ingreso-${i}`}>
                        <span>
                          <span className="text-muted-foreground">Creado:</span>{" "}
                          {format(new Date(l.creadoEn), "dd/MM/yy HH:mm")}
                        </span>
                        <span>
                          <span className="text-muted-foreground">Usos:</span> {l.usos}
                        </span>
                        <span>
                          <span className="text-muted-foreground">Último uso:</span>{" "}
                          {l.ultimoUsoEn ? format(new Date(l.ultimoUsoEn), "dd/MM/yy HH:mm") : "nunca"}
                        </span>
                        <span className="text-xs text-muted-foreground self-center">
                          por {l.generadoPorEmail}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    El paciente no tiene links de ingreso vigentes.
                  </p>
                )}
              </CardContent>
            </Card>
          )}
          {auditoria && auditoria.length > 0 ? (
            auditoria.map((a) => (
              <div
                key={a.id}
                className="flex gap-3 text-sm border-b pb-3 last:border-0"
              >
                <div className="text-xs text-muted-foreground w-32 shrink-0 pt-0.5">
                  {format(new Date(a.createdAt), "dd/MM/yy HH:mm")}
                </div>
                <div className="flex-1">
                  <span className="font-medium uppercase tracking-wide text-xs text-primary">
                    {a.accion}
                  </span>
                  {a.camposModificados && (
                    <span className="text-muted-foreground ml-2">
                      · {a.camposModificados}
                    </span>
                  )}
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {a.usuarioEmail}
                  </div>
                </div>
              </div>
            ))
          ) : (
            <EmptyState mensaje="Sin registros de auditoría todavía." />
          )}
        </TabsContent>
      </Tabs>

      {/* ── Modal editar paciente ── */}
      <Dialog open={editando} onOpenChange={setEditando}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Editar datos del paciente</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Nombre" value={editForm.nombre ?? ""} onChange={(v) => setEditForm((f) => ({ ...f, nombre: v }))} />
            <Field label="Apellido" value={editForm.apellido ?? ""} onChange={(v) => setEditForm((f) => ({ ...f, apellido: v }))} />
            <Field label="DNI" value={editForm.dni ?? ""} onChange={(v) => setEditForm((f) => ({ ...f, dni: v }))} />
            <Field label="Fecha nac." type="date" value={editForm.fechaNacimiento ?? ""} onChange={(v) => setEditForm((f) => ({ ...f, fechaNacimiento: v }))} />
            <div className="space-y-1.5">
              <Label>Sexo</Label>
              <Select value={editForm.sexo ?? ""} onValueChange={(v) => setEditForm((f) => ({ ...f, sexo: v }))}>
                <SelectTrigger><SelectValue placeholder="Seleccionar" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="M">Masculino</SelectItem>
                  <SelectItem value="F">Femenino</SelectItem>
                  <SelectItem value="otro">Otro</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Field label="Estado civil" value={editForm.estadoCivil ?? ""} onChange={(v) => setEditForm((f) => ({ ...f, estadoCivil: v }))} />
            <Field label="Nacionalidad" value={editForm.nacionalidad ?? ""} onChange={(v) => setEditForm((f) => ({ ...f, nacionalidad: v }))} />
            <Field label="Grupo sanguíneo" value={editForm.grupoSanguineo ?? ""} onChange={(v) => setEditForm((f) => ({ ...f, grupoSanguineo: v }))} />
            <Field label="Teléfono" value={editForm.telefono ?? ""} onChange={(v) => setEditForm((f) => ({ ...f, telefono: v }))} />
            <Field label="Tel. alternativo" value={editForm.telefonoAlternativo ?? ""} onChange={(v) => setEditForm((f) => ({ ...f, telefonoAlternativo: v }))} />
            <Field label="Email" type="email" value={editForm.email ?? ""} onChange={(v) => setEditForm((f) => ({ ...f, email: v }))} />
            <Field label="Dirección" value={editForm.direccion ?? ""} onChange={(v) => setEditForm((f) => ({ ...f, direccion: v }))} />
            <Field label="Localidad" value={editForm.localidad ?? ""} onChange={(v) => setEditForm((f) => ({ ...f, localidad: v }))} />
            <Field label="Provincia" value={editForm.provincia ?? ""} onChange={(v) => setEditForm((f) => ({ ...f, provincia: v }))} />
            <Field label="CP" value={editForm.codigoPostal ?? ""} onChange={(v) => setEditForm((f) => ({ ...f, codigoPostal: v }))} />
            <Field label="Cobertura" value={editForm.cobertura ?? ""} onChange={(v) => setEditForm((f) => ({ ...f, cobertura: v }))} />
            <Field label="Plan" value={editForm.planCobertura ?? ""} onChange={(v) => setEditForm((f) => ({ ...f, planCobertura: v }))} />
            <Field label="Nro afiliado" value={editForm.nroAfiliado ?? ""} onChange={(v) => setEditForm((f) => ({ ...f, nroAfiliado: v }))} />
            <div className="col-span-2 space-y-1.5">
              <Label>Observaciones</Label>
              <Textarea rows={2} value={editForm.observaciones ?? ""} onChange={(e) => setEditForm((f) => ({ ...f, observaciones: e.target.value }))} />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label>Nota interna (admin)</Label>
              <Textarea rows={2} value={editForm.observacionesAdmin ?? ""} onChange={(e) => setEditForm((f) => ({ ...f, observacionesAdmin: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditando(false)}>Cancelar</Button>
            <Button onClick={guardarEdicion} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? "Guardando..." : "Guardar cambios"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Dialog nuevo contacto de emergencia ── */}
      <Dialog open={dialogContacto} onOpenChange={setDialogContacto}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Nuevo contacto de emergencia</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Nombre *" value={formContacto.nombre} onChange={(v) => setFormContacto((f) => ({ ...f, nombre: v }))} />
            <Field label="Apellido" value={formContacto.apellido} onChange={(v) => setFormContacto((f) => ({ ...f, apellido: v }))} />
            <Field label="Relación" value={formContacto.relacion} onChange={(v) => setFormContacto((f) => ({ ...f, relacion: v }))} placeholder="Ej: madre, esposo" />
            <Field label="Teléfono *" value={formContacto.telefono} onChange={(v) => setFormContacto((f) => ({ ...f, telefono: v }))} />
            <Field label="Tel. alternativo" value={formContacto.telefonoAlternativo} onChange={(v) => setFormContacto((f) => ({ ...f, telefonoAlternativo: v }))} />
            <div className="col-span-2 space-y-1.5">
              <Label>Observaciones</Label>
              <Textarea rows={2} value={formContacto.observaciones} onChange={(e) => setFormContacto((f) => ({ ...f, observaciones: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogContacto(false)}>Cancelar</Button>
            <Button
              disabled={!formContacto.nombre || !formContacto.telefono || createContactoMutation.isPending}
              onClick={() =>
                createContactoMutation.mutate(
                  {
                    id: pacienteId,
                    data: {
                      nombre: formContacto.nombre,
                      ...(formContacto.apellido && { apellido: formContacto.apellido }),
                      ...(formContacto.relacion && { relacion: formContacto.relacion }),
                      telefono: formContacto.telefono,
                      ...(formContacto.telefonoAlternativo && { telefonoAlternativo: formContacto.telefonoAlternativo }),
                      ...(formContacto.observaciones && { observaciones: formContacto.observaciones }),
                    },
                  },
                  {
                    onSuccess: () => {
                      toast({ title: "Contacto agregado" });
                      setDialogContacto(false);
                      setFormContacto({ nombre: "", apellido: "", relacion: "", telefono: "", telefonoAlternativo: "", observaciones: "" });
                      void queryClient.invalidateQueries({ queryKey: [`/pacientes/${pacienteId}/contacto-emergencia`] });
                    },
                  }
                )
              }
            >
              {createContactoMutation.isPending ? "Guardando..." : "Agregar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Dialog nuevo documento ── */}
      <Dialog open={dialogDocumento} onOpenChange={setDialogDocumento}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Nuevo documento</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Field label="Nombre del documento *" value={formDocumento.nombre} onChange={(v) => setFormDocumento((f) => ({ ...f, nombre: v }))} />
            <Field label="Tipo" value={formDocumento.tipo} onChange={(v) => setFormDocumento((f) => ({ ...f, tipo: v }))} placeholder="Ej: DNI, libreta, estudio" />
            <Field label="URL / enlace" value={formDocumento.url} onChange={(v) => setFormDocumento((f) => ({ ...f, url: v }))} placeholder="https://..." />
            <Field label="Fuente / sistema" value={formDocumento.fuente} onChange={(v) => setFormDocumento((f) => ({ ...f, fuente: v }))} />
            <div className="space-y-1.5">
              <Label>Descripción</Label>
              <Textarea rows={2} value={formDocumento.descripcion} onChange={(e) => setFormDocumento((f) => ({ ...f, descripcion: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogDocumento(false)}>Cancelar</Button>
            <Button
              disabled={!formDocumento.nombre || createDocumentoMutation.isPending}
              onClick={() =>
                createDocumentoMutation.mutate(
                  {
                    id: pacienteId,
                    data: {
                      nombre: formDocumento.nombre,
                      ...(formDocumento.tipo && { tipo: formDocumento.tipo }),
                      ...(formDocumento.url && { url: formDocumento.url }),
                      ...(formDocumento.fuente && { fuente: formDocumento.fuente }),
                      ...(formDocumento.descripcion && { descripcion: formDocumento.descripcion }),
                    },
                  },
                  {
                    onSuccess: () => {
                      toast({ title: "Documento agregado" });
                      setDialogDocumento(false);
                      setFormDocumento({ nombre: "", tipo: "", descripcion: "", url: "", fuente: "" });
                      void queryClient.invalidateQueries({ queryKey: [`/pacientes/${pacienteId}/documentos`] });
                    },
                  }
                )
              }
            >
              {createDocumentoMutation.isPending ? "Guardando..." : "Agregar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Dialog nuevo vínculo familiar ── */}
      <Dialog open={dialogFamiliar} onOpenChange={setDialogFamiliar}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Nuevo vínculo familiar</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Nombre *" value={formFamiliar.nombre} onChange={(v) => setFormFamiliar((f) => ({ ...f, nombre: v }))} />
            <Field label="Apellido" value={formFamiliar.apellido} onChange={(v) => setFormFamiliar((f) => ({ ...f, apellido: v }))} />
            <Field label="Relación *" value={formFamiliar.relacion} onChange={(v) => setFormFamiliar((f) => ({ ...f, relacion: v }))} placeholder="Ej: hijo, madre" />
            <Field label="DNI" value={formFamiliar.dni} onChange={(v) => setFormFamiliar((f) => ({ ...f, dni: v }))} />
            <Field label="Fecha nac." type="date" value={formFamiliar.fechaNacimiento} onChange={(v) => setFormFamiliar((f) => ({ ...f, fechaNacimiento: v }))} />
            <Field label="Teléfono" value={formFamiliar.telefono} onChange={(v) => setFormFamiliar((f) => ({ ...f, telefono: v }))} />
            <div className="col-span-2 space-y-1.5">
              <Label>Observaciones</Label>
              <Textarea rows={2} value={formFamiliar.observaciones} onChange={(e) => setFormFamiliar((f) => ({ ...f, observaciones: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogFamiliar(false)}>Cancelar</Button>
            <Button
              disabled={!formFamiliar.nombre || !formFamiliar.relacion || createFamiliarMutation.isPending}
              onClick={() =>
                createFamiliarMutation.mutate(
                  {
                    id: pacienteId,
                    data: {
                      nombre: formFamiliar.nombre,
                      ...(formFamiliar.apellido && { apellido: formFamiliar.apellido }),
                      relacion: formFamiliar.relacion,
                      ...(formFamiliar.dni && { dni: formFamiliar.dni }),
                      ...(formFamiliar.fechaNacimiento && { fechaNacimiento: formFamiliar.fechaNacimiento }),
                      ...(formFamiliar.telefono && { telefono: formFamiliar.telefono }),
                      ...(formFamiliar.observaciones && { observaciones: formFamiliar.observaciones }),
                    },
                  },
                  {
                    onSuccess: () => {
                      toast({ title: "Vínculo agregado" });
                      setDialogFamiliar(false);
                      setFormFamiliar({ nombre: "", apellido: "", relacion: "", dni: "", fechaNacimiento: "", telefono: "", observaciones: "" });
                      void queryClient.invalidateQueries({ queryKey: [`/pacientes/${pacienteId}/grupo-familiar`] });
                    },
                  }
                )
              }
            >
              {createFamiliarMutation.isPending ? "Guardando..." : "Agregar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Confirm baja ── */}
      <AlertDialog open={confirmandoBaja} onOpenChange={setConfirmandoBaja}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Dar de baja al paciente?</AlertDialogTitle>
            <AlertDialogDescription>
              El paciente quedará inactivo pero su historia clínica y datos se
              conservan. Podrás reactivarlo en cualquier momento.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleBajaReactivar}
            >
              Dar de baja
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Confirm anular links de ingreso ── */}
      <AlertDialog open={confirmandoAnularLinks} onOpenChange={setConfirmandoAnularLinks}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Anular los links de ingreso?</AlertDialogTitle>
            <AlertDialogDescription>
              Los links que el paciente tenga guardados (por ejemplo en WhatsApp)
              dejarán de funcionar de inmediato. Para volver a entrar a la app
              necesitará que le generen un link nuevo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={anularLinksIngreso}
              data-testid="button-confirmar-anular-links"
            >
              Anular links
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function DataRow({
  label,
  value,
  icon,
}: {
  label: string;
  value: string | null | undefined;
  icon?: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="font-medium flex items-center gap-1.5 mt-0.5">
        {icon}
        {value || <span className="text-muted-foreground/60 font-normal">—</span>}
      </p>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

function EmptyState({ mensaje }: { mensaje: string }) {
  return (
    <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground text-sm">
      {mensaje}
    </div>
  );
}

// ── Documentación: certificados y recetas del paciente, con impresión ──────

// Descarga el PDF autenticado y abre el diálogo de impresión del navegador
// vía un iframe oculto (un solo click para recepción).
async function imprimirPdf(url: string): Promise<void> {
  const token = localStorage.getItem("auth_token");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`No se pudo obtener el PDF (HTTP ${res.status})`);
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  await new Promise<void>((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.src = blobUrl;
    iframe.onload = () => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
        resolve();
      } catch (e) {
        reject(e instanceof Error ? e : new Error("No se pudo abrir la impresión"));
      }
      // El diálogo de impresión necesita el blob vivo: limpiar recién después.
      setTimeout(() => {
        URL.revokeObjectURL(blobUrl);
        iframe.remove();
      }, 60_000);
    };
    iframe.onerror = () => reject(new Error("No se pudo cargar el PDF"));
    document.body.appendChild(iframe);
  });
}

function BotonImprimir({ url }: { url: string }) {
  const { toast } = useToast();
  const [imprimiendo, setImprimiendo] = useState(false);
  const onClick = async () => {
    setImprimiendo(true);
    try {
      await imprimirPdf(url);
    } catch (e) {
      toast({
        title: "No se pudo imprimir",
        description: e instanceof Error ? e.message : "Error desconocido",
        variant: "destructive",
      });
    } finally {
      setImprimiendo(false);
    }
  };
  return (
    <Button size="sm" variant="outline" onClick={onClick} disabled={imprimiendo} className="gap-1.5 shrink-0">
      {imprimiendo ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Printer className="w-3.5 h-3.5" />}
      Imprimir
    </Button>
  );
}

const TIPO_CERTIFICADO_LABEL: Record<string, string> = {
  reposo: "Reposo",
  asistencia: "Asistencia",
  aptitud: "Aptitud física",
  escolar: "Escolar",
  laboral: "Laboral",
  otro: "Certificado",
};

function DocumentacionTab({ pacienteId }: { pacienteId: number }) {
  const { data: certificados, isLoading: cargandoCert } = useGetPatientCertificates(pacienteId, {
    query: { enabled: !!pacienteId },
  });
  const { data: recetas, isLoading: cargandoRec } = useGetPatientPrescriptions(pacienteId, {
    query: { enabled: !!pacienteId },
  });

  const fechaCorta = (v: string | null | undefined) =>
    v ? format(new Date(v), "dd/MM/yyyy HH:mm", { locale: es }) : "—";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Certificados</CardTitle>
        </CardHeader>
        <CardContent>
          {cargandoCert ? (
            <Skeleton className="h-20 w-full" />
          ) : certificados && certificados.length > 0 ? (
            <div className="space-y-2">
              {certificados.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-4 rounded-lg border p-3">
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">
                      {c.numero ? `${c.numero} — ` : ""}
                      {TIPO_CERTIFICADO_LABEL[c.certificateType ?? ""] ?? c.certificateType ?? "Certificado"}
                      {c.restDays ? ` (${c.restDays} día${c.restDays !== 1 ? "s" : ""} de reposo)` : ""}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {fechaCorta(c.createdAt)}
                      {c.diagnosis ? ` · ${c.diagnosis}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {c.estado !== "valido" && (
                      <Badge variant="outline" className="text-red-700 dark:text-red-300 border-red-300">
                        {c.estado === "revocado" ? "Revocado" : "Reemplazado"}
                      </Badge>
                    )}
                    <BotonImprimir url={`/api/consultorio/certificates/${c.id}/pdf`} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState mensaje="El paciente no tiene certificados emitidos." />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recetas</CardTitle>
        </CardHeader>
        <CardContent>
          {cargandoRec ? (
            <Skeleton className="h-20 w-full" />
          ) : recetas && recetas.length > 0 ? (
            <div className="space-y-2">
              {recetas.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-4 rounded-lg border p-3">
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{r.medication}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {fechaCorta(r.createdAt)}
                      {r.dosage ? ` · ${r.dosage}` : ""}
                      {r.frequency ? ` · ${r.frequency}` : ""}
                    </p>
                  </div>
                  <BotonImprimir url={`/api/consultorio/prescriptions/${r.id}/pdf`} />
                </div>
              ))}
            </div>
          ) : (
            <EmptyState mensaje="El paciente no tiene recetas emitidas." />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
