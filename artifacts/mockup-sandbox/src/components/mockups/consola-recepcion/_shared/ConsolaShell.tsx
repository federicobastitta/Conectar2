import React, { useState } from "react";
import {
  Bell,
  Search,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  FileText,
  CreditCard,
  User as UserIcon,
  Phone,
  ChevronDown,
  ChevronUp,
  Activity,
  Server,
  Wifi,
  ChevronRight,
  ChevronLeft,
  Copy,
  ExternalLink,
  RotateCcw,
  Stethoscope,
  Info
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export type ViewState = 
  | "completa" 
  | "token-pendiente" 
  | "token-aceptado" 
  | "manual" 
  | "error" 
  | "revision";

interface ConsolaShellProps {
  viewState: ViewState;
  tabletMode?: boolean;
}

const FAKE_QUEUE = [
  { time: "08:00", patient: "PÉREZ, J. C.", dni: "28.***.451", prof: "Dr. Giménez", esp: "Cardiología", cob: "IOMA", state: "Agendado", stateColor: "gray", wait: "-" },
  { time: "08:15", patient: "GÓMEZ, M. L.", dni: "31.***.902", prof: "Dr. Giménez", esp: "Cardiología", cob: "OSDE 210", state: "Recepcionado", stateColor: "green", wait: "10 min" },
  { time: "08:30", patient: "LÓPEZ, A. R.", dni: "14.***.111", prof: "Dra. Silva", esp: "Dermatología", cob: "IOMA", state: "Requiere KLINICOS", stateColor: "amber", wait: "5 min", alert: true },
  { time: "08:45", patient: "MARTÍNEZ, S.", dni: "40.***.555", prof: "Dra. Silva", esp: "Dermatología", cob: "Particular", state: "Ausente", stateColor: "gray", wait: "-" },
  { time: "09:00", patient: "RODRÍGUEZ, E.", dni: "22.***.333", prof: "Dr. Giménez", esp: "Cardiología", cob: "IOMA", state: "Revisión manual", stateColor: "purple", wait: "15 min" },
  { time: "09:15", patient: "FERNÁNDEZ, P.", dni: "35.***.777", prof: "Dr. Giménez", esp: "Cardiología", cob: "PAMI", state: "Token pendiente", stateColor: "gray", wait: "-" },
  { time: "09:30", patient: "DÍAZ, M. J.", dni: "29.***.888", prof: "Dra. Silva", esp: "Dermatología", cob: "IOMA", state: "Token aceptado", stateColor: "green", wait: "-" },
  { time: "09:45", patient: "ALONSO, C.", dni: "18.***.222", prof: "Dr. Giménez", esp: "Cardiología", cob: "IOMA", state: "Error técnico", stateColor: "orange", wait: "-" },
  { time: "10:00", patient: "TORRES, L.", dni: "42.***.123", prof: "Dra. Silva", esp: "Dermatología", cob: "OSDE 310", state: "Agendado", stateColor: "gray", wait: "-" },
  { time: "10:15", patient: "RUIZ, G.", dni: "25.***.444", prof: "Dr. Giménez", esp: "Cardiología", cob: "IOMA", state: "Cancelado", stateColor: "gray", wait: "-" },
];

export function ConsolaShell({ viewState, tabletMode = false }: ConsolaShellProps) {
  const [bottomExpanded, setBottomExpanded] = useState(viewState === "revision");
  const [datosExpanded, setDatosExpanded] = useState(true);
  const [cobExpanded, setCobExpanded] = useState(true);
  const [docExpanded, setDocExpanded] = useState(true);

  const getStatusBadgeProps = (status: string) => {
    switch (status) {
      case "Aceptado":
      case "Recepcionado":
      case "Token aceptado": return { className: "bg-green-100 text-green-800 border-green-200" };
      case "Denegado": return { className: "bg-red-100 text-red-800 border-red-200" };
      case "Requiere KLINICOS":
      case "Requiere carga manual": return { className: "bg-amber-100 text-amber-800 border-amber-200" };
      case "Error técnico": return { className: "bg-orange-100 text-orange-800 border-orange-200" };
      case "Revisión manual": return { className: "bg-purple-100 text-purple-800 border-purple-200" };
      default: return { className: "bg-gray-100 text-gray-800 border-gray-200" };
    }
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-screen w-full bg-[#f8f9fa] text-sm overflow-hidden font-sans">
        {/* TOP BAR */}
        <header className="flex-none h-12 bg-white border-b flex items-center px-4 justify-between shadow-sm z-10 shrink-0">
          <div className="flex items-center gap-4">
            <div className="font-bold text-blue-600 text-base tracking-tight">Conectar</div>
            <div className="h-4 w-px bg-gray-300" />
            <div className="flex items-center text-xs text-gray-600 gap-3">
              <span className="font-medium text-gray-900">Sede Centro</span>
              <span>Recepción</span>
              <div className="flex items-center gap-1">
                <UserIcon className="w-3 h-3" />
                <span>M. González</span>
              </div>
              <span>{new Date().toLocaleDateString("es-AR")} {new Date().toLocaleTimeString("es-AR", { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          </div>
          
          <div className="flex flex-1 max-w-lg mx-6 items-center">
            <div className="relative w-full">
              <Search className="w-4 h-4 absolute left-2.5 top-2 text-gray-400" />
              <Input 
                className="w-full h-8 pl-9 bg-gray-50 border-gray-200 focus-visible:ring-1 text-xs" 
                placeholder="Buscar por DNI, apellido, afiliado, teléfono… (F2 o /)"
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1.5 px-2 py-1 bg-green-50 rounded-full border border-green-100 cursor-default">
                    <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                    <Server className="w-3 h-3 text-green-700" />
                    <span className="text-[10px] font-medium text-green-700">El Robot</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent>Disponible</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1.5 px-2 py-1 bg-green-50 rounded-full border border-green-100 cursor-default">
                    <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                    <Activity className="w-3 h-3 text-green-700" />
                    <span className="text-[10px] font-medium text-green-700">KLINICOS</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent>Disponible</TooltipContent>
              </Tooltip>
            </div>
            
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="sm" className="h-8 text-xs bg-blue-600 hover:bg-blue-700">Nueva atención</Button>
              </TooltipTrigger>
              <TooltipContent>Alt+N</TooltipContent>
            </Tooltip>
            
            <Button variant="ghost" size="icon" className="h-8 w-8 relative text-gray-500">
              <Bell className="w-4 h-4" />
              <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full border border-white" />
            </Button>
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden">
          {/* LEFT PANEL */}
          <aside className={`flex flex-col bg-white border-r transition-all duration-200 ${tabletMode ? 'w-12 items-center' : 'w-80'}`}>
            {!tabletMode ? (
              <>
                <div className="p-3 border-b bg-gray-50/50">
                  <h2 className="font-semibold text-gray-800 mb-2">Cola operativa</h2>
                  <div className="flex flex-wrap gap-1">
                    {["Todos", "Agendados", "Recepcionados", "Token pend.", "Token acept.", "Req. KLINICOS", "Revisión man.", "Ausentes", "Cancelados"].map((f, i) => (
                      <Badge key={i} variant="outline" className={`text-[10px] px-1.5 py-0 cursor-pointer hover:bg-gray-100 ${i===0 ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white text-gray-600'}`}>
                        {f}
                      </Badge>
                    ))}
                  </div>
                </div>
                <ScrollArea className="flex-1">
                  <div className="flex flex-col">
                    {FAKE_QUEUE.map((item, i) => (
                      <div key={i} className={`flex flex-col p-2 border-b cursor-pointer hover:bg-gray-50 ${i === 2 ? 'bg-blue-50/40 border-l-2 border-l-blue-500' : ''}`}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-medium text-gray-900 text-xs">{item.time} - {item.patient}</span>
                          {item.alert && <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />}
                        </div>
                        <div className="flex items-center text-[10px] text-gray-500 gap-2 mb-1.5">
                          <span>{item.dni}</span>
                          <span>•</span>
                          <span className="truncate">{item.prof} ({item.esp})</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            <Badge variant="outline" className="text-[9px] px-1 py-0 border-gray-200">{item.cob}</Badge>
                            <Badge variant="outline" className={`text-[9px] px-1 py-0 ${getStatusBadgeProps(item.state).className}`}>{item.state}</Badge>
                          </div>
                          {item.wait !== "-" && <span className="text-[10px] text-gray-400"><Clock className="w-3 h-3 inline mr-0.5" />{item.wait}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </>
            ) : (
              <div className="flex flex-col items-center py-4 gap-4">
                <Button variant="ghost" size="icon" className="h-8 w-8"><UserIcon className="h-4 w-4" /></Button>
                <Button variant="ghost" size="icon" className="h-8 w-8"><FileText className="h-4 w-4" /></Button>
              </div>
            )}
          </aside>

          {/* CENTER PANEL */}
          <main className="flex-1 flex flex-col min-w-0 bg-white relative">
            <ScrollArea className="flex-1">
              <div className="p-5 max-w-4xl mx-auto w-full">
                {/* Fixed Header equivalent */}
                <div className="flex items-start justify-between mb-6">
                  <div>
                    <div className="flex items-center gap-3 mb-1">
                      <h1 className="text-xl font-bold text-gray-900">LÓPEZ, Ana Rosa</h1>
                      <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 text-xs">
                        <AlertTriangle className="w-3 h-3 mr-1" /> Posible duplicado
                      </Badge>
                    </div>
                    <div className="flex flex-wrap items-center text-xs text-gray-600 gap-x-4 gap-y-1">
                      <span>DNI: 14.283.111</span>
                      <span>Nac: 12/05/1961 (64 años)</span>
                      <div className="flex items-center gap-1">
                        <CreditCard className="w-3 h-3 text-gray-400" />
                        <span className="font-medium text-gray-900">IOMA</span>
                      </div>
                      <span>Afil: 0014283111/01</span>
                      <div className="flex items-center gap-1">
                        <Phone className="w-3 h-3 text-gray-400" />
                        <span>221-555-1234</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-3">
                  <Collapsible open={datosExpanded} onOpenChange={setDatosExpanded} className="border rounded-md bg-white shadow-sm">
                    <CollapsibleTrigger className="flex items-center justify-between w-full p-2.5 bg-gray-50/50 hover:bg-gray-50 border-b">
                      <span className="font-semibold text-gray-800 text-xs">Datos de la atención</span>
                      {datosExpanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                    </CollapsibleTrigger>
                    <CollapsibleContent className="p-3">
                      <div className="grid grid-cols-3 gap-y-3 gap-x-6 text-xs">
                        <div><span className="text-gray-500 block mb-0.5">Fecha y Hora</span><span className="font-medium">15/07/2026 08:30</span></div>
                        <div><span className="text-gray-500 block mb-0.5">Sede / Sector</span><span className="font-medium">Sede Centro - Recepción</span></div>
                        <div><span className="text-gray-500 block mb-0.5">Profesional</span><span className="font-medium">Dra. Silva, María</span></div>
                        <div><span className="text-gray-500 block mb-0.5">Especialidad</span><span className="font-medium">Dermatología</span></div>
                        <div><span className="text-gray-500 block mb-0.5">Práctica</span><span className="font-medium">Consulta Médica (42.01.01)</span></div>
                        <div><span className="text-gray-500 block mb-0.5">Modalidad</span><span className="font-medium">Presencial</span></div>
                        <div><span className="text-gray-500 block mb-0.5">CIE-10</span><span className="font-medium">L20.9 - Dermatitis atópica</span></div>
                        <div className="col-span-2"><span className="text-gray-500 block mb-0.5">Motivo</span><span className="font-medium">Control de lunares</span></div>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>

                  <Collapsible open={cobExpanded} onOpenChange={setCobExpanded} className="border rounded-md bg-white shadow-sm">
                    <CollapsibleTrigger className="flex items-center justify-between w-full p-2.5 bg-gray-50/50 hover:bg-gray-50 border-b">
                      <span className="font-semibold text-gray-800 text-xs">Cobertura</span>
                      {cobExpanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                    </CollapsibleTrigger>
                    <CollapsibleContent className="p-3">
                      <div className="grid grid-cols-3 gap-y-3 gap-x-6 text-xs">
                        <div><span className="text-gray-500 block mb-0.5">Obra Social</span><span className="font-medium">IOMA</span></div>
                        <div><span className="text-gray-500 block mb-0.5">Plan</span><span className="font-medium">Obligatorio</span></div>
                        <div><span className="text-gray-500 block mb-0.5">Condición IVA</span><span className="font-medium">Consumidor Final</span></div>
                        <div><span className="text-gray-500 block mb-0.5">Nº Afiliado</span><span className="font-medium">0014283111/01</span></div>
                        <div><span className="text-gray-500 block mb-0.5">Autorización</span><span className="font-medium text-gray-400">-</span></div>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>

                  <Collapsible open={docExpanded} onOpenChange={setDocExpanded} className="border rounded-md bg-white shadow-sm">
                    <CollapsibleTrigger className="flex items-center justify-between w-full p-2.5 bg-gray-50/50 hover:bg-gray-50 border-b">
                      <span className="font-semibold text-gray-800 text-xs">Documentación</span>
                      {docExpanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                    </CollapsibleTrigger>
                    <CollapsibleContent className="p-3">
                      <div className="flex gap-4 text-xs">
                        <div className="flex items-center gap-1.5 text-green-700 bg-green-50 px-2 py-1 rounded border border-green-100">
                          <CheckCircle2 className="w-3.5 h-3.5" /> DNI
                        </div>
                        <div className="flex items-center gap-1.5 text-green-700 bg-green-50 px-2 py-1 rounded border border-green-100">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Credencial
                        </div>
                        <div className="flex items-center gap-1.5 text-red-700 bg-red-50 px-2 py-1 rounded border border-red-100">
                          <XCircle className="w-3.5 h-3.5" /> Orden Médica (Faltante)
                        </div>
                        <Button variant="ghost" size="sm" className="h-6 text-xs ml-auto text-blue-600">Ver archivos</Button>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </div>

                {/* Acciones */}
                <div className="mt-6 flex flex-wrap gap-2 pt-4 border-t">
                  <Tooltip><TooltipTrigger asChild><Button size="sm" className="bg-blue-600 hover:bg-blue-700" disabled={viewState !== "token-aceptado" && viewState !== "revision"}>Recepcionar</Button></TooltipTrigger><TooltipContent>Alt+R</TooltipContent></Tooltip>
                  <Tooltip><TooltipTrigger asChild><Button size="sm" variant="outline">Guardar</Button></TooltipTrigger><TooltipContent>Alt+G</TooltipContent></Tooltip>
                  <Button size="sm" variant="outline" className="text-gray-600">Marcar ausente</Button>
                  <Button size="sm" variant="outline" className="text-red-600 hover:text-red-700 hover:bg-red-50">Cancelar turno</Button>
                  {viewState !== "revision" && <Button size="sm" variant="ghost" className="text-purple-600 hover:text-purple-700 hover:bg-purple-50 ml-auto">Enviar a revisión</Button>}
                </div>
              </div>
            </ScrollArea>

            {/* Bottom Tray */}
            <div className="border-t bg-white shrink-0">
              <div 
                className="px-4 py-2 flex items-center justify-between cursor-pointer hover:bg-gray-50"
                onClick={() => setBottomExpanded(!bottomExpanded)}
              >
                <span className="font-semibold text-xs text-gray-700">Actividad de la atención</span>
                {bottomExpanded ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronUp className="w-4 h-4 text-gray-500" />}
              </div>
              {bottomExpanded && (
                <div className="px-4 pb-4 max-h-48 overflow-y-auto">
                  <div className="space-y-3 relative before:absolute before:inset-0 before:ml-2 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-slate-300 before:to-transparent">
                    <div className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active">
                      <div className="flex items-center justify-center w-4 h-4 rounded-full border border-white bg-slate-300 group-[.is-active]:bg-blue-500 text-slate-500 group-[.is-active]:text-white shadow shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 z-10"></div>
                      <div className="w-[calc(100%-2rem)] md:w-[calc(50%-1.5rem)] bg-white p-2 rounded border shadow-sm text-xs">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-medium text-gray-900">Validación de Token KLINICOS</span>
                          <time className="text-gray-500 text-[10px]">08:25</time>
                        </div>
                        <p className="text-gray-600">Sistema: Denegado. Afiliado inactivo.</p>
                      </div>
                    </div>
                    <div className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group">
                      <div className="flex items-center justify-center w-4 h-4 rounded-full border border-white bg-slate-300 text-slate-500 shadow shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 z-10"></div>
                      <div className="w-[calc(100%-2rem)] md:w-[calc(50%-1.5rem)] bg-white p-2 rounded border shadow-sm text-xs">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-medium text-gray-900">Turno agendado</span>
                          <time className="text-gray-500 text-[10px]">Ayer 14:30</time>
                        </div>
                        <p className="text-gray-600">M. González (Recepción)</p>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </main>

          {/* RIGHT PANEL - IOMA/KLINICOS */}
          <aside className={`w-[360px] bg-slate-50 border-l flex flex-col shrink-0 ${tabletMode ? 'absolute right-0 h-full shadow-xl z-20' : ''}`}>
            <div className="p-3 border-b bg-white flex items-center justify-between">
              <h2 className="font-semibold text-gray-800 text-sm">Validación IOMA / KLINICOS</h2>
              {tabletMode && <Button variant="ghost" size="icon" className="h-6 w-6"><ChevronRight className="h-4 w-4" /></Button>}
            </div>
            <ScrollArea className="flex-1">
              <div className="p-4 flex flex-col gap-4">
                
                {/* Servicios */}
                <div className="bg-white rounded-md border p-3 text-xs">
                  <div className="font-medium text-gray-700 mb-2 flex items-center justify-between">
                    Estado de servicios
                    <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 text-[9px] px-1 py-0">En línea</Badge>
                  </div>
                  <div className="flex flex-col gap-1.5 text-gray-600">
                    <div className="flex justify-between"><span>Sesión KLINICOS:</span><span className="font-medium text-gray-900">Activa (M. González)</span></div>
                    <div className="flex justify-between"><span>Última comp.:</span><span>Hace 2 min</span></div>
                    <div className="flex justify-between"><span>Latencia:</span><span className="text-green-600">45ms</span></div>
                  </div>
                </div>

                {/* Datos a enviar */}
                <div className="bg-white rounded-md border p-3 text-xs">
                  <div className="font-medium text-gray-700 mb-2">Datos que se enviarán</div>
                  <div className="grid grid-cols-2 gap-y-2 text-gray-600">
                    <div className="flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> DNI</div>
                    <div className="flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> Afiliado</div>
                    <div className="flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> Profesional</div>
                    <div className="flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> Sede</div>
                    {viewState === "manual" ? (
                      <div className="flex items-center gap-1.5 col-span-2 text-amber-600 font-medium">
                        <AlertTriangle className="w-3.5 h-3.5" /> Práctica (Pendiente equivalencia)
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 col-span-2"><CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> Práctica (42.01.01)</div>
                    )}
                  </div>
                </div>

                {/* Token Section */}
                <div className="bg-white rounded-md border p-3 flex flex-col gap-3">
                  <div className="font-medium text-gray-700 text-xs">Validación de Token</div>
                  
                  {viewState === "completa" && (
                    <>
                      <div className="flex gap-2">
                        <Input placeholder="Ingrese token (6 dígitos)" className="h-8 text-xs font-mono text-center tracking-widest" maxLength={6} />
                        <Tooltip><TooltipTrigger asChild><Button size="sm" className="h-8">Validar</Button></TooltipTrigger><TooltipContent>Alt+V</TooltipContent></Tooltip>
                      </div>
                      <Badge variant="outline" className="w-fit bg-gray-100 text-gray-600 border-gray-200">
                        <Clock className="w-3 h-3 mr-1" /> Pendiente
                      </Badge>
                    </>
                  )}

                  {viewState === "token-pendiente" && (
                    <>
                      <div className="flex gap-2">
                        <Input value="557788" readOnly className="h-8 text-xs font-mono text-center tracking-widest bg-gray-50 text-gray-500" />
                        <Button size="sm" className="h-8" disabled>
                          <RotateCcw className="w-3.5 h-3.5 mr-1 animate-spin" /> Validando...
                        </Button>
                      </div>
                      <Badge variant="outline" className="w-fit bg-blue-50 text-blue-700 border-blue-200">
                        <RotateCcw className="w-3 h-3 mr-1 animate-spin" /> Validando en KLINICOS
                      </Badge>
                    </>
                  )}

                  {viewState === "token-aceptado" && (
                    <>
                      <div className="flex gap-2">
                        <Input value="••7788" readOnly className="h-8 text-xs font-mono text-center tracking-widest bg-gray-50 text-gray-500" />
                        <Button size="sm" className="h-8 bg-green-600 hover:bg-green-700" disabled>Validado</Button>
                      </div>
                      <Badge variant="outline" className="w-fit bg-green-50 text-green-700 border-green-200">
                        <CheckCircle2 className="w-3 h-3 mr-1" /> Aceptado
                      </Badge>
                      <div className="bg-green-50/50 rounded border border-green-100 p-2 text-xs flex flex-col gap-1 mt-1 text-green-900">
                        <div className="flex justify-between"><span>Autorización:</span><span className="font-mono font-medium">A-2026-118437</span></div>
                        <div className="flex justify-between"><span>Ref. KLINICOS:</span><span className="font-mono text-gray-500">KL-992341</span></div>
                        <div className="flex justify-between"><span>Bono:</span><span>Generado</span></div>
                      </div>
                    </>
                  )}

                  {viewState === "manual" && (
                    <>
                      <Badge variant="outline" className="w-fit bg-amber-50 text-amber-700 border-amber-200">
                        <AlertTriangle className="w-3 h-3 mr-1" /> Requiere carga manual
                      </Badge>
                      <div className="bg-amber-50 rounded border border-amber-200 p-2.5 text-xs text-amber-900">
                        <p className="mb-2">La prestación no se encuentra disponible en KLINICOS. Ingresá a KLINICOS, cargala manualmente y luego regresá para reintentar la validación.</p>
                        <div className="bg-white p-2 rounded border border-amber-100 font-mono text-[10px] text-gray-600 mb-2 relative group">
                          DNI: 14283111<br/>
                          Afil: 0014283111/01<br/>
                          Práctica: 42.01.01<br/>
                          Prof: Silva, María<br/>
                          CIE-10: L20.9
                          <Button size="icon" variant="ghost" className="h-5 w-5 absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity"><Copy className="h-3 w-3"/></Button>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <div className="flex gap-1.5">
                            <Button size="sm" variant="outline" className="flex-1 h-7 bg-white hover:bg-amber-100 text-amber-700 border-amber-300">
                              <Copy className="w-3 h-3 mr-1.5" /> Copiar datos
                            </Button>
                            <Button size="sm" variant="outline" className="flex-1 h-7 bg-white hover:bg-amber-100 text-amber-700 border-amber-300">
                              <ExternalLink className="w-3 h-3 mr-1.5" /> Abrir KLINICOS
                            </Button>
                          </div>
                          <Button size="sm" className="w-full h-7 bg-amber-600 hover:bg-amber-700">Prestación cargada</Button>
                          <Button size="sm" variant="outline" className="w-full h-7 bg-white hover:bg-amber-100 text-amber-700 border-amber-300">Reintentar validación</Button>
                        </div>
                      </div>
                    </>
                  )}

                  {viewState === "error" && (
                    <>
                      <Badge variant="outline" className="w-fit bg-orange-50 text-orange-700 border-orange-200">
                        <Server className="w-3 h-3 mr-1" /> Error técnico
                      </Badge>
                      <div className="bg-orange-50 rounded border border-orange-200 p-2.5 text-xs text-orange-900">
                        <p className="font-medium mb-1">Timeout en KLINICOS</p>
                        <p className="text-[11px] mb-2 opacity-90">No es una denegación. El token puede seguir siendo válido.</p>
                        <p className="font-mono text-[9px] text-orange-600/70 mb-3">Req ID: req_9f21c3</p>
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" className="flex-1 h-7 bg-white border-orange-300 text-orange-700 hover:bg-orange-100">Consultar estado</Button>
                          <Button size="sm" className="flex-1 h-7 bg-orange-600 hover:bg-orange-700">Reintentar</Button>
                        </div>
                      </div>
                    </>
                  )}

                  {viewState === "revision" && (
                    <>
                      <Badge variant="outline" className="w-fit bg-purple-50 text-purple-700 border-purple-200">
                        <Stethoscope className="w-3 h-3 mr-1" /> Revisión manual
                      </Badge>
                      <div className="bg-purple-50 rounded border border-purple-200 p-2.5 text-xs text-purple-900">
                        <p className="font-medium mb-1">Inconsistencia detectada</p>
                        <p className="text-purple-800 mb-2">2 prestaciones candidatas el mismo día en KLINICOS para el mismo afiliado.</p>
                        <div className="flex items-start gap-1.5 text-[10px] text-purple-700/80 mb-3 bg-purple-100/50 p-1.5 rounded">
                          <Info className="w-3 h-3 shrink-0 mt-0.5" />
                          <p>La aceptación manual directa no está permitida para este convenio.</p>
                        </div>
                        <Button size="sm" className="w-full h-8 bg-purple-600 hover:bg-purple-700">Enviar a revisión</Button>
                      </div>
                    </>
                  )}

                  <div className="text-[10px] text-gray-400 mt-2 flex justify-between">
                    <span>Intento: 08:25 (1/3)</span>
                    <span>v2.1.0</span>
                  </div>
                </div>

              </div>
            </ScrollArea>
          </aside>

        </div>
      </div>
    </TooltipProvider>
  );
}
