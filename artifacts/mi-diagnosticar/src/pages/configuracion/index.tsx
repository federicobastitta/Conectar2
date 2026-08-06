import { useState, useEffect } from "react";
import { useListSedes, useListEspecialidades, useCreateSede, useCreateEspecialidad, useUpdateSede, useUpdateEspecialidad, useListObrasSociales, useCreateObraSocial } from "@workspace/api-client-react";
import { getListSedesQueryKey, getListEspecialidadesQueryKey, getListObrasSocialesQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Building, Stethoscope, Plus, Save, Loader2, X, Monitor, Sun, Moon, Landmark } from "lucide-react";
import { Link } from "wouter";

const ACCESOS: { label: string; href: string }[] = [
  { label: "Configurar sede", href: "/configuracion/sedes" },
  { label: "Turneras", href: "/turneras" },
  { label: "Profesionales", href: "/profesionales" },
  { label: "Obra Social", href: "/obra-social" },
  { label: "Equivalencias", href: "/configuracion/equivalencias" },
  { label: "Usuarios (Perfiles)", href: "/perfiles" },
  { label: "Consultorios", href: "/consultorios" },
  { label: "Salas de espera (TV)", href: "/salas-llamado" },
  { label: "Agendas activas", href: "/agendas" },
  { label: "Todas las agendas", href: "/agendas/todas" },
  { label: "Escritorio Médico", href: "/escritorio-medico" },
  { label: "Consultorio", href: "/consultorio" },
  { label: "Asistente IA", href: "/asistente" },
  { label: "Estadística", href: "/estadisticas" },
  { label: "Reportes", href: "/estadisticas/reportes" },
  { label: "Importación", href: "/importacion" },
  { label: "Importación administrativa", href: "/configuracion/importacion-admin" },
  { label: "Integración Pulso", href: "/configuracion/pulso" },
  { label: "Robot Klinicos", href: "/configuracion/klinicos" },
  { label: "Worklist PACS", href: "/configuracion/pacs-worklist" },
  { label: "Soporte", href: "/ayuda" },
];

export default function Configuracion() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Configuración</h1>
        <p className="text-muted-foreground">
          Administración de catálogos y entidades base
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {ACCESOS.map((a) => (
          <Link key={a.href} href={a.href}>
            <Button variant="outline" size="sm">{a.label}</Button>
          </Link>
        ))}
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <ThemeSettings />
      </div>

      <CargaObrasSociales />

      <div className="grid lg:grid-cols-2 gap-6">
        <SedesTable />
        <EspecialidadesTable />
      </div>
    </div>
  );
}

const OBRAS_SOCIALES_BASE = ["PAMI", "IOMA", "OSEIV", "OSPIV", "ELEVAR", "PLAN DE SALUD DIAGNOSTICAR"];

function normalizarNombre(s: string) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase();
}

function CargaObrasSociales() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: obras, isLoading } = useListObrasSociales();
  const createOs = useCreateObraSocial();
  const [cargando, setCargando] = useState(false);

  const existentes = new Set((obras ?? []).map((o) => normalizarNombre(o.nombre)));
  const faltantes = OBRAS_SOCIALES_BASE.filter((n) => !existentes.has(normalizarNombre(n)));

  const cargar = async () => {
    setCargando(true);
    let creadas = 0;
    let errores = 0;
    for (const nombre of faltantes) {
      try {
        await createOs.mutateAsync({ data: { nombre } });
        creadas++;
      } catch {
        errores++;
      }
    }
    setCargando(false);
    queryClient.invalidateQueries({ queryKey: getListObrasSocialesQueryKey() });
    if (errores > 0) {
      toast({
        title: "Carga incompleta",
        description: `Se crearon ${creadas} obras sociales, ${errores} fallaron.`,
        variant: "destructive",
      });
    } else {
      toast({
        title: "Obras sociales cargadas",
        description: `Se crearon ${creadas}: ${faltantes.join(", ")}`,
      });
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Landmark className="w-5 h-5 text-primary" /> Obras Sociales
          </CardTitle>
          <CardDescription>
            Carga inicial: {OBRAS_SOCIALES_BASE.join(", ")}
          </CardDescription>
        </div>
        <Button
          onClick={cargar}
          disabled={isLoading || cargando || faltantes.length === 0}
          data-testid="cargar-obras-sociales"
        >
          {cargando ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
          {faltantes.length === 0 && !isLoading ? "Ya cargadas" : "Cargar obras sociales"}
        </Button>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          {isLoading
            ? "Verificando obras sociales existentes…"
            : faltantes.length === 0
              ? "Las obras sociales base ya están cargadas. Podés gestionarlas desde la sección Obra Social."
              : `Faltan cargar: ${faltantes.join(", ")}. Las que ya existen se omiten.`}
        </p>
      </CardContent>
    </Card>
  );
}

function ThemeSettings() {
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") || "dark");

  useEffect(() => {
    const handleMediaChange = (e: MediaQueryListEvent) => {
      if (theme === "auto") {
        if (e.matches) {
          document.documentElement.classList.add("dark");
        } else {
          document.documentElement.classList.remove("dark");
        }
      }
    };
    
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    mql.addEventListener("change", handleMediaChange);
    return () => mql.removeEventListener("change", handleMediaChange);
  }, [theme]);

  const changeTheme = (newTheme: string) => {
    setTheme(newTheme);
    localStorage.setItem("theme", newTheme);
    const dark =
      newTheme === "dark" ||
      (newTheme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  };

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Monitor className="w-5 h-5 text-primary" /> Apariencia
        </CardTitle>
        <CardDescription>Configura el tema de la aplicación</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex gap-4">
          <Button variant={theme === "light" ? "default" : "outline"} onClick={() => changeTheme("light")}>
            <Sun className="w-4 h-4 mr-2" /> Claro
          </Button>
          <Button variant={theme === "dark" ? "default" : "outline"} onClick={() => changeTheme("dark")}>
            <Moon className="w-4 h-4 mr-2" /> Oscuro
          </Button>
          <Button variant={theme === "auto" ? "default" : "outline"} onClick={() => changeTheme("auto")}>
            <Monitor className="w-4 h-4 mr-2" /> Automático
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SedesTable() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: sedes, isLoading } = useListSedes();
  const createMutation = useCreateSede();
  const updateMutation = useUpdateSede();

  const [isAdding, setIsAdding] = useState(false);
  const [newSede, setNewSede] = useState({ nombre: "", activa: true });

  const handleCreate = () => {
    if (!newSede.nombre) return;
    createMutation.mutate({ data: newSede }, {
      onSuccess: () => {
        setIsAdding(false);
        setNewSede({ nombre: "", activa: true });
        queryClient.invalidateQueries({ queryKey: getListSedesQueryKey() });
        toast({ title: "Sede creada" });
      }
    });
  };

  const handleToggle = (id: number, activa: boolean) => {
    updateMutation.mutate({ id, data: { activa: !activa } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSedesQueryKey() });
      }
    });
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Building className="w-5 h-5 text-primary" /> Sedes
          </CardTitle>
          <CardDescription>Ubicaciones físicas de atención</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => setIsAdding(true)} disabled={isAdding}>
          <Plus className="w-4 h-4 mr-1" /> Añadir
        </Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nombre</TableHead>
              <TableHead className="text-center w-24">Activa</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isAdding && (
              <TableRow>
                <TableCell>
                  <Input 
                    autoFocus
                    placeholder="Nombre de sede..." 
                    value={newSede.nombre} 
                    onChange={e => setNewSede(prev => ({...prev, nombre: e.target.value}))}
                    onKeyDown={e => e.key === 'Enter' && handleCreate()}
                  />
                </TableCell>
                <TableCell className="text-center">
                  <div className="flex items-center justify-center gap-2">
                    <Button variant="ghost" size="icon" onClick={() => setIsAdding(false)}>
                      <X className="w-4 h-4 text-muted-foreground" />
                    </Button>
                    <Button size="icon" onClick={handleCreate} disabled={createMutation.isPending || !newSede.nombre}>
                      {createMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )}
            
            {isLoading && !isAdding ? (
              <TableRow><TableCell colSpan={2} className="text-center py-4">Cargando...</TableCell></TableRow>
            ) : (
              sedes?.map(sede => (
                <TableRow key={sede.id} className={!sede.activa ? "opacity-60" : ""}>
                  <TableCell className="font-medium">{sede.nombre}</TableCell>
                  <TableCell className="text-center">
                    <Switch checked={sede.activa} onCheckedChange={() => handleToggle(sede.id, sede.activa)} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function EspecialidadesTable() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: especialidades, isLoading } = useListEspecialidades();
  const createMutation = useCreateEspecialidad();

  const [isAdding, setIsAdding] = useState(false);
  const [newEsp, setNewEsp] = useState({ nombre: "", color: "#3b82f6" });

  const handleCreate = () => {
    if (!newEsp.nombre) return;
    createMutation.mutate({ data: newEsp }, {
      onSuccess: () => {
        setIsAdding(false);
        setNewEsp({ nombre: "", color: "#3b82f6" });
        queryClient.invalidateQueries({ queryKey: getListEspecialidadesQueryKey() });
        toast({ title: "Especialidad creada" });
      }
    });
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Stethoscope className="w-5 h-5 text-primary" /> Especialidades
          </CardTitle>
          <CardDescription>Especialidades médicas del centro</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => setIsAdding(true)} disabled={isAdding}>
          <Plus className="w-4 h-4 mr-1" /> Añadir
        </Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nombre</TableHead>
              <TableHead className="w-16">Color</TableHead>
              {isAdding && <TableHead className="w-24 text-right">Acción</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isAdding && (
              <TableRow>
                <TableCell>
                  <Input 
                    autoFocus
                    placeholder="Especialidad..." 
                    value={newEsp.nombre} 
                    onChange={e => setNewEsp(prev => ({...prev, nombre: e.target.value}))}
                    onKeyDown={e => e.key === 'Enter' && handleCreate()}
                  />
                </TableCell>
                <TableCell>
                  <Input 
                    type="color" 
                    className="w-8 h-8 p-0 border-0" 
                    value={newEsp.color} 
                    onChange={e => setNewEsp(prev => ({...prev, color: e.target.value}))}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="icon" onClick={() => setIsAdding(false)}>
                      <X className="w-4 h-4" />
                    </Button>
                    <Button size="icon" onClick={handleCreate} disabled={createMutation.isPending || !newEsp.nombre}>
                      {createMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )}
            
            {isLoading && !isAdding ? (
              <TableRow><TableCell colSpan={3} className="text-center py-4">Cargando...</TableCell></TableRow>
            ) : (
              especialidades?.map(esp => (
                <TableRow key={esp.id}>
                  <TableCell className="font-medium">{esp.nombre}</TableCell>
                  <TableCell>
                    <div className="w-6 h-6 rounded-full border" style={{ backgroundColor: esp.color || '#cbd5e1' }} />
                  </TableCell>
                  {isAdding && <TableCell></TableCell>}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
