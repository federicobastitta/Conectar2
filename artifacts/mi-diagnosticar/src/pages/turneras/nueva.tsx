import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";
import {
  useListSedes, useListEspecialidades, useListProfesionales,
  useListObrasSociales, useListNomencladorPracticas, useListSalasLlamado,
  useCreateTurnera, useUpdateTurnera, useDeleteTurnera, useGetTurnera,
  TurneraInputModalidad,
  getListTurnerasQueryKey,
  ApiError,
  type TurneraInput,
  type TurneraDuplicadaAviso,
} from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getPracticasCatalogo } from "@/api/ordenes-practicas";
import { AccesoProfesional } from "./acceso-profesional";

import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { ArrowLeft, Loader2, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const VISIBILIDAD_OPTIONS = [
  { value: "online",     label: "Online (portal pacientes)", desc: "Los pacientes pueden reservar solos desde el portal" },
  { value: "recepcion",  label: "Recepción",                 desc: "Visible para recepcionistas" },
  { value: "callcenter", label: "Call Center",               desc: "Visible para operadoras de call center" },
] as const;

const turneraSchema = z.object({
  nombre:          z.string().min(1, "El nombre es requerido"),
  sedeId:          z.coerce.number().min(1, "La sede es requerida"),
  consultorio:     z.string().optional(),
  salaLlamadoId:   z.number().nullable().optional(),
  especialidadId:  z.coerce.number().optional(),
  profesionalId:   z.coerce.number().optional(),
  duracionMinutos: z.coerce.number().min(5, "Duración mínima 5m"),
  horaInicio:      z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Formato HH:MM"),
  horaFin:         z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Formato HH:MM"),
  modalidad:       z.nativeEnum(TurneraInputModalidad),
  diasAtencion:    z.array(z.number()).min(1, "Seleccione al menos un día"),
  cuposDiarios:    z.coerce.number().optional(),
  sobreturnos:     z.coerce.number().min(0).default(0),
  activa:          z.boolean(),
  esGuardia:       z.boolean(),
  participantesIds: z.array(z.number()).default([]),
  obrasSociales:   z.array(z.object({
    obraSocialId: z.number(),
    cupoDiario:   z.number().nullable(),
  })).default([]),
  practicas:       z.array(z.object({
    codigo:      z.string(),
    descripcion: z.string(),
  })).default([]),
  visibilidades:   z.array(z.enum(["online", "recepcion", "callcenter"])),
  color:           z.string().optional(),
  tipo:            z.enum(["consulta", "practica"]),
  enviaWorklist:   z.enum(["heredar", "si", "no"]),
  llevaInforme:    z.boolean(),
  destinoInforme:  z.enum(["hce", "portal", "whatsapp"]),
  klinicosSector:       z.string().optional(),
  klinicosEspecialidad: z.string().optional(),
  klinicosProfesional:  z.string().optional(),
  klinicosMotivo:       z.string().optional(),
  usaHorariosDia:  z.boolean().default(false),
  horariosDia:     z.array(z.object({
    dia:        z.number(),
    horaInicio: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Formato HH:MM"),
    horaFin:    z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Formato HH:MM"),
  })).default([]),
}).superRefine((v, ctx) => {
  // Guardia (grupal): atención por orden de llegada, sin horarios que validar
  if (v.esGuardia) return;
  if (!v.usaHorariosDia && v.horaFin <= v.horaInicio) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "La hora de fin debe ser posterior a la de inicio", path: ["horaFin"] });
  }
  if (v.usaHorariosDia) {
    for (const d of v.diasAtencion) {
      const h = v.horariosDia.find((x) => x.dia === d);
      if (h && h.horaFin <= h.horaInicio) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Hay días con hora de fin anterior o igual a la de inicio", path: ["horariosDia"] });
        break;
      }
    }
  }
});

type TurneraForm = z.infer<typeof turneraSchema>;

const diasSemana = [
  { id: 1, label: "Lun" },
  { id: 2, label: "Mar" },
  { id: 3, label: "Mié" },
  { id: 4, label: "Jue" },
  { id: 5, label: "Vie" },
  { id: 6, label: "Sáb" },
  { id: 0, label: "Dom" },
];

export default function TurneraNueva() {
  const [, setLocation] = useLocation();
  const params = useParams<{ id?: string }>();
  const turneraId = params.id ? parseInt(params.id) : undefined;
  const isEdit = !!turneraId;

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const esAdmin = user?.rol === "admin";

  const { data: sedes } = useListSedes();
  const { data: salasLlamado } = useListSalasLlamado();
  const { data: especialidades } = useListEspecialidades();
  const { data: profesionales } = useListProfesionales({});
  const { data: obrasSocialesLista } = useListObrasSociales({ activa: true });
  const { data: turneraExistente } = useGetTurnera(turneraId ?? 0);

  // Catálogo de prácticas: alimenta la lista de tipos (ej. tipos de ecografías)
  // según la especialidad elegida.
  const { data: catalogoData } = useQuery({
    queryKey: ["practicas-catalogo", true],
    queryFn: () => getPracticasCatalogo(true),
    staleTime: 5 * 60_000,
  });

  // Autocomplete de prácticas del nomenclador (búsqueda global, sin obra social)
  const [busquedaPractica, setBusquedaPractica] = useState("");
  const { data: sugerenciasPracticas } = useListNomencladorPracticas(
    { buscar: busquedaPractica, limite: 8 },
    { query: { enabled: busquedaPractica.length >= 2 } },
  );

  const form = useForm<TurneraForm>({
    resolver: zodResolver(turneraSchema),
    defaultValues: {
      nombre: "",
      duracionMinutos: 15,
      horaInicio: "08:00",
      horaFin: "18:00",
      modalidad: TurneraInputModalidad.presencial,
      diasAtencion: [1, 2, 3, 4, 5],
      cuposDiarios: undefined,
      sobreturnos: 0,
      activa: true,
      esGuardia: false,
      participantesIds: [],
      obrasSociales: [],
      practicas: [],
      visibilidades: ["recepcion"],
      color: "#3b82f6",
      consultorio: "",
      salaLlamadoId: null,
      tipo: "consulta",
      enviaWorklist: "heredar",
      llevaInforme: false,
      destinoInforme: "hce",
      klinicosSector: "",
      klinicosEspecialidad: "",
      klinicosProfesional: "",
      klinicosMotivo: "",
      usaHorariosDia: false,
      horariosDia: [],
    },
  });

  useEffect(() => {
    if (turneraExistente && isEdit) {
      form.reset({
        nombre:          turneraExistente.nombre,
        sedeId:          turneraExistente.sedeId ?? undefined,
        especialidadId:  turneraExistente.especialidadId ?? undefined,
        profesionalId:   turneraExistente.profesionalId ?? undefined,
        duracionMinutos: turneraExistente.duracionMinutos,
        horaInicio:      (turneraExistente.horaInicio ?? "08:00").substring(0, 5),
        horaFin:         (turneraExistente.horaFin ?? "18:00").substring(0, 5),
        modalidad:       turneraExistente.modalidad as TurneraInputModalidad,
        diasAtencion:    Array.isArray(turneraExistente.diasAtencion) ? turneraExistente.diasAtencion : [],
        cuposDiarios:    turneraExistente.cuposDiarios ?? undefined,
        sobreturnos:     turneraExistente.sobreturnos ?? 0,
        activa:          turneraExistente.activa,
        esGuardia:       turneraExistente.esGuardia ?? false,
        participantesIds: Array.isArray(turneraExistente.participantesIds) ? turneraExistente.participantesIds : [],
        obrasSociales:   Array.isArray(turneraExistente.obrasSociales)
          ? turneraExistente.obrasSociales.map((o) => ({ obraSocialId: o.obraSocialId!, cupoDiario: o.cupoDiario ?? null }))
          : [],
        practicas:       Array.isArray(turneraExistente.practicas)
          ? turneraExistente.practicas.map((p) => ({ codigo: p.codigo, descripcion: p.descripcion ?? "" }))
          : [],
        visibilidades:   ((turneraExistente.visibilidad ?? "recepcion")
          .split(",")
          .map((v) => v.trim())
          .filter((v): v is "online" | "recepcion" | "callcenter" =>
            v === "online" || v === "recepcion" || v === "callcenter")),
        color:           turneraExistente.color ?? "#3b82f6",
        consultorio:     turneraExistente.consultorio ?? "",
        salaLlamadoId:   turneraExistente.salaLlamadoId ?? null,
        tipo:            (turneraExistente.tipo as TurneraForm["tipo"]) ?? "consulta",
        enviaWorklist:   turneraExistente.enviaWorklist == null ? "heredar" : turneraExistente.enviaWorklist ? "si" : "no",
        llevaInforme:    turneraExistente.llevaInforme ?? false,
        destinoInforme:  (turneraExistente.destinoInforme as TurneraForm["destinoInforme"]) ?? "hce",
        klinicosSector:       turneraExistente.klinicosSector ?? "",
        klinicosEspecialidad: turneraExistente.klinicosEspecialidad ?? "",
        klinicosProfesional:  turneraExistente.klinicosProfesional ?? "",
        klinicosMotivo:       turneraExistente.klinicosMotivo ?? "",
        usaHorariosDia:  Array.isArray(turneraExistente.horariosDia) && turneraExistente.horariosDia.length > 0,
        horariosDia:     Array.isArray(turneraExistente.horariosDia)
          ? turneraExistente.horariosDia.map((h) => ({
              dia: h.dia,
              horaInicio: (h.horaInicio ?? "08:00").substring(0, 5),
              horaFin: (h.horaFin ?? "18:00").substring(0, 5),
            }))
          : [],
      });
    }
  }, [turneraExistente, isEdit, form]);

  // Las agendas de práctica deben definir explícitamente si van a la worklist
  // del PACS: "según la especialidad" no es una opción válida para prácticas.
  const tipoActual = form.watch("tipo");
  const enviaWorklistActual = form.watch("enviaWorklist");
  useEffect(() => {
    if (tipoActual === "practica" && enviaWorklistActual === "heredar") {
      form.setValue("enviaWorklist", "si");
    }
  }, [tipoActual, enviaWorklistActual, form]);

  const createMutation = useCreateTurnera();
  const updateMutation = useUpdateTurnera();
  const deleteMutation = useDeleteTurnera();
  const [confirmarEliminar, setConfirmarEliminar] = useState(false);
  // Aviso de agenda duplicada: 409 del POST con los valores para reintentar
  const [avisoDuplicado, setAvisoDuplicado] = useState<{
    aviso: TurneraDuplicadaAviso;
    values: TurneraInput;
  } | null>(null);

  const eliminarTurnera = () => {
    if (!turneraId) return;
    deleteMutation.mutate({ id: turneraId }, {
      onSuccess: () => {
        toast({ title: "Turnera eliminada", description: "La turnera se eliminó correctamente." });
        void queryClient.invalidateQueries({ queryKey: getListTurnerasQueryKey() });
        setLocation("/turneras");
      },
      onError: () => toast({ title: "No se pudo eliminar", description: "Probá de nuevo.", variant: "destructive" }),
    });
  };

  function onSubmit(raw: TurneraForm) {
    // Horarios por día: solo se envían los de los días tildados; si no usa
    // horario por día se manda [] para limpiar cualquier configuración previa.
    const horariosDiaPayload = raw.usaHorariosDia && !raw.esGuardia
      ? raw.diasAtencion.map((d) => {
          const h = raw.horariosDia.find((x) => x.dia === d);
          return { dia: d, horaInicio: h?.horaInicio ?? raw.horaInicio, horaFin: h?.horaFin ?? raw.horaFin };
        })
      : [];
    // Campos Klinicos: vacío = sin vincular (null)
    const { usaHorariosDia: _uhd, visibilidades, ...rawSinFlags } = raw;
    const values = {
      ...rawSinFlags,
      // Grupal: sin médico titular, se listan participantes. Individual: sin participantes.
      profesionalId: raw.esGuardia ? undefined : rawSinFlags.profesionalId,
      // Guardia: sin horario fijo, atiende por orden de llegada todo el día
      horaInicio: raw.esGuardia ? "00:00" : raw.horaInicio,
      horaFin: raw.esGuardia ? "23:59" : raw.horaFin,
      // Solo participantes de la especialidad elegida (si cambió, se descartan los viejos)
      participantesIds: raw.esGuardia
        ? raw.participantesIds.filter((id) =>
            profesionales?.some((p) => p.id === id && p.especialidadId === raw.especialidadId),
          )
        : [],
      horariosDia: horariosDiaPayload,
      // Sin canales tildados = agenda interna (no visible en ningún lado)
      visibilidad: visibilidades.length > 0 ? [...visibilidades].sort().join(",") : "interna",
      // "heredar" = null: usa la configuración de la especialidad (envía al PACS o no)
      enviaWorklist:        raw.enviaWorklist === "heredar" ? null : raw.enviaWorklist === "si",
      klinicosSector:       raw.klinicosSector?.trim() || null,
      klinicosEspecialidad: raw.klinicosEspecialidad?.trim() || null,
      klinicosProfesional:  raw.klinicosProfesional?.trim() || null,
      klinicosMotivo:       raw.klinicosMotivo?.trim() || null,
    };
    const invalidate = () => queryClient.invalidateQueries({ queryKey: getListTurnerasQueryKey() });
    if (isEdit) {
      updateMutation.mutate({ id: turneraId!, data: values }, {
        onSuccess: () => {
          toast({ title: "Turnera actualizada" });
          invalidate();
          setLocation("/turneras");
        },
        onError: () => toast({ title: "Error al actualizar", variant: "destructive" }),
      });
    } else {
      createMutation.mutate({ data: values }, {
        onSuccess: () => {
          toast({ title: "Turnera creada exitosamente" });
          invalidate();
          setLocation("/turneras");
        },
        onError: (error) => {
          // 409 = ya existe una agenda activa igual del mismo profesional:
          // se pide confirmación antes de crear otra (duplicaría el mosaico).
          const data = error instanceof ApiError ? (error.data as TurneraDuplicadaAviso | null) : null;
          if (error instanceof ApiError && error.status === 409 && data?.codigo === "turnera_duplicada") {
            setAvisoDuplicado({ aviso: data, values });
            return;
          }
          toast({ title: "Error al crear", variant: "destructive" });
        },
      });
    }
  }

  const crearIgualmente = () => {
    if (!avisoDuplicado) return;
    const values = { ...avisoDuplicado.values, confirmarDuplicado: true };
    setAvisoDuplicado(null);
    createMutation.mutate({ data: values }, {
      onSuccess: () => {
        toast({ title: "Turnera creada exitosamente" });
        void queryClient.invalidateQueries({ queryKey: getListTurnerasQueryKey() });
        setLocation("/turneras");
      },
      onError: () => toast({ title: "Error al crear", variant: "destructive" }),
    });
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-4">
        <Link href="/turneras">
          <Button variant="outline" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{isEdit ? "Editar Turnera" : "Nueva Turnera"}</h1>
          <p className="text-muted-foreground">Configurar agenda y horarios</p>
        </div>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)}>
          <Card>
            <CardContent className="p-6 space-y-8">
              {/* Sede: primero, para separar lo de cada sede */}
              <div className="space-y-4">
                <h3 className="text-lg font-medium border-b pb-2">Sede</h3>
                <FormField control={form.control} name="sedeId" render={({ field }) => (
                  <FormItem className="max-w-sm">
                    <FormLabel>Sede *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value?.toString()}>
                      <FormControl><SelectTrigger data-testid="select-sede-form"><SelectValue placeholder="Seleccione" /></SelectTrigger></FormControl>
                      <SelectContent>
                        {sedes?.map(s => <SelectItem key={s.id} value={s.id.toString()}>{s.nombre}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <FormDescription>Dónde se atiende esta agenda (ej: Berazategui o Lomas de Zamora)</FormDescription>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              {/* Información General */}
              <div className="space-y-4">
                <h3 className="text-lg font-medium border-b pb-2">Información General</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <FormField control={form.control} name="nombre" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Nombre de Agenda</FormLabel>
                      <FormControl><Input placeholder="Ej: Agenda General" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="color" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Color identificador</FormLabel>
                      <FormControl>
                        <div className="flex gap-2">
                          <Input type="color" className="w-12 h-10 p-1" {...field} />
                          <Input {...field} />
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="consultorio" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Consultorio</FormLabel>
                      <FormControl><Input placeholder="Ej: 3" data-testid="input-consultorio" {...field} /></FormControl>
                      <FormDescription>Número o nombre del consultorio. Se muestra en la TV al llamar al paciente (también en los llamados desde Pixel).</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="salaLlamadoId" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Sala de espera (TV)</FormLabel>
                      <Select
                        onValueChange={(v) => field.onChange(v === "ninguna" ? null : Number(v))}
                        value={field.value != null ? String(field.value) : "ninguna"}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-sala-llamado">
                            <SelectValue placeholder="Sin sala asignada" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="ninguna">Sin sala asignada</SelectItem>
                          {(salasLlamado ?? []).map((s) => (
                            <SelectItem key={s.id} value={String(s.id)}>{s.nombre}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormDescription>La pantalla TV de esa sala muestra a los pacientes en espera de esta agenda (si el médico eligió su propia sala, esa tiene prioridad).</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
              </div>

              {/* Asignaciones */}
              <div className="space-y-4">
                <h3 className="text-lg font-medium border-b pb-2">Asignaciones</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <FormField control={form.control} name="especialidadId" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Especialidad</FormLabel>
                      <FormControl>
                        <Combobox
                          testId="select-especialidad-form"
                          value={field.value?.toString() ?? ""}
                          onChange={field.onChange}
                          placeholder="Buscar especialidad…"
                          options={[...(especialidades ?? [])]
                            .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"))
                            .map(e => ({ value: e.id.toString(), label: e.nombre }))}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  {!form.watch("esGuardia") && (
                    <FormField control={form.control} name="profesionalId" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Profesional</FormLabel>
                        <FormControl>
                          <Combobox
                            testId="select-profesional-form"
                            value={field.value?.toString() ?? ""}
                            onChange={field.onChange}
                            placeholder="Buscar profesional…"
                            options={[...(profesionales ?? [])]
                              .sort((a, b) => `${a.apellido} ${a.nombre}`.localeCompare(`${b.apellido} ${b.nombre}`, "es"))
                              .map(p => ({ value: p.id.toString(), label: `${p.apellido}, ${p.nombre}` }))}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  )}
                </div>

                {/* Agenda grupal: se eligen los profesionales que van a trabajar */}
                {form.watch("esGuardia") && (
                  <FormField control={form.control} name="participantesIds" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Profesionales que van a trabajar</FormLabel>
                      <FormDescription>
                        Tildá los médicos que atienden en esta agenda grupal. Se muestran solo los
                        de la especialidad elegida. Si no tildás ninguno, puede tomar pacientes
                        cualquier profesional de guardia de la especialidad.
                      </FormDescription>
                      {!form.watch("especialidadId") ? (
                        <p className="text-sm text-muted-foreground rounded-lg border p-3">
                          Primero elegí la especialidad para ver los profesionales disponibles.
                        </p>
                      ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 pt-1 max-h-64 overflow-y-auto rounded-lg border p-3">
                        {[...(profesionales ?? [])]
                          .filter((p) => p.especialidadId === Number(form.watch("especialidadId")))
                          .sort((a, b) => `${a.apellido} ${a.nombre}`.localeCompare(`${b.apellido} ${b.nombre}`, "es"))
                          .map((p) => {
                            const tildado = field.value?.includes(p.id);
                            return (
                              <label
                                key={p.id}
                                data-testid={`participante-${p.id}`}
                                className={`flex items-center gap-2 rounded-md border p-2 cursor-pointer text-sm transition-colors ${tildado ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
                              >
                                <Checkbox
                                  checked={tildado}
                                  onCheckedChange={(v) => {
                                    const actual = field.value ?? [];
                                    field.onChange(v ? [...actual, p.id] : actual.filter((id: number) => id !== p.id));
                                  }}
                                />
                                <span>{p.apellido}, {p.nombre}</span>
                              </label>
                            );
                          })}
                      </div>
                      )}
                      <FormMessage />
                    </FormItem>
                  )} />
                )}

                {/* Login del profesional: usuario + contraseña asignados por la clínica (solo admin) */}
                {(() => {
                  const profId = Number(form.watch("profesionalId"));
                  if (!profId) return null;
                  const prof = profesionales?.find((p) => p.id === profId);
                  return (
                    <AccesoProfesional
                      profesionalId={profId}
                      nombreProfesional={prof ? `${prof.nombre} ${prof.apellido}` : "Profesional"}
                    />
                  );
                })()}
              </div>

              {/* Horarios */}
              <div className="space-y-4">
                <h3 className="text-lg font-medium border-b pb-2">Configuración de Horarios</h3>
                <FormField control={form.control} name="diasAtencion" render={() => (
                  <FormItem>
                    <div className="mb-2"><FormLabel>Días de atención</FormLabel></div>
                    <div className="flex flex-wrap gap-3">
                      {diasSemana.map((dia) => (
                        <FormField key={dia.id} control={form.control} name="diasAtencion" render={({ field }) => (
                          <FormItem key={dia.id} className="flex flex-row items-center space-x-2 space-y-0">
                            <FormControl>
                              <Checkbox
                                checked={field.value?.includes(dia.id)}
                                onCheckedChange={(checked) =>
                                  checked
                                    ? field.onChange([...field.value, dia.id])
                                    : field.onChange(field.value?.filter((v) => v !== dia.id))
                                }
                              />
                            </FormControl>
                            <FormLabel className="font-normal">{dia.label}</FormLabel>
                          </FormItem>
                        )} />
                      ))}
                    </div>
                    <FormMessage />
                  </FormItem>
                )} />

                {form.watch("esGuardia") && (
                  <>
                    <p className="text-sm text-muted-foreground rounded-lg border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-200 p-3">
                      Agenda de guardia: se atiende por orden de llegada, sin horarios fijos por turno.
                    </p>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-2">
                      <FormField control={form.control} name="duracionMinutos" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Duración por paciente (min)</FormLabel>
                          <FormControl><Input type="number" min={5} step={5} {...field} /></FormControl>
                          <FormDescription>Se usa para calcular la espera aproximada de la fila.</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                  </>
                )}

                {!form.watch("esGuardia") && (<>
                <FormField control={form.control} name="usaHorariosDia" render={({ field }) => (
                  <FormItem className="flex flex-row items-center gap-3 space-y-0 pt-1">
                    <FormControl>
                      <Checkbox
                        data-testid="checkbox-horarios-por-dia"
                        checked={field.value}
                        onCheckedChange={(checked) => field.onChange(!!checked)}
                      />
                    </FormControl>
                    <div>
                      <FormLabel className="font-normal">Horario distinto según el día</FormLabel>
                      <FormDescription>Cada día de atención tiene su propia hora de inicio y fin.</FormDescription>
                    </div>
                  </FormItem>
                )} />

                {form.watch("usaHorariosDia") && (
                  <FormField control={form.control} name="horariosDia" render={({ field }) => (
                    <FormItem>
                      <div className="space-y-2">
                        {[...form.watch("diasAtencion")].sort((a, b) => a - b).map((d) => {
                          const h = field.value.find((x) => x.dia === d);
                          const inicio = h?.horaInicio ?? form.getValues("horaInicio");
                          const fin = h?.horaFin ?? form.getValues("horaFin");
                          const setHora = (campo: "horaInicio" | "horaFin", valor: string) => {
                            const otros = field.value.filter((x) => x.dia !== d);
                            field.onChange([...otros, { dia: d, horaInicio: inicio, horaFin: fin, [campo]: valor }]);
                          };
                          return (
                            <div key={d} className="flex items-center gap-3">
                              <span className="w-24 text-sm font-medium">{diasSemana.find((x) => x.id === d)?.label ?? d}</span>
                              <Input
                                type="time"
                                className="w-32"
                                data-testid={`input-hora-inicio-dia-${d}`}
                                value={inicio}
                                onChange={(e) => setHora("horaInicio", e.target.value)}
                              />
                              <span className="text-muted-foreground text-sm">a</span>
                              <Input
                                type="time"
                                className="w-32"
                                data-testid={`input-hora-fin-dia-${d}`}
                                value={fin}
                                onChange={(e) => setHora("horaFin", e.target.value)}
                              />
                            </div>
                          );
                        })}
                        {form.watch("diasAtencion").length === 0 && (
                          <p className="text-sm text-muted-foreground">Tildá al menos un día de atención para configurar sus horarios.</p>
                        )}
                      </div>
                      <FormMessage />
                    </FormItem>
                  )} />
                )}

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-2">
                  <FormField control={form.control} name="horaInicio" render={({ field }) => (
                    <FormItem className={form.watch("usaHorariosDia") ? "hidden" : ""}>
                      <FormLabel>Hora Inicio</FormLabel>
                      <FormControl><Input type="time" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="horaFin" render={({ field }) => (
                    <FormItem className={form.watch("usaHorariosDia") ? "hidden" : ""}>
                      <FormLabel>Hora Fin</FormLabel>
                      <FormControl><Input type="time" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="duracionMinutos" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Duración (min)</FormLabel>
                      <FormControl><Input type="number" min={5} step={5} {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="modalidad" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Modalidad</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                        <SelectContent>
                          <SelectItem value="presencial">Presencial</SelectItem>
                          <SelectItem value="videoconsulta">Videoconsulta</SelectItem>
                          <SelectItem value="ambas">Ambas</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
                </>)}
              </div>

              {/* Cupos */}
              <div className="space-y-4">
                <h3 className="text-lg font-medium border-b pb-2">Cupos y Capacidad</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <FormField control={form.control} name="cuposDiarios" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Cupos diarios</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={1}
                          placeholder="Sin límite"
                          value={field.value ?? ""}
                          onChange={(e) => field.onChange(e.target.value === "" ? undefined : Number(e.target.value))}
                        />
                      </FormControl>
                      <FormDescription>Máximo de turnos por día. Vacío = sin límite.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="sobreturnos" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Sobreturnos permitidos</FormLabel>
                      <FormControl><Input type="number" min={0} {...field} /></FormControl>
                      <FormDescription>Turnos extra sobre el límite diario (0 = no permitir).</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
              </div>

              {/* Obras sociales */}
              <div className="space-y-4">
                <h3 className="text-lg font-medium border-b pb-2">Obras sociales que atiende</h3>
                <FormField control={form.control} name="obrasSociales" render={({ field }) => (
                  <FormItem>
                    <FormDescription>
                      Si no marcás ninguna, la agenda atiende todas las obras sociales sin límite.
                      Si marcás alguna, solo se pueden reservar turnos con esas coberturas, y podés
                      ponerle a cada una un cupo máximo de turnos por día (vacío = sin límite).
                    </FormDescription>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                      {[...(obrasSocialesLista ?? [])]
                        .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"))
                        .map((os) => {
                          const seleccionada = field.value?.find((o) => o.obraSocialId === os.id);
                          return (
                            <div
                              key={os.id}
                              className={`flex items-center gap-3 rounded-lg border p-3 ${seleccionada ? "border-primary bg-primary/5" : ""}`}
                            >
                              <Checkbox
                                data-testid={`checkbox-os-${os.id}`}
                                checked={!!seleccionada}
                                onCheckedChange={(checked) =>
                                  checked
                                    ? field.onChange([...(field.value ?? []), { obraSocialId: os.id, cupoDiario: null }])
                                    : field.onChange((field.value ?? []).filter((o) => o.obraSocialId !== os.id))
                                }
                              />
                              <span className="flex-1 text-sm font-medium truncate" title={os.nombre}>{os.nombre}</span>
                              {seleccionada && (
                                <Input
                                  type="number"
                                  min={1}
                                  data-testid={`input-cupo-os-${os.id}`}
                                  className="w-24 h-8"
                                  placeholder="Cupo/día"
                                  value={seleccionada.cupoDiario ?? ""}
                                  onChange={(e) =>
                                    field.onChange((field.value ?? []).map((o) =>
                                      o.obraSocialId === os.id
                                        ? { ...o, cupoDiario: e.target.value === "" ? null : Number(e.target.value) }
                                        : o,
                                    ))
                                  }
                                />
                              )}
                            </div>
                          );
                        })}
                    </div>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              {/* Prácticas del nomenclador */}
              <div className="space-y-4">
                <h3 className="text-lg font-medium border-b pb-2">Prácticas que realiza</h3>
                <FormField control={form.control} name="practicas" render={({ field }) => (
                  <FormItem>
                    <FormDescription>
                      Asociá las prácticas del nomenclador que se hacen en esta agenda
                      (ej: mamografía, código 340602). Se usan para encontrar la agenda al
                      buscar por práctica y viajan como prestación al cargar el paciente en Klinicos.
                    </FormDescription>
                    {(() => {
                      // Tipos sugeridos según la especialidad elegida (ej. tipos de ecografías):
                      // no todos los profesionales hacen todas, acá se tildan las que sí.
                      const espSel = especialidades?.find((e) => e.id === Number(form.watch("especialidadId")));
                      if (!espSel) return null;
                      const normalizar = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                      const nombreEsp = normalizar(espSel.nombre);
                      const tipos = (catalogoData?.practicas ?? []).filter((p) => {
                        const cat = normalizar(p.categoria ?? "");
                        if (normalizar(p.especialidad ?? "") === nombreEsp || (cat.length >= 4 && nombreEsp.includes(cat))) return true;
                        // Los Doppler figuran en el catálogo bajo otras categorías
                        // (Pesados 88, Cardiología) pero se hacen en las agendas de
                        // ecografía: mostrarlos igual, tengan o no código de nomenclador.
                        const nombre = normalizar(p.nombre ?? "");
                        return nombreEsp.includes("ecograf") && nombre.includes("doppler") && !nombre.includes("ecocardiograma");
                      });
                      if (tipos.length === 0) return null;
                      return (
                        <div className="rounded-lg border p-3 space-y-2">
                          <p className="text-sm font-medium">Tipos de {espSel.nombre.toLowerCase()} que realiza</p>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
                            {tipos.map((p) => {
                              // Algunos estudios facturan varios códigos juntos
                              // (ej. Eco Abdomen = 180112 + 180113): al tildar
                              // se cargan todos como ítems separados.
                              const codigos =
                                p.codigosNomenclador && p.codigosNomenclador.length > 0
                                  ? p.codigosNomenclador
                                  : [p.codigoNomenclador ?? p.codigo];
                              const marcada = codigos.every((c) => (field.value ?? []).some((x) => x.codigo === c));
                              return (
                                <label key={p.id} className="flex items-center gap-2 text-sm cursor-pointer">
                                  <Checkbox
                                    data-testid={`check-tipo-practica-${codigos[0]}`}
                                    checked={marcada}
                                    onCheckedChange={(v) => {
                                      if (v) {
                                        const descripcion = p.sinonimos?.[0] ?? p.nombre;
                                        const nuevos = codigos
                                          .filter((c) => !(field.value ?? []).some((x) => x.codigo === c))
                                          .map((c) => ({ codigo: c, descripcion }));
                                        field.onChange([...(field.value ?? []), ...nuevos]);
                                      } else {
                                        field.onChange((field.value ?? []).filter((x) => !codigos.includes(x.codigo)));
                                      }
                                    }}
                                  />
                                  <span className="truncate">{p.nombre}</span>
                                  <span className="font-mono text-xs text-muted-foreground">{codigos.join(" + ")}</span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}
                    {(field.value ?? []).length > 0 && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {(field.value ?? []).map((p) => (
                          <span
                            key={p.codigo}
                            data-testid={`chip-practica-${p.codigo}`}
                            className="inline-flex items-center gap-2 rounded-full border bg-muted px-3 py-1 text-sm"
                          >
                            <span className="font-mono font-medium">{p.codigo}</span>
                            {p.descripcion && <span className="max-w-[260px] truncate">{p.descripcion}</span>}
                            <button
                              type="button"
                              aria-label={`Quitar práctica ${p.codigo}`}
                              className="text-muted-foreground hover:text-destructive"
                              onClick={() => field.onChange((field.value ?? []).filter((x) => x.codigo !== p.codigo))}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="relative">
                      <FormControl>
                        <Input
                          data-testid="input-buscar-practica"
                          placeholder="Buscar por código o descripción (ej: mamografía o 340602)"
                          value={busquedaPractica}
                          onChange={(e) => setBusquedaPractica(e.target.value)}
                        />
                      </FormControl>
                      {busquedaPractica.length >= 2 && (sugerenciasPracticas?.practicas?.length ?? 0) > 0 && (
                        <div className="absolute z-10 mt-1 w-full rounded-md border bg-popover shadow-md max-h-64 overflow-auto">
                          {sugerenciasPracticas!.practicas!
                            .filter((s) => !(field.value ?? []).some((x) => x.codigo === s.codigo))
                            .map((s) => (
                              <button
                                key={s.codigo}
                                type="button"
                                data-testid={`sugerencia-practica-${s.codigo}`}
                                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted"
                                onClick={() => {
                                  field.onChange([...(field.value ?? []), { codigo: s.codigo, descripcion: s.descripcion ?? "" }]);
                                  setBusquedaPractica("");
                                }}
                              >
                                <span className="font-mono font-medium">{s.codigo}</span>
                                <span className="truncate text-muted-foreground">{s.descripcion}</span>
                              </button>
                            ))}
                        </div>
                      )}
                    </div>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              {/* Visibilidad */}
              <div className="space-y-4">
                <h3 className="text-lg font-medium border-b pb-2">Estado y Visibilidad</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <FormField control={form.control} name="activa" render={({ field }) => (
                    <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 space-y-0">
                      <div className="space-y-0.5">
                        <FormLabel className="text-base">Activa</FormLabel>
                        <FormDescription>La agenda está operativa y recibe turnos</FormDescription>
                      </div>
                      <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl>
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="esGuardia" render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-base">Formato de atención</FormLabel>
                      <FormControl>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <button
                            type="button"
                            data-testid="formato-individual"
                            onClick={() => field.onChange(false)}
                            className={`rounded-lg border p-4 text-left transition-colors ${!field.value ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted/50"}`}
                          >
                            <p className="font-medium">Formato individual</p>
                            <p className="text-sm text-muted-foreground mt-1">
                              Agenda de un médico: turnos con horario fijo, cada paciente queda asignado a ese profesional.
                            </p>
                          </button>
                          <button
                            type="button"
                            data-testid="formato-grupal"
                            onClick={() => field.onChange(true)}
                            className={`rounded-lg border p-4 text-left transition-colors ${field.value ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted/50"}`}
                          >
                            <p className="font-medium">Formato grupal</p>
                            <p className="text-sm text-muted-foreground mt-1">
                              Atención por orden de llegada, sin médico fijo: los pacientes entran a una sala común y los toma cualquier profesional habilitado de la especialidad. Ideal para guardias y servicios como ecografía.
                            </p>
                          </button>
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  {form.watch("esGuardia") && (
                    <p className="md:col-span-2 text-sm text-muted-foreground rounded-lg border p-3">
                      Los profesionales que van a trabajar se tildan arriba, en &quot;Profesionales
                      que van a trabajar&quot;. Además, para tomar pacientes cada médico prende
                      &quot;Acepto demanda espontánea&quot; desde su consultorio.
                    </p>
                  )}
                  <FormField control={form.control} name="visibilidades" render={({ field }) => (
                    <FormItem className="md:col-span-2">
                      <FormLabel>Visibilidad</FormLabel>
                      <FormDescription>
                        Tildá dónde se puede ver y reservar esta agenda. Podés combinar varios lugares.
                        Si no tildás ninguno, la agenda queda interna (no visible).
                      </FormDescription>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
                        {VISIBILIDAD_OPTIONS.map((opt) => {
                          const tildado = field.value?.includes(opt.value);
                          return (
                            <label
                              key={opt.value}
                              className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${tildado ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
                            >
                              <Checkbox
                                data-testid={`checkbox-visibilidad-${opt.value}`}
                                checked={tildado}
                                onCheckedChange={(checked) =>
                                  checked
                                    ? field.onChange([...(field.value ?? []), opt.value])
                                    : field.onChange((field.value ?? []).filter((v) => v !== opt.value))
                                }
                                className="mt-0.5"
                              />
                              <span>
                                <span className="block text-sm font-medium">{opt.label}</span>
                                <span className="block text-xs text-muted-foreground">{opt.desc}</span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                      {(field.value ?? []).length === 0 && (
                        <p className="text-xs text-amber-600 dark:text-amber-400">
                          Sin tildes: la agenda queda interna, no se ve en recepción ni en el portal.
                        </p>
                      )}
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
              </div>

              {/* Tipo de agenda y worklist del PACS */}
              <div className="space-y-4">
                <h3 className="text-lg font-medium border-b pb-2">Tipo de agenda y worklist</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <FormField control={form.control} name="tipo" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tipo de agenda</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl><SelectTrigger data-testid="select-tipo-agenda"><SelectValue /></SelectTrigger></FormControl>
                        <SelectContent>
                          <SelectItem value="consulta">Consulta</SelectItem>
                          <SelectItem value="practica">Práctica</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        {field.value === "practica"
                          ? "Agenda de prácticas / estudios (ej: ergometrías, ecografías)"
                          : "Agenda de consultas médicas"}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="enviaWorklist" render={({ field }) => (
                    <FormItem>
                      <FormLabel>¿Va a la worklist del PACS?</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl><SelectTrigger data-testid="select-envia-worklist"><SelectValue /></SelectTrigger></FormControl>
                        <SelectContent>
                          {form.watch("tipo") !== "practica" && (
                            <SelectItem value="heredar">Según la especialidad (por defecto)</SelectItem>
                          )}
                          <SelectItem value="si">Sí, enviar a la worklist</SelectItem>
                          <SelectItem value="no">No enviar</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        Si va a la worklist, cada turno se envía al PACS con el nombre de esta agenda y los datos del paciente
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
              </div>

              {/* Circuito de informes (DiagnostiPACS) */}
              <div className="space-y-4">
                <h3 className="text-lg font-medium border-b pb-2">Informes</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <FormField control={form.control} name="llevaInforme" render={({ field }) => (
                    <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 space-y-0">
                      <div className="space-y-0.5">
                        <FormLabel className="text-base">Lleva informe</FormLabel>
                        <FormDescription>
                          Al terminar la atención, el estudio se envía a DiagnostiPACS y el turno queda pendiente de informe
                        </FormDescription>
                      </div>
                      <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl>
                    </FormItem>
                  )} />
                </div>
              </div>

              {/* Vínculo con Klinicos (robot de ingresos) */}
              <div className="space-y-4">
                <h3 className="text-lg font-medium border-b pb-2">Vínculo con Klinicos</h3>
                <p className="text-sm text-muted-foreground">
                  Cargá estos datos tal como figuran en Klinicos: el robot los usa directo para el ingreso ambulatorio. Si quedan vacíos, se usa el mapeo automático por especialidad.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <FormField control={form.control} name="klinicosSector" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Sector / Servicio</FormLabel>
                      <FormControl><Input placeholder="Ej: CONSULTORIO o IMAGENES S/C" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="klinicosEspecialidad" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Especialidad en Klinicos</FormLabel>
                      <FormControl><Input placeholder="Tal como figura en Klinicos" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="klinicosProfesional" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Profesional en Klinicos</FormLabel>
                      <FormControl><Input placeholder="Apellido y nombre, tal como figura en Klinicos" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="klinicosMotivo" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Motivo de consulta por defecto</FormLabel>
                      <FormControl><Input placeholder="Obligatorio en Klinicos; se usa si el turno no trae motivo" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
              </div>

              {/* Guardia virtual: solo en agendas de guardia ya guardadas y
                  solo para admin (el guardado en el backend es solo admin) */}
              {isEdit && form.watch("esGuardia") && turneraId != null && esAdmin && (
                <GuardiaVirtualSection
                  turneraId={turneraId}
                  esPediatrica={/pediatr/i.test(
                    form.watch("nombre").normalize("NFD").replace(/[\u0300-\u036f]/g, ""),
                  )}
                />
              )}
            </CardContent>
            <CardFooter className="flex items-center gap-2 p-6 pt-0">
              {isEdit && (
                <Button
                  type="button"
                  variant="outline"
                  className="text-destructive hover:text-destructive mr-auto"
                  onClick={() => setConfirmarEliminar(true)}
                  data-testid="button-eliminar-turnera"
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  Eliminar turnera
                </Button>
              )}
              <div className="flex gap-2 ml-auto">
                <Link href="/turneras">
                  <Button variant="outline" type="button">Cancelar</Button>
                </Link>
                <Button type="submit" disabled={isPending}>
                  {isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  {isEdit ? "Guardar Cambios" : "Guardar Turnera"}
                </Button>
              </div>
            </CardFooter>
          </Card>
        </form>
      </Form>

      <AlertDialog open={avisoDuplicado != null} onOpenChange={(open) => { if (!open) setAvisoDuplicado(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ya existe una agenda igual</AlertDialogTitle>
            <AlertDialogDescription>
              El profesional ya tiene la agenda activa{" "}
              <span className="font-medium">{avisoDuplicado?.aviso.turneraExistente.nombre}</span>{" "}
              en esa sede, de {avisoDuplicado?.aviso.turneraExistente.horaInicio?.substring(0, 5)} a{" "}
              {avisoDuplicado?.aviso.turneraExistente.horaFin?.substring(0, 5)}, con horario superpuesto.
              Crear otra igual duplica la agenda en el mosaico de Nuevo Turno.
              ¿Querés crear la nueva de todos modos?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={createMutation.isPending} data-testid="button-cancelar-duplicado-turnera">
              No crear
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); crearIgualmente(); }}
              disabled={createMutation.isPending}
              data-testid="button-confirmar-duplicado-turnera"
            >
              {createMutation.isPending ? "Creando..." : "Crear igualmente"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmarEliminar} onOpenChange={setConfirmarEliminar}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar esta turnera?</AlertDialogTitle>
            <AlertDialogDescription>
              Se va a eliminar <span className="font-medium">{turneraExistente?.nombre}</span>.
              Los turnos ya reservados no se cancelan automáticamente. Esta acción no se puede deshacer.
              Si solo querés que deje de ofrecer turnos, desactivala con el interruptor "Activa" en vez de eliminarla.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); eliminarTurnera(); }}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirmar-eliminar-turnera"
            >
              {deleteMutation.isPending ? "Eliminando..." : "Eliminar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Guardia virtual: configuración dentro de la agenda de guardia ──────────
// Encendido + horario de atención de la guardia clínica por videollamada.
// Se guarda aparte del formulario (config del sistema, no de la turnera).

interface HorarioGuardiaVirtual {
  lsInicio: string;
  lsFin: string;
  dInicio: string;
  dFin: string;
}

const guardiaAuthHeaders = () => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${localStorage.getItem("auth_token") ?? ""}`,
});

// esPediatrica: si el nombre de la agenda dice "pediatr...", esta sección
// configura la guardia pediátrica (agenda y switch propios); si no, la de
// adultos. El horario es compartido entre ambas.
function GuardiaVirtualSection({ turneraId, esPediatrica }: { turneraId: number; esPediatrica: boolean }) {
  const { toast } = useToast();
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [activa, setActiva] = useState(false);
  const [esLaElegida, setEsLaElegida] = useState(false);
  const [horario, setHorario] = useState<HorarioGuardiaVirtual>({
    lsInicio: "08:00", lsFin: "19:00", dInicio: "12:00", dFin: "18:00",
  });

  useEffect(() => {
    fetch("/api/guardia-virtual/config", { headers: guardiaAuthHeaders() })
      .then(async (r) => {
        if (!r.ok) throw new Error();
        const data = await r.json();
        const slot = esPediatrica ? (data.pediatria ?? {}) : data;
        setActiva(Boolean(slot.activa));
        setEsLaElegida(slot.turneraId === turneraId || slot.turneraId == null);
        if (data.horario) setHorario(data.horario);
      })
      .catch(() => toast({ title: "No se pudo cargar la guardia virtual", variant: "destructive" }))
      .finally(() => setCargando(false));
  }, [turneraId, esPediatrica, toast]);

  const guardar = async () => {
    setGuardando(true);
    try {
      const r = await fetch("/api/guardia-virtual/config", {
        method: "PUT",
        headers: guardiaAuthHeaders(),
        body: JSON.stringify({
          activa,
          horario,
          turneraId,
          guardia: esPediatrica ? "pediatrica" : "clinica",
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        toast({
          title: "No se pudo guardar la guardia virtual",
          description: data?.error ?? "Revisá los horarios ingresados",
          variant: "destructive",
        });
        return;
      }
      const slot = esPediatrica ? (data.pediatria ?? {}) : data;
      setActiva(Boolean(slot.activa));
      setEsLaElegida(slot.turneraId === turneraId);
      if (data.horario) setHorario(data.horario);
      toast({
        title: "Guardia virtual guardada",
        description: data.activa
          ? "Encendida, con esta agenda y el horario elegido."
          : "Horario guardado. La guardia virtual sigue apagada.",
      });
    } catch {
      toast({ title: "No se pudo guardar la guardia virtual", variant: "destructive" });
    } finally {
      setGuardando(false);
    }
  };

  const campoHora = (campo: keyof HorarioGuardiaVirtual, etiqueta: string) => (
    <div className="space-y-1">
      <span className="text-sm font-medium">{etiqueta}</span>
      <Input
        type="time"
        value={horario[campo]}
        onChange={(e) => setHorario((h) => ({ ...h, [campo]: e.target.value }))}
        className="w-32"
        data-testid={`input-guardia-virtual-${campo}`}
      />
    </div>
  );

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-medium border-b pb-2">
        {esPediatrica ? "Guardia virtual pediátrica" : "Guardia virtual (videollamadas)"}
      </h3>
      {esPediatrica && (
        <p className="text-xs text-muted-foreground">
          Esta agenda se configura como guardia pediátrica: la app del paciente la
          ofrece aparte de la guardia de adultos. El horario es compartido entre ambas.
        </p>
      )}
      {cargando ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
        </div>
      ) : (
        <>
          {!esLaElegida && (
            <p className="text-sm text-amber-700 dark:text-amber-300">
              Hoy la guardia virtual usa otra agenda. Al guardar acá, pasa a usar esta.
            </p>
          )}
          <div className="flex items-center gap-3">
            <Switch
              checked={activa}
              onCheckedChange={setActiva}
              data-testid="switch-guardia-virtual-activa"
            />
            <span className="text-sm">
              {activa ? "Encendida" : "Apagada"} — con la guardia apagada, la app del
              paciente avisa que no está disponible, sin importar el horario.
            </span>
          </div>
          <div className="grid sm:grid-cols-2 gap-6">
            <div>
              <p className="text-sm font-medium mb-2">Lunes a sábado</p>
              <div className="flex gap-4">
                {campoHora("lsInicio", "Desde")}
                {campoHora("lsFin", "Hasta")}
              </div>
            </div>
            <div>
              <p className="text-sm font-medium mb-2">Domingo</p>
              <div className="flex gap-4">
                {campoHora("dInicio", "Desde")}
                {campoHora("dFin", "Hasta")}
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Hora argentina. Se guarda al instante con el botón de abajo, aparte del resto del formulario.</p>
          <Button type="button" variant="outline" onClick={guardar} disabled={guardando} data-testid="button-guardar-guardia-virtual">
            {guardando && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Guardar guardia virtual
          </Button>
        </>
      )}
    </div>
  );
}
