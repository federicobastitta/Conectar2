import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { PacienteBuscador } from "@/components/pacientes/paciente-buscador";
import { MascotaAsistente } from "@/components/turnos/mascota-asistente";
import { Combobox } from "@/components/ui/combobox";
import { FaWhatsapp } from "react-icons/fa";

import {
  useListEspecialidades,
  useGetTablero,
  useGetDisponibilidadTurnera,
  useGetProximosHuecos,
  useGetRecepcionOcupacionMes,
  useCreateTurno,
  useCreatePaciente,
  useListObrasSociales,
  useListTurneras,
  useListDicomPacsEstudios,
  type DicomPacsEstudio,
} from "@workspace/api-client-react";
import { TurnoInputModalidad } from "@workspace/api-client-react";
import { getListTurnosQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Search,
  UserCheck,
  Calendar as CalendarIcon,
  Clock,
  Stethoscope,
  UserCircle,
  MapPin,
  Timer,
  CheckCircle2,
  FileText,
  ExternalLink,
} from "lucide-react";

// Normaliza texto para búsqueda: minúsculas y sin acentos.
function normalizar(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Días de la semana abreviados (getDay(): 0 = domingo).
const DIAS_CORTOS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

// "2026-07-17" → "Vie 17/07" (u "Hoy" si es la fecha actual).
function formatearFechaCorta(f: string): string {
  if (f === format(new Date(), "yyyy-MM-dd")) return "Hoy";
  const d = new Date(`${f}T00:00:00`);
  if (isNaN(d.getTime())) return f;
  const [, mes, dia] = f.split("-");
  return `${DIAS_CORTOS[d.getDay()]} ${dia}/${mes}`;
}

const DIAS_LARGOS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const MESES_LARGOS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

// "2026-07-25" → "Sábado 25 de julio"
function formatearFechaLarga(f: string): string {
  const d = new Date(`${f}T00:00:00`);
  if (isNaN(d.getTime())) return f;
  return `${DIAS_LARGOS[d.getDay()]} ${d.getDate()} de ${MESES_LARGOS[d.getMonth()]}`;
}
const turnoSchema = z.object({
  pacienteId: z.coerce.number().optional(),
  pacienteDni: z.string().min(1, "DNI es requerido"),
  pacienteNombre: z.string().optional(),
  pacienteApellido: z.string().optional(),
  pacienteTelefono: z.string().min(1, "El celular es obligatorio"),
  cobertura: z.string().optional(),
  nroAfiliado: z.string().optional(),
  turneraId: z.coerce.number().min(1, "Seleccione una agenda"),
  fecha: z.string().min(1, "Seleccione una fecha"),
  horaInicio: z.string().min(1, "Seleccione un horario"),
  modalidad: z.nativeEnum(TurnoInputModalidad),
  motivoConsulta: z.string().optional(),
});

// Datos precargados desde otra pantalla (ej. asistente de órdenes de prácticas).
export interface PrefillTurno {
  pacienteId?: number;
  dni?: string;
  nombre?: string;
  apellido?: string;
  telefono?: string;
  cobertura?: string;
  nroAfiliado?: string;
  /** Código de nomenclador de la práctica a preseleccionar. */
  practica?: string;
  /** Texto para el buscador (nombre del estudio) si el código no matchea. */
  busqueda?: string;
}

export function NuevoTurnoForm({ onCreado, prefill }: { onCreado?: () => void; prefill?: PrefillTurno }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const crearPacienteMutation = useCreatePaciente();
  const { data: obrasSociales } = useListObrasSociales();

  // Opciones del combo de obra social (solo las activas del catálogo).
  const opcionesOS = (obrasSociales ?? [])
    .filter((os) => os.activa)
    .map((os) => ({
      value: os.nombre,
      label: os.codigo ? `${os.codigo} · ${os.nombre.toUpperCase()}` : os.nombre.toUpperCase(),
    }));

  // Botón "Cargar": guarda la ficha del paciente nuevo en la base sin
  // necesidad de asignarle un turno todavía.
  const cargarPaciente = () => {
    // Si el paciente ya existe (vino del buscador), el botón funciona como
    // confirmación: el usuario validó que el DNI y los datos son correctos.
    const pacienteExistente = form.getValues("pacienteId");
    if (pacienteExistente) {
      setPacienteColapsado(true);
      toast({
        title: "Paciente confirmado",
        description: `${form.getValues("pacienteApellido")}, ${form.getValues("pacienteNombre")} — DNI ${form.getValues("pacienteDni")}`,
      });
      return;
    }
    const dni = (form.getValues("pacienteDni") || "").trim();
    const nombre = (form.getValues("pacienteNombre") || "").trim();
    const apellido = (form.getValues("pacienteApellido") || "").trim();
    const telefono = (form.getValues("pacienteTelefono") || "").trim();
    const cobertura = form.getValues("cobertura") || "";
    const nroAfiliado = (form.getValues("nroAfiliado") || "").trim();
    if (!dni || !nombre || !apellido || !telefono) {
      toast({
        title: "Faltan datos del paciente",
        description: "DNI, nombre, apellido y celular son obligatorios para cargarlo.",
        variant: "destructive",
      });
      return;
    }
    crearPacienteMutation.mutate(
      {
        data: {
          dni,
          nombre,
          apellido,
          telefono,
          cobertura: cobertura || undefined,
          nroAfiliado: nroAfiliado || undefined,
        },
      },
      {
        onSuccess: (p) => {
          form.setValue("pacienteId", p.id);
          setPacienteColapsado(true);
          toast({ title: "Paciente cargado", description: `${p.apellido}, ${p.nombre} quedó registrado en la base.` });
        },
        onError: (err) => {
          const status = (err as { response?: { status?: number } })?.response?.status;
          toast({
            title: "No se pudo cargar el paciente",
            description:
              status === 409
                ? "Ya existe un paciente con ese DNI. Buscalo arriba por DNI."
                : "Revisá los datos e intentá de nuevo.",
            variant: "destructive",
          });
        },
      },
    );
  };

  // Una vez cargado el paciente, la tarjeta se achica a un resumen para dejar
  // lugar a la agenda; con "Cambiar" se vuelve a abrir.
  const [pacienteColapsado, setPacienteColapsado] = useState(false);
  const [busquedaEsp, setBusquedaEsp] = useState("");
  const [asistenteAbierto, setAsistenteAbierto] = useState(false);
  // Pantalla completa con la turnera del profesional (todos los días y horarios).
  const [turneraAbierta, setTurneraAbierta] = useState(false);
  const [selectedEspecialidad, setSelectedEspecialidad] = useState<number | null>(null);
  // Estudio/práctica elegido (código del nomenclador): filtra los profesionales
  // que realizan esa práctica según lo cargado en cada agenda.
  const [selectedPractica, setSelectedPractica] = useState<string | null>(null);
  const [selectedGrupo, setSelectedGrupo] = useState<string | null>(null);
  const [selectedTurnera, setSelectedTurnera] = useState<number | null>(null);
  const [selectedFecha, setSelectedFecha] = useState<string>(format(new Date(), "yyyy-MM-dd"));

  // Flujo: especialidad → tablero de agendas de la especialidad → fecha → horario.
  const { data: especialidades } = useListEspecialidades();
  // Turneras activas: se usan para matchear también por las prácticas del
  // nomenclador asociadas a cada agenda (ej: "mamografía" → agenda que la hace).
  const { data: turnerasActivas } = useListTurneras({ activa: true });

  // Asistente de turnos: entiende frases tipo "eco en bera" — cada palabra
  // (sin acentos, ignorando conectores como "en"/"de") puede referirse a la
  // especialidad o a la sede. Las que matchean especialidad la filtran; las
  // demás filtran las agendas por sede/nombre.
  const STOPWORDS = new Set(["en", "de", "del", "la", "el", "los", "las", "y", "con"]);
  const tokensBusqueda = normalizar(busquedaEsp.trim())
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));

  const especialidadesFiltradas = (() => {
    if (busquedaEsp.trim().length < 2 || tokensBusqueda.length === 0) return [];
    const lista = especialidades ?? [];
    // Además del nombre de la especialidad, matcheamos las prácticas del
    // nomenclador asociadas a cada agenda: buscar "mamografía" (o "340602")
    // encuentra la especialidad de la agenda que hace esa práctica.
    const textoPracticasPorEspecialidad = new Map<number, string>();
    for (const t of turnerasActivas ?? []) {
      if (t.especialidadId == null || !Array.isArray(t.practicas) || t.practicas.length === 0) continue;
      const texto = t.practicas.map((p) => normalizar(`${p.codigo} ${p.descripcion ?? ""}`)).join(" ");
      textoPracticasPorEspecialidad.set(
        t.especialidadId,
        `${textoPracticasPorEspecialidad.get(t.especialidadId) ?? ""} ${texto}`,
      );
    }
    const textoDe = (e: { id: number; nombre: string }) =>
      `${normalizar(e.nombre)} ${textoPracticasPorEspecialidad.get(e.id) ?? ""}`;
    // Preferimos las especialidades que matchean TODAS las palabras (ej:
    // "eco lomas" → "Ecografias Lomas De Zamora"); si ninguna las cumple
    // todas, mostramos las que matchean alguna (el resto filtra por sede).
    const todas = lista.filter((e) => {
      const nom = textoDe(e);
      return tokensBusqueda.every((t) => nom.includes(t));
    });
    if (todas.length > 0) return todas;
    return lista.filter((e) => {
      const nom = textoDe(e);
      return tokensBusqueda.some((t) => nom.includes(t));
    });
  })();

  // Buscador rápido de informes de Pixel (ex DiagnostiPACS): con lo mismo que
  // se escribe en el asistente, buscamos por DNI, nombre del paciente o texto
  // del informe. Solo se consulta cuando el asistente está en uso.
  const consultarInformes = asistenteAbierto && busquedaEsp.trim().length >= 3;
  const { data: pacsData } = useListDicomPacsEstudios({
    query: { enabled: consultarInformes, staleTime: 60000 },
  });
  const informesPixel = (() => {
    if (!consultarInformes || !pacsData?.estudios || tokensBusqueda.length === 0) return [];
    const informado = (e: DicomPacsEstudio) =>
      e.status === "signed" || e.status === "final" || Boolean(e.impression);
    return pacsData.estudios
      .filter((e) => {
        if (!informado(e)) return false;
        const texto = normalizar(
          `${e.patientName ?? ""} ${e.patientDni ?? ""} ${e.impression ?? ""}`,
        );
        return tokensBusqueda.every((t) => texto.includes(t));
      })
      .sort((a, b) =>
        (b.studyDate ?? b.createdAt ?? "").localeCompare(a.studyDate ?? a.createdAt ?? ""),
      )
      .slice(0, 5);
  })();

  // Tokens que NO pertenecen al nombre de la especialidad elegida: se usan
  // para filtrar las agendas por sede (ej: "bera" → Berazategui).
  const especialidadElegidaNombre = normalizar(
    (especialidades ?? []).find((e) => e.id === selectedEspecialidad)?.nombre ?? "",
  );
  const tokensSede = especialidadElegidaNombre
    ? tokensBusqueda.filter((t) => !especialidadElegidaNombre.includes(t))
    : [];

  // Si se borra lo escrito en el asistente, se limpia todo lo que éste había
  // completado: especialidad, agenda, fecha y horario.
  const limpiarSeleccionAsistente = () => {
    setSelectedEspecialidad(null);
    setSelectedPractica(null);
    setSelectedGrupo(null);
    setSelectedTurnera(null);
    setSelectedFecha("");
    form.setValue("turneraId", 0 as unknown as number);
    form.setValue("fecha", "");
    form.setValue("horaInicio", "");
  };

  const seleccionarEspecialidad = (id: number) => {
    if (id === selectedEspecialidad) return;
    setSelectedEspecialidad(id);
    // Si la práctica elegida no la hace ninguna agenda de la nueva
    // especialidad, se limpia para no dejar el tablero vacío.
    if (selectedPractica) {
      const sigueValida = (turnerasActivas ?? []).some(
        (t) =>
          t.especialidadId === id &&
          Array.isArray(t.practicas) &&
          t.practicas.some((p) => p.codigo === selectedPractica),
      );
      if (!sigueValida) setSelectedPractica(null);
    }
    setSelectedGrupo(null);
    setSelectedTurnera(null);
    form.setValue("turneraId", 0 as unknown as number);
    form.setValue("horaInicio", "");
  };

  // Si la búsqueda deja una sola especialidad, la seleccionamos automáticamente.
  useEffect(() => {
    if (especialidadesFiltradas.length === 1 && especialidadesFiltradas[0].id !== selectedEspecialidad) {
      seleccionarEspecialidad(especialidadesFiltradas[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busquedaEsp, especialidades]);

  // Estudios/prácticas disponibles para elegir: las cargadas en las agendas
  // activas (si hay especialidad elegida, solo las de esa especialidad).
  const practicasDisponibles = (() => {
    const map = new Map<string, string>(); // codigo -> descripcion
    const descripcionesVistas = new Set<string>(); // evita repetir estudios multi-código
    for (const t of turnerasActivas ?? []) {
      if (selectedEspecialidad != null && t.especialidadId !== selectedEspecialidad) continue;
      for (const p of t.practicas ?? []) {
        if (map.has(p.codigo)) continue;
        // Un estudio con varios códigos (ej. Eco Abdomen 180112+180113) genera
        // varias filas con la misma descripción: se muestra una sola opción.
        const claveDesc = (p.descripcion || p.codigo).trim().toLowerCase();
        if (descripcionesVistas.has(claveDesc)) continue;
        descripcionesVistas.add(claveDesc);
        map.set(p.codigo, p.descripcion || p.codigo);
      }
    }
    return [...map.entries()]
      .map(([codigo, descripcion]) => ({ codigo, descripcion }))
      .sort((a, b) => a.descripcion.localeCompare(b.descripcion, "es"));
  })();

  // Agendas que realizan la práctica elegida. Matchea por código o por
  // descripción: los estudios multi-código comparten descripción y alcanza
  // con que la agenda tenga cargado cualquiera de sus códigos.
  const turnerasConPractica = (() => {
    if (!selectedPractica) return null;
    const desc = practicasDisponibles
      .find((p) => p.codigo === selectedPractica)
      ?.descripcion.trim()
      .toLowerCase();
    const ids = new Set<number>();
    for (const t of turnerasActivas ?? []) {
      const hace = (t.practicas ?? []).some(
        (p) =>
          p.codigo === selectedPractica ||
          (desc != null && (p.descripcion || p.codigo).trim().toLowerCase() === desc),
      );
      if (hace) ids.add(t.id);
    }
    return ids;
  })();

  const seleccionarPractica = (codigo: string | null) => {
    setSelectedPractica(codigo);
    setSelectedGrupo(null);
    setSelectedTurnera(null);
    form.setValue("turneraId", 0 as unknown as number);
    form.setValue("horaInicio", "");
    if (!codigo) return;
    // Si todavía no hay especialidad, la deducimos de las agendas que hacen
    // esa práctica (si todas son de la misma).
    if (selectedEspecialidad == null) {
      const esps = new Set(
        (turnerasActivas ?? [])
          .filter((t) => (t.practicas ?? []).some((p) => p.codigo === codigo))
          .map((t) => t.especialidadId)
          .filter((e): e is number => e != null),
      );
      if (esps.size === 1) setSelectedEspecialidad([...esps][0]);
    }
  };

  // Tablero de mando: todas las agendas de la especialidad con ocupación de hoy,
  // primer turno disponible, demora y datos del profesional/sede.
  const hoy = format(new Date(), "yyyy-MM-dd");
  const { data: tablero, isLoading: loadingTablero } = useGetTablero(
    { fecha: hoy, especialidadId: selectedEspecialidad ?? undefined },
    // staleTime: si se repite la búsqueda en pocos minutos, responde al
    // instante con lo ya consultado y refresca por atrás.
    { query: { enabled: !!selectedEspecialidad, staleTime: 60_000 } },
  );

  const { data: slots, isLoading: loadingSlots } = useGetDisponibilidadTurnera(
    selectedTurnera || 0,
    selectedFecha,
    { query: { enabled: !!selectedTurnera && !!selectedFecha } },
  );

  // Agrupamos las agendas por profesional: un médico con 3 turneras se muestra
  // como una sola tarjeta con todos sus días de atención.
  type ItemTablero = NonNullable<typeof tablero>[number];
  const grupos = (() => {
    if (!tablero) return [];
    const map = new Map<string, { key: string; nombre: string; items: ItemTablero[] }>();
    for (const item of tablero) {
      const t = item.turnera;
      // Filtro por estudio: solo agendas que realizan la práctica elegida.
      if (turnerasConPractica && !turnerasConPractica.has(t.id)) continue;
      const key = t.profesional ? `p${t.profesional.id}` : `t${t.id}`;
      const nombre = t.profesional
        ? `Dr/a. ${t.profesional.apellido}, ${t.profesional.nombre}`
        : t.nombre;
      if (!map.has(key)) map.set(key, { key, nombre, items: [] });
      map.get(key)!.items.push(item);
    }
    let lista = [...map.values()];
    // Filtro por sede del asistente: "eco en bera" deja solo las agendas cuya
    // sede o nombre contengan "bera" (Berazategui).
    if (tokensSede.length > 0) {
      const filtrada = lista.filter((g) =>
        g.items.some((i) => {
          const texto = normalizar(`${i.turnera.sede?.nombre ?? ""} ${i.turnera.nombre}`);
          return tokensSede.every((t) => texto.includes(t));
        }),
      );
      // Si el filtro no deja nada, mostramos todas (el token puede ser un typo).
      if (filtrada.length > 0) lista = filtrada;
    }
    return lista.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  })();

  const grupoSeleccionado = grupos.find((g) => g.key === selectedGrupo) ?? null;

  // Próximos huecos libres calculados por el servidor de una sola vez.
  // Se piden para el grupo elegido; si todavía no se eligió ninguno pero la
  // búsqueda dejó uno solo, nos adelantamos y los buscamos igual (prefetch).
  const grupoParaHuecos = grupoSeleccionado ?? (grupos.length === 1 ? grupos[0] : null);
  const idsParaHuecos = (grupoParaHuecos?.items ?? []).map((i) => i.turnera.id).join(",");
  const { data: huecosGrupo, isLoading: loadingHuecos } = useGetProximosHuecos(
    { turneraIds: idsParaHuecos, limit: 9 },
    { query: { enabled: idsParaHuecos.length > 0, staleTime: 60_000 } },
  );

  // Ocupación por día del grupo elegido (mes actual y el que viene): pinta
  // los botones de días de la turnera en verde / amarillo / rojo.
  const mesDe = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const ahora = new Date();
  const mesProximo = new Date(ahora.getFullYear(), ahora.getMonth() + 1, 1);
  const ocupacionOpts = { query: { enabled: idsParaHuecos.length > 0, staleTime: 60_000 } };
  const { data: ocupMes1 } = useGetRecepcionOcupacionMes(
    { mes: mesDe(ahora), turneraIds: idsParaHuecos }, ocupacionOpts,
  );
  const { data: ocupMes2 } = useGetRecepcionOcupacionMes(
    { mes: mesDe(mesProximo), turneraIds: idsParaHuecos }, ocupacionOpts,
  );
  // fecha → nivel de ocupación ("libre" | "medio" | "lleno")
  const ocupacionPorFecha = (() => {
    const mapa = new Map<string, "libre" | "medio" | "lleno">();
    for (const d of [...(ocupMes1 ?? []), ...(ocupMes2 ?? [])]) {
      if (d.cancelado || d.capacidad <= 0) continue;
      const ratio = d.ocupados / d.capacidad;
      mapa.set(d.fecha, ratio >= 1 ? "lleno" : ratio >= 0.5 ? "medio" : "libre");
    }
    return mapa;
  })();
  const CLASE_OCUPACION: Record<"libre" | "medio" | "lleno", string> = {
    libre: "border-green-500/60 bg-green-50 text-green-800 hover:bg-green-100 dark:bg-green-950/40 dark:text-green-200",
    medio: "border-yellow-500/60 bg-yellow-50 text-yellow-800 hover:bg-yellow-100 dark:bg-yellow-950/40 dark:text-yellow-200",
    lleno: "border-red-500/60 bg-red-50 text-red-800 hover:bg-red-100 dark:bg-red-950/40 dark:text-red-200",
  };

  // Sugerencias del asistente: hasta 8 turnos disponibles próximos de la
  // especialidad, con máximo 2 por día y sin horarios consecutivos (los dos
  // turnos de un mismo día deben estar separados al menos una hora).
  const sugerencias = (() => {
    const aMinutos = (hora: string) => {
      const [h, m] = hora.split(":").map(Number);
      return h * 60 + (m || 0);
    };
    const candidatos = grupos
      .flatMap((g) =>
        g.items
          .filter((i) => i.proximoDisponible)
          .map((item) => ({ grupo: g, item })),
      )
      .sort((a, b) =>
        `${a.item.proximoDisponible!.fecha} ${a.item.proximoDisponible!.hora}`.localeCompare(
          `${b.item.proximoDisponible!.fecha} ${b.item.proximoDisponible!.hora}`,
        ),
      );
    const porFecha = new Map<string, number[]>(); // fecha -> minutos ya elegidos
    const elegidos: typeof candidatos = [];
    for (const c of candidatos) {
      const { fecha, hora } = c.item.proximoDisponible!;
      const min = aMinutos(hora);
      const usados = porFecha.get(fecha) ?? [];
      if (usados.length >= 2) continue;
      if (usados.some((u) => Math.abs(u - min) < 60)) continue;
      porFecha.set(fecha, [...usados, min]);
      elegidos.push(c);
      if (elegidos.length >= 8) break;
    }
    return elegidos;
  })();

  // Para una fecha dada, elegimos la agenda del grupo que atiende ese día
  // (si hay más de una ese día, la de horario más temprano).
  const resolverTurneraParaFecha = (grupo: { items: ItemTablero[] }, fecha: string): ItemTablero | null => {
    const d = fechaComoDate(fecha);
    if (!d) return null;
    const dia = d.getDay();
    const candidatas = grupo.items.filter((i) => (i.turnera.diasAtencion ?? []).includes(dia));
    if (candidatas.length === 0) return null;
    return candidatas.sort((a, b) => (a.turnera.horaInicio ?? "").localeCompare(b.turnera.horaInicio ?? ""))[0];
  };

  const seleccionarGrupo = (g: { key: string; items: ItemTablero[] }) => {
    if (g.key === selectedGrupo) return;
    setSelectedGrupo(g.key);
    form.setValue("horaInicio", "");
    // Si la fecha actual cae en un día que el grupo atiende, resolvemos la agenda ya.
    const item = selectedFecha ? resolverTurneraParaFecha(g, selectedFecha) : null;
    if (item) {
      setSelectedTurnera(item.turnera.id);
      form.setValue("turneraId", item.turnera.id);
    } else {
      setSelectedTurnera(null);
      form.setValue("turneraId", 0 as unknown as number);
    }
  };

  // Tocar un hueco libre: setea agenda, fecha y horario en un solo clic.
  const usarHueco = (h: { turneraId: number; fecha: string; hora: string }) => {
    if (!grupoParaHuecos) return;
    setSelectedGrupo(grupoParaHuecos.key);
    setSelectedTurnera(h.turneraId);
    form.setValue("turneraId", h.turneraId);
    setSelectedFecha(h.fecha);
    form.setValue("fecha", h.fecha);
    form.setValue("horaInicio", h.hora);
  };

  // Tomar directamente el próximo turno disponible de una sugerencia:
  // setea profesional, agenda, fecha y hora en un solo clic.
  const usarProximoDisponible = (item: ItemTablero, grupoKey: string) => {
    if (!item.proximoDisponible) return;
    setSelectedGrupo(grupoKey);
    setSelectedTurnera(item.turnera.id);
    form.setValue("turneraId", item.turnera.id);
    setSelectedFecha(item.proximoDisponible.fecha);
    form.setValue("fecha", item.proximoDisponible.fecha);
    form.setValue("horaInicio", item.proximoDisponible.hora);
  };

  // Días de atención habilitados en el calendario: unión de días del grupo elegido.
  const diasHabilitados: Set<number> | null = grupoSeleccionado
    ? new Set(grupoSeleccionado.items.flatMap((i) => i.turnera.diasAtencion ?? []))
    : null;

  // Próximos días de atención del grupo elegido (para la turnera completa):
  // recorre los próximos 30 días y se queda con los que el profesional atiende.
  const proximasFechasGrupo = ((): string[] => {
    if (!grupoSeleccionado) return [];
    const dias = new Set(grupoSeleccionado.items.flatMap((i) => i.turnera.diasAtencion ?? []));
    const fechas: string[] = [];
    const base = new Date();
    for (let i = 0; i < 30 && fechas.length < 15; i++) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
      if (dias.has(d.getDay())) fechas.push(format(d, "yyyy-MM-dd"));
    }
    return fechas;
  })();

  // El form guarda la fecha como string YYYY-MM-DD; el calendario usa Date local.
  const fechaComoDate = (f: string): Date | undefined => {
    if (!f) return undefined;
    const d = new Date(`${f}T00:00:00`);
    return isNaN(d.getTime()) ? undefined : d;
  };

  const form = useForm<z.infer<typeof turnoSchema>>({
    resolver: zodResolver(turnoSchema),
    defaultValues: {
      pacienteDni: "",
      pacienteNombre: "",
      pacienteApellido: "",
      pacienteTelefono: "",
      cobertura: "",
      nroAfiliado: "",
      fecha: format(new Date(), "yyyy-MM-dd"),
      modalidad: TurnoInputModalidad.presencial,
      motivoConsulta: "",
    },
  });

  const createMutation = useCreateTurno();

  // Precarga desde otra pantalla: datos del paciente al montar y práctica /
  // búsqueda cuando las agendas ya están cargadas (una sola vez).
  const [prefillPacienteAplicado, setPrefillPacienteAplicado] = useState(false);
  const [prefillPracticaAplicado, setPrefillPracticaAplicado] = useState(false);
  useEffect(() => {
    if (!prefill || prefillPacienteAplicado) return;
    setPrefillPacienteAplicado(true);
    if (prefill.pacienteId) form.setValue("pacienteId", prefill.pacienteId);
    if (prefill.dni) form.setValue("pacienteDni", prefill.dni.replace(/\D/g, ""));
    if (prefill.nombre) form.setValue("pacienteNombre", prefill.nombre);
    if (prefill.apellido) form.setValue("pacienteApellido", prefill.apellido);
    if (prefill.telefono) form.setValue("pacienteTelefono", prefill.telefono);
    if (prefill.cobertura) form.setValue("cobertura", prefill.cobertura);
    if (prefill.nroAfiliado) form.setValue("nroAfiliado", prefill.nroAfiliado);
    // Con la ficha completa, colapsamos la tarjeta para ir directo a la agenda.
    if (prefill.pacienteId && prefill.telefono) setPacienteColapsado(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);
  useEffect(() => {
    if (!prefill || prefillPracticaAplicado || !turnerasActivas) return;
    setPrefillPracticaAplicado(true);
    const codigo = prefill.practica;
    const laHace = codigo
      ? turnerasActivas.some((t) => (t.practicas ?? []).some((p) => p.codigo === codigo))
      : false;
    if (codigo && laHace) {
      seleccionarPractica(codigo);
    } else if (prefill.busqueda) {
      setBusquedaEsp(prefill.busqueda);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, turnerasActivas]);

  // Si el tablero cambia (refetch, edición de agendas) y el grupo o la agenda
  // seleccionada ya no existen, limpiamos la selección para evitar reservar
  // contra una agenda inválida.
  useEffect(() => {
    if (!tablero) return;
    const grupoExiste = selectedGrupo !== null && grupos.some((g) => g.key === selectedGrupo);
    const turneraValida =
      selectedTurnera !== null &&
      grupoExiste &&
      grupos.find((g) => g.key === selectedGrupo)!.items.some((i) => i.turnera.id === selectedTurnera);
    if ((selectedGrupo !== null && !grupoExiste) || (selectedTurnera !== null && !turneraValida)) {
      setSelectedGrupo(grupoExiste ? selectedGrupo : null);
      setSelectedTurnera(null);
      form.setValue("turneraId", 0 as unknown as number);
      form.setValue("horaInicio", "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tablero]);

  // Si la fecha elegida (ej: hoy por defecto) cae en un día que el profesional
  // no atiende, la limpiamos para que el usuario elija del calendario.
  useEffect(() => {
    if (diasHabilitados === null || !selectedFecha) return;
    const d = fechaComoDate(selectedFecha);
    if (d && !diasHabilitados.has(d.getDay())) {
      setSelectedFecha("");
      form.setValue("fecha", "");
      form.setValue("horaInicio", "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGrupo, tablero]);

  const onSubmit = (values: z.infer<typeof turnoSchema>) => {
    createMutation.mutate(
      { data: values },
      {
        onSuccess: () => {
          setTurneraAbierta(false);
          toast({
            title: "Turno asignado exitosamente",
            className:
              "fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-auto min-w-[320px] bg-green-600 text-white border-green-700 shadow-2xl data-[state=open]:slide-in-from-top-0 [&>div]:text-white",
          });
          queryClient.invalidateQueries({ queryKey: getListTurnosQueryKey() });
          form.reset();
          setPacienteColapsado(false);
          setSelectedEspecialidad(null);
          setSelectedPractica(null);
          setSelectedGrupo(null);
          setSelectedTurnera(null);
          setBusquedaEsp("");
          onCreado?.();
        },
        onError: () => {
          toast({ title: "Error al asignar turno", variant: "destructive" });
        },
      },
    );
  };

  const onInvalid = () => {
    toast({
      title: "Faltan datos para el turno",
      description: "Complete el paciente, la agenda, la fecha y el horario.",
      variant: "destructive",
    });
  };

  return (
    <div className="space-y-6">
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit, onInvalid)} className="grid grid-cols-1 md:grid-cols-12 gap-6">
          {/* Columna Izquierda: Paciente (colapsada a un resumen una vez cargado) */}
          <div className={pacienteColapsado ? "md:col-span-12" : "md:col-span-5 space-y-6"}>
            {pacienteColapsado ? (
              <Card data-testid="resumen-paciente-colapsado">
                <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <CheckCircle2 className="w-5 h-5 text-primary shrink-0" />
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">
                        {form.getValues("pacienteApellido")}, {form.getValues("pacienteNombre")}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {[
                          `DNI ${form.getValues("pacienteDni")}`,
                          form.getValues("cobertura") || null,
                          form.getValues("nroAfiliado") ? `Nº ${form.getValues("nroAfiliado")}` : null,
                          form.getValues("pacienteTelefono") || null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setPacienteColapsado(false)}
                    data-testid="boton-cambiar-paciente"
                  >
                    Cambiar
                  </Button>
                </CardContent>
              </Card>
            ) : (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Datos del Paciente</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Buscar paciente (DNI o nombre)</label>
                  <PacienteBuscador
                    placeholder="Escribí el DNI o el nombre..."
                    data-testid="buscador-paciente-turno-nuevo"
                    onSelect={(p) => {
                      form.setValue("pacienteId", p.id);
                      form.setValue("pacienteDni", p.dni || "");
                      form.setValue("pacienteNombre", p.nombre);
                      form.setValue("pacienteApellido", p.apellido);
                      form.setValue("pacienteTelefono", p.telefono || "");
                      form.setValue("cobertura", p.cobertura || "");
                      form.setValue("nroAfiliado", p.nroAfiliado || "");
                      toast({
                        title: "Paciente encontrado",
                        description: `${p.apellido}, ${p.nombre} — revisá los datos y confirmá con "Cargar".`,
                      });
                    }}
                    onTexto={(t) => {
                      // Cualquier edición del buscador invalida la selección
                      // previa: evita confirmar al paciente equivocado si se
                      // tipea otro DNI con un paciente ya seleccionado.
                      if (form.getValues("pacienteId")) {
                        form.setValue("pacienteId", undefined);
                      }
                      const digitos = t.replace(/\D/g, "");
                      const esNumerico = /^[\d.\s-]+$/.test(t.trim());
                      if (esNumerico && digitos.length >= 7) {
                        form.setValue("pacienteDni", digitos);
                      }
                    }}
                  />
                </div>

                <div className="pt-4 border-t space-y-4">
                  <FormField control={form.control} name="pacienteDni" render={({ field }) => (
                    <FormItem>
                      <FormLabel>DNI</FormLabel>
                      <FormControl><Input {...field} readOnly={!!form.getValues("pacienteId")} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="pacienteNombre" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Nombre</FormLabel>
                      <FormControl><Input {...field} readOnly={!!form.getValues("pacienteId")} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="pacienteApellido" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Apellido</FormLabel>
                      <FormControl><Input {...field} readOnly={!!form.getValues("pacienteId")} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="pacienteTelefono" render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Celular <span className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <div className="relative">
                          <FaWhatsapp className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-green-500" />
                          <Input className="pl-8" {...field} data-testid="input-celular-turno-nuevo" />
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <div className="grid grid-cols-[1fr_140px] gap-2">
                    <FormField control={form.control} name="cobertura" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Obra social</FormLabel>
                        <FormControl>
                          <Combobox
                            testId="select-obra-social-turno-nuevo"
                            value={field.value ?? ""}
                            onChange={field.onChange}
                            placeholder="Obra social…"
                            options={opcionesOS}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="nroAfiliado" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Nº afiliado</FormLabel>
                        <FormControl><Input {...field} data-testid="input-nro-afiliado-turno-nuevo" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>
                </div>
              </CardContent>
              <CardFooter className="justify-end border-t bg-muted/20 py-3">
                <Button
                  type="button"
                  onClick={cargarPaciente}
                  disabled={crearPacienteMutation.isPending}
                  data-testid="boton-cargar-paciente"
                >
                  {crearPacienteMutation.isPending ? (
                    "Cargando..."
                  ) : form.watch("pacienteId") ? (
                    <>
                      <CheckCircle2 className="w-4 h-4 mr-1.5" /> Cargar
                    </>
                  ) : (
                    "Cargar"
                  )}
                </Button>
              </CardFooter>
            </Card>
            )}
          </div>

          {/* Columna Derecha: Especialidad → Profesional → Agenda → Horario */}
          <div className={`${pacienteColapsado ? "md:col-span-12" : "md:col-span-7"} space-y-6`}>
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  {pacienteColapsado && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 -ml-2"
                      onClick={() => setPacienteColapsado(false)}
                      title="Volver a la vista de dos columnas"
                      data-testid="boton-volver-pantalla-compartida"
                    >
                      <ArrowLeft className="w-5 h-5" />
                    </Button>
                  )}
                  Agenda y Horario
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Asistente de turnos: escribí "eco", "traumato", etc. */}
                <div className="space-y-2 relative">
                  <label className="text-base font-semibold flex items-center gap-2">
                    <span className="w-11 h-11 rounded-full ring-2 ring-primary/30 bg-primary/5 shrink-0 inline-flex p-0.5">
                      <MascotaAsistente buscando={asistenteAbierto || busquedaEsp.trim().length > 0} />
                    </span>
                    Asistente de turnos
                  </label>
                  <Input
                    className="h-12 text-base"
                    placeholder='Escribí qué buscás (ej: "eco en lomas", "traumato", "cardio en bera")...'
                    value={busquedaEsp}
                    onChange={(e) => {
                      const v = e.target.value;
                      setBusquedaEsp(v);
                      setAsistenteAbierto(true);
                      if (v.trim().length < 2 && selectedEspecialidad !== null) {
                        limpiarSeleccionAsistente();
                      }
                    }}
                    onFocus={() => setAsistenteAbierto(true)}
                    onBlur={() => setTimeout(() => setAsistenteAbierto(false), 200)}
                    data-testid="input-asistente-turnos"
                  />
                  {/* Lista desplegable flotante con scroll: no empuja ni queda
                      tapada por el resto del formulario aunque haya muchas opciones. */}
                  {asistenteAbierto && busquedaEsp.trim().length >= 2 && (
                    <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-md border bg-white text-gray-600 shadow-lg max-h-80 overflow-y-auto">
                      {especialidadesFiltradas.length === 0 && informesPixel.length === 0 ? (
                        <p className="text-xs text-gray-500 px-3 py-2">Sin coincidencias.</p>
                      ) : (
                        <>
                          {especialidadesFiltradas.map((e) => (
                            <button
                              key={e.id}
                              type="button"
                              className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-100 transition-colors ${
                                selectedEspecialidad === e.id ? "bg-primary/15 text-primary font-medium" : ""
                              }`}
                              onMouseDown={(ev) => {
                                // mousedown en vez de click: se ejecuta antes del
                                // blur del input, así la selección nunca se pierde.
                                ev.preventDefault();
                                seleccionarEspecialidad(e.id);
                                setAsistenteAbierto(false);
                              }}
                              data-testid={`chip-especialidad-${e.id}`}
                            >
                              {e.nombre}
                            </button>
                          ))}
                          {informesPixel.length > 0 && (
                            <div className="border-t" data-testid="seccion-informes-pixel">
                              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 px-3 pt-2 pb-1 flex items-center gap-1.5">
                                <FileText className="w-3.5 h-3.5" /> Informes en Pixel
                              </p>
                              {informesPixel.map((inf) => {
                                const fecha = inf.studyDate ?? inf.createdAt ?? "";
                                const fechaCorta = fecha
                                  ? new Date(fecha.includes("T") ? fecha : `${fecha}T00:00:00`).toLocaleDateString("es-AR")
                                  : "";
                                const contenido = (
                                  <>
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="font-medium truncate">
                                        {inf.patientName ?? "Sin nombre"}
                                        {inf.patientDni ? ` · DNI ${inf.patientDni}` : ""}
                                      </span>
                                      <span className="text-xs text-gray-500 whitespace-nowrap flex items-center gap-1">
                                        {fechaCorta}
                                        {inf.viewerUrl && <ExternalLink className="w-3 h-3" />}
                                      </span>
                                    </div>
                                    <div className="text-xs text-gray-500 truncate">
                                      {inf.modality ? `${inf.modality} · ` : ""}
                                      {inf.impression ?? "Informe firmado"}
                                    </div>
                                  </>
                                );
                                return inf.viewerUrl ? (
                                  <a
                                    key={inf.id}
                                    href={inf.viewerUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="block px-3 py-2 text-sm hover:bg-gray-100 transition-colors"
                                    onMouseDown={(ev) => ev.stopPropagation()}
                                    data-testid={`informe-pixel-${inf.id}`}
                                  >
                                    {contenido}
                                  </a>
                                ) : (
                                  <div
                                    key={inf.id}
                                    className="px-3 py-2 text-sm opacity-70"
                                    title="Sin visor disponible"
                                    data-testid={`informe-pixel-${inf.id}`}
                                  >
                                    {contenido}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>

                {/* Especialidad y Profesional compactos, en una sola fila:
                    el protagonista es el asistente de arriba. */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs font-medium flex items-center gap-1.5 text-muted-foreground">
                      <Stethoscope className="w-3.5 h-3.5" /> Especialidad
                    </label>
                    <Combobox
                      options={(especialidades ?? []).map((e) => ({ value: e.id.toString(), label: e.nombre }))}
                      value={selectedEspecialidad?.toString() ?? ""}
                      onChange={(val) => seleccionarEspecialidad(Number(val))}
                      placeholder="Elegir..."
                      emptyText="Sin coincidencias"
                      testId="combobox-especialidad"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium flex items-center gap-1.5 text-muted-foreground">
                      <FileText className="w-3.5 h-3.5" /> Estudio / Práctica
                    </label>
                    <Combobox
                      options={[
                        { value: "", label: "Todos los estudios" },
                        ...practicasDisponibles.map((p) => ({ value: p.codigo, label: p.descripcion, keywords: p.codigo })),
                      ]}
                      value={selectedPractica ?? ""}
                      onChange={(val) => seleccionarPractica(val || null)}
                      placeholder={practicasDisponibles.length > 0 ? "Todos los estudios" : "Sin estudios cargados"}
                      emptyText="Ninguna agenda hace ese estudio"
                      testId="combobox-practica"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium flex items-center gap-1.5 text-muted-foreground">
                      <UserCircle className="w-3.5 h-3.5" /> Profesional
                    </label>
                    <Combobox
                      options={grupos.map((g) => ({ value: g.key, label: g.nombre }))}
                      value={selectedGrupo ?? ""}
                      onChange={(val) => {
                        const g = grupos.find((gr) => gr.key === val);
                        if (g) seleccionarGrupo(g);
                      }}
                      placeholder={selectedEspecialidad ? "Elegir..." : "Primero la especialidad"}
                      emptyText="Sin profesionales para esta especialidad"
                      testId="combobox-profesional"
                    />
                  </div>
                </div>

                {/* Sugerencias del asistente: próximos turnos disponibles de la especialidad */}
                {selectedEspecialidad && !loadingTablero && (
                  <div className="space-y-2" data-testid="sugerencias-asistente">
                    <p className="text-sm font-medium text-muted-foreground">Próximos turnos disponibles</p>
                    {sugerencias.length === 0 ? (
                      <div className="text-sm text-muted-foreground text-center p-4 border border-dashed rounded-md bg-muted/20">
                        No hay turnos disponibles en los próximos 30 días.
                      </div>
                    ) : (
                      <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-1.5">
                        {sugerencias.map(({ grupo, item }) => {
                          const activo =
                            selectedTurnera === item.turnera.id &&
                            selectedGrupo === grupo.key &&
                            form.watch("fecha") === item.proximoDisponible!.fecha &&
                            form.watch("horaInicio") === item.proximoDisponible!.hora;
                          return (
                            <button
                              key={`${grupo.key}-${item.turnera.id}-${item.proximoDisponible!.fecha}-${item.proximoDisponible!.hora}`}
                              type="button"
                              onClick={() => usarProximoDisponible(item, grupo.key)}
                              className={`group relative aspect-square flex flex-col items-center justify-center gap-0.5 rounded-md border p-1 text-center transition-all duration-150 hover:z-30 hover:scale-105 hover:border-primary/60 hover:bg-primary/5 focus-visible:z-30 focus-visible:scale-105 ${
                                activo ? "border-primary ring-2 ring-primary/30 bg-primary/5" : ""
                              }`}
                              data-testid={`sugerencia-${grupo.key}`}
                            >
                              <span className="text-[11px] font-semibold text-primary leading-tight">
                                {formatearFechaCorta(item.proximoDisponible!.fecha)}
                              </span>
                              <span className="text-[11px] font-medium leading-tight">
                                {item.proximoDisponible!.hora} hs
                              </span>
                              <span className="text-[9px] text-muted-foreground leading-tight truncate w-full">
                                {grupo.nombre.replace(/^Dr\/a\. /, "")}
                              </span>
                              <span className="text-[11px] text-red-600 dark:text-red-400 font-semibold leading-tight line-clamp-2 w-full">
                                {item.turnera.sede?.nombre ?? ""}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* Próximos huecos libres del profesional/agenda elegida */}
                {grupoParaHuecos && (
                  <div className="space-y-2" data-testid="huecos-grupo">
                    <p className="text-sm font-medium text-muted-foreground">
                      Huecos libres de {grupoParaHuecos.nombre}
                    </p>
                    {loadingHuecos ? (
                      <div className="text-sm text-muted-foreground p-2">Buscando huecos libres…</div>
                    ) : (huecosGrupo ?? []).length === 0 ? (
                      <div className="text-sm text-muted-foreground text-center p-3 border border-dashed rounded-md bg-muted/20">
                        Sin huecos libres en los próximos 30 días.
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {(huecosGrupo ?? []).map((h) => {
                          const activo =
                            selectedTurnera === h.turneraId &&
                            form.watch("fecha") === h.fecha &&
                            form.watch("horaInicio") === h.hora;
                          return (
                            <button
                              key={`${h.turneraId}-${h.fecha}-${h.hora}`}
                              type="button"
                              onClick={() => usarHueco(h)}
                              className={`rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all hover:border-primary/60 hover:bg-primary/5 ${
                                activo ? "border-primary ring-2 ring-primary/30 bg-primary/5" : ""
                              }`}
                              data-testid={`hueco-${h.fecha}-${h.hora}`}
                            >
                              <span className="text-primary font-semibold">{formatearFechaCorta(h.fecha)}</span>
                              {" · "}{h.hora} hs
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* Turno elegido + acceso a la turnera completa del profesional */}
                {form.watch("fecha") && form.watch("horaInicio") && grupoSeleccionado ? (
                  <div
                    className="flex items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2"
                    data-testid="resumen-turno-elegido"
                  >
                    <div className="flex items-center gap-2 min-w-0 text-sm">
                      <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                      <span className="truncate">
                        <span className="font-medium">{grupoSeleccionado.nombre}</span>
                        {" — "}
                        {formatearFechaCorta(form.watch("fecha"))} · {form.watch("horaInicio").substring(0, 5)} hs
                      </span>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-xs shrink-0"
                      onClick={() => setTurneraAbierta(true)}
                      data-testid="boton-cambiar-horario"
                    >
                      Cambiar
                    </Button>
                  </div>
                ) : null}

                {selectedEspecialidad && grupos.length > 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      if (!grupoSeleccionado && grupos.length === 1) seleccionarGrupo(grupos[0]);
                      setTurneraAbierta(true);
                    }}
                    data-testid="boton-turnera-completa"
                  >
                    <CalendarIcon className="w-4 h-4 mr-2" />
                    Quiero ver la turnera completa
                  </Button>
                )}

              </CardContent>
              <CardFooter className="bg-muted/20 py-4 border-t">
                <Button type="submit" className="w-full" disabled={createMutation.isPending}>
                  {createMutation.isPending ? "Guardando..." : "Confirmar Turno"}
                </Button>
              </CardFooter>
            </Card>
          </div>
        </form>
      </Form>

      {/* Turnera completa del profesional en pantalla entera */}
      <Dialog open={turneraAbierta} onOpenChange={setTurneraAbierta}>
        <DialogContent className="max-w-[96vw] w-[96vw] h-[94vh] flex flex-col p-0 gap-0">
          <DialogHeader className="px-6 py-4 border-b shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <CalendarIcon className="w-5 h-5 text-primary" />
              Turnera completa
              {grupoSeleccionado ? ` — ${grupoSeleccionado.nombre}` : ""}
            </DialogTitle>
          </DialogHeader>

          <div className="flex-1 min-h-0 flex flex-col gap-4 px-6 py-4 overflow-hidden">
            {/* Profesionales de la especialidad */}
            {grupos.length > 1 && (
              <div className="flex flex-wrap gap-2 shrink-0">
                {grupos.map((g) => (
                  <Button
                    key={g.key}
                    type="button"
                    size="sm"
                    variant={selectedGrupo === g.key ? "default" : "outline"}
                    onClick={() => seleccionarGrupo(g)}
                    data-testid={`turnera-medico-${g.key}`}
                  >
                    {g.nombre}
                  </Button>
                ))}
              </div>
            )}

            {!grupoSeleccionado ? (
              <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground border border-dashed rounded-lg">
                Elegí un profesional para ver su turnera.
              </div>
            ) : (
              <>
                {/* Días de atención */}
                <div className="shrink-0 space-y-1.5">
                  <p className="text-sm font-medium flex items-center gap-2">
                    <CalendarIcon className="w-4 h-4 text-primary" /> Días de atención
                  </p>
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {proximasFechasGrupo.length === 0 ? (
                      <span className="text-sm text-muted-foreground">
                        Este profesional no tiene días de atención próximos.
                      </span>
                    ) : (
                      proximasFechasGrupo.map((f) => (
                        <Button
                          key={f}
                          type="button"
                          size="sm"
                          variant={selectedFecha === f ? "default" : "outline"}
                          className={`shrink-0 ${
                            selectedFecha !== f && ocupacionPorFecha.get(f)
                              ? CLASE_OCUPACION[ocupacionPorFecha.get(f)!]
                              : ""
                          }`}
                          onClick={() => {
                            setSelectedFecha(f);
                            form.setValue("fecha", f);
                            form.setValue("horaInicio", "");
                            const item = resolverTurneraParaFecha(grupoSeleccionado, f);
                            setSelectedTurnera(item ? item.turnera.id : null);
                            form.setValue("turneraId", item ? item.turnera.id : (0 as unknown as number));
                          }}
                          data-testid={`turnera-dia-${f}`}
                        >
                          {formatearFechaCorta(f)}
                        </Button>
                      ))
                    )}
                  </div>
                </div>

                {/* Horarios del día */}
                <div className="flex-1 min-h-0 flex flex-col space-y-1.5">
                  <p className="text-sm font-medium flex items-center gap-2">
                    <Clock className="w-4 h-4 text-primary" /> Horarios
                    {selectedFecha ? ` del ${formatearFechaCorta(selectedFecha)}` : ""}
                  </p>
                  {!selectedTurnera || !selectedFecha ? (
                    <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground border border-dashed rounded-lg">
                      Elegí un día para ver los horarios.
                    </div>
                  ) : loadingSlots ? (
                    <div className="flex-1 flex items-center justify-center text-sm">Cargando horarios...</div>
                  ) : slots && slots.some((s) => s.disponible) ? (
                    <ScrollArea className="flex-1 rounded-md border p-3">
                      <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-2">
                        {slots.map((slot, idx) => (
                          <Button
                            key={idx}
                            type="button"
                            variant={form.watch("horaInicio") === slot.horaInicio ? "default" : "outline"}
                            className={`w-full ${!slot.disponible ? "opacity-40" : ""}`}
                            disabled={!slot.disponible}
                            onClick={() => form.setValue("horaInicio", slot.horaInicio)}
                            data-testid={`turnera-slot-${slot.horaInicio}`}
                          >
                            {slot.horaInicio.substring(0, 5)}
                          </Button>
                        ))}
                      </div>
                    </ScrollArea>
                  ) : (
                    <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground border border-dashed rounded-lg bg-muted/20">
                      No hay horarios para esta fecha.
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Selección + confirmar */}
          <div className="shrink-0 border-t bg-muted/20 px-6 py-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm min-w-0">
              {grupoSeleccionado && form.watch("fecha") && form.watch("horaInicio") ? (
                <>
                  <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                  <span className="truncate">
                    <span className="font-medium">{grupoSeleccionado.nombre}</span>
                    {" — "}
                    {formatearFechaCorta(form.watch("fecha"))} · {form.watch("horaInicio").substring(0, 5)} hs
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">Elegí un día y un horario para confirmar el turno.</span>
              )}
            </div>
            <Button
              type="button"
              className="min-w-[180px]"
              disabled={createMutation.isPending || !form.watch("fecha") || !form.watch("horaInicio")}
              onClick={() => form.handleSubmit(onSubmit, onInvalid)()}
              data-testid="boton-confirmar-turnera"
            >
              {createMutation.isPending ? "Guardando..." : "Confirmar Turno"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
