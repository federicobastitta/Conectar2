import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Users, Plus, Calendar, MapPin, Clock, ChevronRight } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ICON_MAP: Record<string, string> = {
  "Psicología": "🧠",
  "Nutrición": "🥗",
  "Embarazo": "🤰",
  "Diabetes": "💉",
  "Cesación tabáquica": "🚭",
  "Preparación quirúrgica": "🏥",
  "Cardiología preventiva": "❤️",
};

const MOCK_GRUPOS = [
  {
    id: 1,
    nombre: "Grupo de Psicología — Ansiedad y estrés",
    categoria: "Psicología",
    profesional: "Lic. Valeria Suárez",
    sede: "Sede Centro",
    dia: "Martes",
    hora: "18:00",
    duracion: "90 min",
    cupo: 12,
    inscriptos: 8,
    estado: "activo",
    proximaSesion: "2025-07-09",
  },
  {
    id: 2,
    nombre: "Nutrición — Control de peso adultos",
    categoria: "Nutrición",
    profesional: "Lic. Marcela Torres",
    sede: "Sede Norte",
    dia: "Jueves",
    hora: "10:00",
    duracion: "60 min",
    cupo: 15,
    inscriptos: 15,
    estado: "completo",
    proximaSesion: "2025-07-11",
  },
  {
    id: 3,
    nombre: "Preparación para el parto",
    categoria: "Embarazo",
    profesional: "Obs. Carmen Villalobos",
    sede: "Sede Centro",
    dia: "Sábado",
    hora: "09:00",
    duracion: "120 min",
    cupo: 10,
    inscriptos: 6,
    estado: "activo",
    proximaSesion: "2025-07-12",
  },
  {
    id: 4,
    nombre: "Educación diabetológica",
    categoria: "Diabetes",
    profesional: "Dr. Hernán Paz",
    sede: "Sede Norte",
    dia: "Miércoles",
    hora: "16:00",
    duracion: "90 min",
    cupo: 10,
    inscriptos: 4,
    estado: "activo",
    proximaSesion: "2025-07-10",
  },
  {
    id: 5,
    nombre: "Cesación tabáquica",
    categoria: "Cesación tabáquica",
    profesional: "Dra. Ana López",
    sede: "Sede Centro",
    dia: "Lunes",
    hora: "19:00",
    duracion: "60 min",
    cupo: 8,
    inscriptos: 3,
    estado: "activo",
    proximaSesion: "2025-07-14",
  },
];

export default function SalasGrupales() {
  const [grupos] = useState(MOCK_GRUPOS);
  const activos = grupos.filter((g) => g.estado === "activo").length;
  const totalInscriptos = grupos.reduce((sum, g) => sum + g.inscriptos, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Salas Grupales</h1>
          <p className="text-muted-foreground">Grupos terapéuticos, talleres y charlas de salud</p>
        </div>
        <Dialog>
          <DialogTrigger asChild>
            <Button>
              <Plus className="w-4 h-4 mr-2" />
              Nuevo grupo
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Crear nuevo grupo</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-1">
                <Label>Nombre del grupo</Label>
                <Input placeholder="Ej: Grupo de apoyo — adultos mayores" />
              </div>
              <div className="space-y-1">
                <Label>Categoría</Label>
                <Select>
                  <SelectTrigger><SelectValue placeholder="Seleccionar categoría" /></SelectTrigger>
                  <SelectContent>
                    {Object.keys(ICON_MAP).map((cat) => (
                      <SelectItem key={cat} value={cat}>{ICON_MAP[cat]} {cat}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Día</Label>
                  <Select>
                    <SelectTrigger><SelectValue placeholder="Día" /></SelectTrigger>
                    <SelectContent>
                      {["Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"].map((d) => (
                        <SelectItem key={d} value={d}>{d}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Hora</Label>
                  <Input type="time" />
                </div>
              </div>
              <div className="space-y-1">
                <Label>Cupo máximo</Label>
                <Input type="number" min={1} placeholder="Ej: 12" />
              </div>
              <Button className="w-full">Crear grupo</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-emerald-600">{activos}</div>
            <p className="text-sm text-muted-foreground mt-1">Grupos activos</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{totalInscriptos}</div>
            <p className="text-sm text-muted-foreground mt-1">Participantes activos</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-amber-600">
              {grupos.filter((g) => g.estado === "completo").length}
            </div>
            <p className="text-sm text-muted-foreground mt-1">Grupos con lista de espera</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {grupos.map((grupo) => {
          const pct = Math.round((grupo.inscriptos / grupo.cupo) * 100);
          const completo = grupo.estado === "completo";
          return (
            <Card key={grupo.id} className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl">{ICON_MAP[grupo.categoria] || "👥"}</span>
                    <div>
                      <CardTitle className="text-base leading-tight">{grupo.nombre}</CardTitle>
                      <p className="text-sm text-muted-foreground mt-0.5">{grupo.profesional}</p>
                    </div>
                  </div>
                  <Badge variant={completo ? "destructive" : "secondary"} className="shrink-0">
                    {completo ? "Completo" : "Activo"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-2 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5" />
                    {grupo.dia} {grupo.hora}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5" />
                    {grupo.duracion}
                  </span>
                  <span className="flex items-center gap-1.5 col-span-2">
                    <MapPin className="w-3.5 h-3.5" />
                    {grupo.sede}
                  </span>
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Users className="w-3.5 h-3.5" />
                      {grupo.inscriptos} / {grupo.cupo} participantes
                    </span>
                    <span>{pct}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${completo ? "bg-destructive" : "bg-primary"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-muted-foreground">
                    Próxima sesión: {new Date(grupo.proximaSesion + "T00:00:00").toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" })}
                  </span>
                  <Button variant="ghost" size="sm" className="h-7 text-xs gap-1">
                    Ver grupo <ChevronRight className="w-3 h-3" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
