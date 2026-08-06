import { useMemo, useRef, useState } from "react";
import { Textarea } from "@/components/ui/textarea";

// Autocompletado por ítem para textareas de estudios: sugiere sobre el
// fragmento que se está escribiendo (separado por comas o saltos de línea)
// y al elegir reemplaza solo ese fragmento.

function normalizar(s: string) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// Diccionario de tildes para palabras médicas y de uso frecuente (clave sin tilde, en minúscula)
const TILDES: Record<string, string> = {
  clinica: "clínica", clinico: "clínico", clinicas: "clínicas", clinicos: "clínicos",
  cronica: "crónica", cronico: "crónico", cronicas: "crónicas", cronicos: "crónicos",
  medico: "médico", medica: "médica", medicos: "médicos", medicas: "médicas",
  medicacion: "medicación", evaluacion: "evaluación", evolucion: "evolución",
  palpacion: "palpación", movilizacion: "movilización", auscultacion: "auscultación",
  percusion: "percusión", saturacion: "saturación", derivacion: "derivación",
  irradiacion: "irradiación", inflamacion: "inflamación", infeccion: "infección",
  limitacion: "limitación", flexion: "flexión", extension: "extensión", rotacion: "rotación",
  tension: "tensión", hipertension: "hipertensión", hipotension: "hipotensión",
  presion: "presión", depresion: "depresión", lesion: "lesión", lesiones: "lesiones",
  vision: "visión", audicion: "audición", deglucion: "deglución", miccion: "micción",
  respiracion: "respiración", circulacion: "circulación", digestion: "digestión",
  intervencion: "intervención", internacion: "internación", cirugia: "cirugía",
  patologia: "patología", patologias: "patologías", cardiologia: "cardiología",
  neurologia: "neurología", traumatologia: "traumatología", ginecologia: "ginecología",
  urologia: "urología", oftalmologia: "oftalmología", dermatologia: "dermatología",
  oncologia: "oncología", radiografia: "radiografía", ecografia: "ecografía",
  tomografia: "tomografía", resonancia: "resonancia", mamografia: "mamografía",
  analitica: "analítica", sintomatico: "sintomático", sintomatica: "sintomática",
  asintomatico: "asintomático", asintomatica: "asintomática",
  cefalea: "cefalea", diabetico: "diabético", diabetica: "diabética",
  hipertenso: "hipertenso", cardiaco: "cardíaco", cardiaca: "cardíaca",
  toracico: "torácico", toracica: "torácica", torax: "tórax",
  abdomen: "abdomen", pelvico: "pélvico", pelvica: "pélvica",
  humero: "húmero", femur: "fémur", tibia: "tibia", perone: "peroné",
  vertigo: "vértigo", sincope: "síncope", espasmo: "espasmo",
  nauseas: "náuseas", vomito: "vómito", vomitos: "vómitos",
  diarrea: "diarrea", estrenimiento: "estreñimiento",
  anemia: "anemia", glucemia: "glucemia", colesterol: "colesterol",
  antibiotico: "antibiótico", antibioticos: "antibióticos",
  analgesico: "analgésico", analgesicos: "analgésicos",
  antiinflamatorio: "antiinflamatorio", antiinflamatorios: "antiinflamatorios",
  antihipertensivo: "antihipertensivo", diureticos: "diuréticos", diuretico: "diurético",
  farmaco: "fármaco", farmacos: "fármacos", via: "vía", vias: "vías",
  dia: "día", dias: "días", despues: "después", ademas: "además",
  tambien: "también", segun: "según", examen: "examen",
  articulacion: "articulación", articulaciones: "articulaciones",
  antalgica: "antálgica", antalgico: "antálgico",
  neurologico: "neurológico", neurologica: "neurológica",
  quirurgico: "quirúrgico", quirurgica: "quirúrgica",
  traumatico: "traumático", traumatica: "traumática",
  metabolico: "metabólico", metabolica: "metabólica",
  sistolico: "sistólico", sistolica: "sistólica",
  diastolico: "diastólico", diastolica: "diastólica",
  isquemico: "isquémico", isquemica: "isquémica",
  febril: "febril", afebril: "afebril", termico: "térmico",
  hepatico: "hepático", hepatica: "hepática", renal: "renal",
  pulmonar: "pulmonar", gastrico: "gástrico", gastrica: "gástrica",
  colico: "cólico", colicos: "cólicos", esplenico: "esplénico",
  linfatico: "linfático", ganglio: "ganglio", adenopatia: "adenopatía",
  adenopatias: "adenopatías", miembro: "miembro", region: "región",
  lumbalgia: "lumbalgia", citologia: "citología", biopsia: "biopsia",
  paralisis: "parálisis", paresia: "paresia", parestesia: "parestesia",
  parestesias: "parestesias", hipoestesia: "hipoestesia",
  reflejo: "reflejo", tono: "tono", proximo: "próximo", proxima: "próxima",
  rapida: "rápida", rapido: "rápido", cronologia: "cronología",
  sindrome: "síndrome", diagnostico: "diagnóstico", diagnostica: "diagnóstica",
  diagnosticos: "diagnósticos", pronostico: "pronóstico",
  terapeutica: "terapéutica", terapeutico: "terapéutico",
};

// Autocorrige la palabra recién terminada (tilde) y pone mayúscula al inicio de oración
function autocorregir(texto: string, cursor: number): { texto: string; cursor: number } | null {
  const sep = texto[cursor - 1];
  if (!sep || !/[\s.,;:!?]/.test(sep)) return null;
  // Palabra inmediatamente anterior al separador
  const antes = texto.slice(0, cursor - 1);
  const m = antes.match(/([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)$/);
  let nuevoTexto = texto;
  let nuevoCursor = cursor;
  if (m) {
    const palabra = m[1];
    const inicio = cursor - 1 - palabra.length;
    const corregida = TILDES[palabra.toLowerCase()];
    let reemplazo = palabra;
    if (corregida && palabra !== corregida) {
      // Conservar mayúscula inicial si la había
      reemplazo = palabra[0] === palabra[0].toUpperCase()
        ? corregida[0].toUpperCase() + corregida.slice(1)
        : corregida;
    }
    // Mayúscula automática al inicio del texto o después de ". " / salto de línea
    const previo = nuevoTexto.slice(0, inicio).trimEnd();
    const iniciaOracion = previo === "" || /[.!?]$/.test(previo) || nuevoTexto.slice(0, inicio).endsWith("\n");
    if (iniciaOracion && reemplazo[0] !== reemplazo[0].toUpperCase()) {
      reemplazo = reemplazo[0].toUpperCase() + reemplazo.slice(1);
    }
    if (reemplazo !== palabra) {
      nuevoTexto = nuevoTexto.slice(0, inicio) + reemplazo + nuevoTexto.slice(inicio + palabra.length);
      nuevoCursor = cursor + (reemplazo.length - palabra.length);
    }
  }
  return nuevoTexto === texto ? null : { texto: nuevoTexto, cursor: nuevoCursor };
}

type Props = {
  value: string;
  onChange: (v: string) => void;
  sugerencias: string[];
  placeholder?: string;
  rows?: number;
  className?: string;
  "data-testid"?: string;
};

export function TextareaAutocompletado({ value, onChange, sugerencias, placeholder, rows, className, "data-testid": testId }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [abierto, setAbierto] = useState(false);
  const [activa, setActiva] = useState(0);
  const [token, setToken] = useState<{ texto: string; desde: number; hasta: number } | null>(null);

  const opciones = useMemo(() => {
    if (!token || token.texto.trim().length < 2) return [];
    const q = normalizar(token.texto.trim());
    const empiezan: string[] = [];
    const contienen: string[] = [];
    const vistas = new Set<string>();
    for (const s of sugerencias) {
      const clave = normalizar(s);
      if (vistas.has(clave)) continue;
      vistas.add(clave);
      if (clave.startsWith(q)) empiezan.push(s);
      else if (clave.includes(q)) contienen.push(s);
    }
    return [...empiezan, ...contienen].slice(0, 8);
  }, [token, sugerencias]);

  const mostrar = abierto && opciones.length > 0;

  const actualizarToken = (texto: string, cursor: number) => {
    // El ítem actual va desde el último separador (coma o salto de línea) hasta el cursor
    const antes = texto.slice(0, cursor);
    const inicio = Math.max(antes.lastIndexOf(","), antes.lastIndexOf("\n"), antes.lastIndexOf(".")) + 1;
    const fragmento = antes.slice(inicio);
    setToken({ texto: fragmento, desde: inicio, hasta: cursor });
    setActiva(0);
    setAbierto(true);
  };

  const elegir = (opcion: string) => {
    if (!token) return;
    const inicio = token.desde;
    // Conservar el espacio posterior a la coma ("hemograma, gluc|")
    const espacios = token.texto.match(/^\s*/)?.[0] ?? "";
    const nuevo = value.slice(0, inicio) + espacios + opcion + value.slice(token.hasta);
    onChange(nuevo);
    setAbierto(false);
    const pos = inicio + espacios.length + opcion.length;
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="relative">
      <Textarea
        ref={ref}
        value={value}
        onChange={(e) => {
          let texto = e.target.value;
          let cursor = e.target.selectionStart ?? texto.length;
          const corr = autocorregir(texto, cursor);
          if (corr) {
            texto = corr.texto;
            const pos = corr.cursor;
            requestAnimationFrame(() => {
              ref.current?.setSelectionRange(pos, pos);
            });
            cursor = pos;
          }
          onChange(texto);
          actualizarToken(texto, cursor);
        }}
        onKeyDown={(e) => {
          if (!mostrar) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiva((a) => (a + 1) % opciones.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiva((a) => (a - 1 + opciones.length) % opciones.length);
          } else if (e.key === "Enter" || e.key === "Tab" || e.key === " ") {
            e.preventDefault();
            elegir(opciones[activa]);
          } else if (e.key === "Escape") {
            setAbierto(false);
          }
        }}
        onBlur={() => setTimeout(() => setAbierto(false), 150)}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        placeholder={placeholder}
        rows={rows}
        className={className}
        data-testid={testId}
      />
      {mostrar && (
        <div className="absolute z-50 left-0 right-0 mt-1 rounded-md border bg-popover text-popover-foreground shadow-md overflow-hidden">
          {opciones.map((op, i) => (
            <button
              key={op}
              type="button"
              className={`w-full text-left px-3 py-1.5 text-sm ${i === activa ? "bg-accent text-accent-foreground" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                elegir(op);
              }}
              onMouseEnter={() => setActiva(i)}
              data-testid={`sugerencia-estudio-${i}`}
            >
              {op}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Justificaciones clínicas frecuentes para sugerir mientras se escribe
export const JUSTIFICACIONES_FRECUENTES = [
  "Control de salud anual",
  "Control periódico de salud",
  "Chequeo prequirúrgico",
  "Examen preocupacional",
  "Apto físico",
  "Control de embarazo",
  "Hipertensión arterial en tratamiento",
  "Hipertensión arterial de reciente diagnóstico",
  "Diabetes mellitus tipo 2 en tratamiento",
  "Diabetes mellitus tipo 2, control metabólico",
  "Dislipemia en tratamiento",
  "Dislipemia, control de perfil lipídico",
  "Hipotiroidismo en tratamiento",
  "Control de función tiroidea",
  "Anemia en estudio",
  "Síndrome anémico",
  "Astenia en estudio",
  "Pérdida de peso en estudio",
  "Fiebre prolongada en estudio",
  "Dolor abdominal en estudio",
  "Dolor torácico en estudio",
  "Dolor lumbar crónico",
  "Lumbalgia aguda",
  "Cervicalgia",
  "Gonalgia (dolor de rodilla)",
  "Traumatismo, descartar fractura",
  "Politraumatismo",
  "Cefalea en estudio",
  "Mareos y vértigo en estudio",
  "Disnea en estudio",
  "Tos persistente en estudio",
  "Cuadro respiratorio, descartar neumonía",
  "Infección urinaria, control",
  "Infección urinaria recurrente",
  "Síntomas urinarios bajos",
  "Control de PSA / próstata",
  "Control ginecológico anual",
  "Nódulo mamario en estudio",
  "Control post tratamiento",
  "Seguimiento oncológico",
  "Control de medicación crónica",
  "Control de función renal",
  "Insuficiencia renal crónica, control",
  "Hepatopatía en estudio",
  "Control de hepatograma por medicación",
  "Artralgia en estudio",
  "Artritis, control",
  "Osteoporosis, control de densidad ósea",
  "Riesgo cardiovascular, evaluación",
  "Palpitaciones en estudio",
  "Soplo cardíaco en estudio",
  "Arritmia en estudio",
  "Edema de miembros inferiores en estudio",
  "Várices, evaluación",
  "Trastorno digestivo en estudio",
  "Reflujo gastroesofágico",
  "Constipación crónica",
  "Diarrea crónica en estudio",
  "Alergia en estudio",
  "Trastorno del sueño, evaluación",
  "Evaluación cognitiva",
];

// Frases médicas repetitivas de anamnesis para sugerir mientras se escribe
export const FRASES_ANAMNESIS = [
  "Paciente que consulta por",
  "Paciente sin antecedentes patológicos conocidos",
  "Paciente con antecedentes de",
  "Refiere dolor de",
  "Refiere dolor de comienzo insidioso",
  "Refiere dolor de comienzo brusco",
  "Comienza hace 24 horas con",
  "Comienza hace 48 horas con",
  "Comienza hace una semana con",
  "Comienza hace un mes con",
  "Cuadro de evolución aguda",
  "Cuadro de evolución crónica",
  "Cuadro de una semana de evolución",
  "Cuadro de un mes de evolución",
  "Dolor de tipo punzante",
  "Dolor de tipo opresivo",
  "Dolor de tipo urente (quemante)",
  "Dolor de tipo cólico",
  "Dolor que irradia a",
  "Dolor que empeora con el movimiento",
  "Dolor que calma con el reposo",
  "Dolor que no calma con analgésicos comunes",
  "Intensidad 7/10",
  "Sin fiebre ni equivalentes febriles",
  "Registros febriles de hasta 38°C",
  "Acompañado de náuseas y vómitos",
  "Acompañado de mareos",
  "Acompañado de parestesias",
  "Sin pérdida de peso",
  "Pérdida de peso no intencional",
  "Sin traumatismo previo",
  "Antecedente de traumatismo",
  "Antecedente de traumatismo deportivo",
  "Antecedente quirúrgico de",
  "Hipertensión arterial en tratamiento con",
  "Diabetes tipo 2 en tratamiento con",
  "Medicación habitual:",
  "Alergia a",
  "Niega alergias medicamentosas",
  "Tabaquista de",
  "Ex tabaquista",
  "Niega hábitos tóxicos",
  "Sedentario",
  "Realiza actividad física regular",
  "Limitación funcional para las actividades de la vida diaria",
  "Impotencia funcional de",
  "Sensación de inestabilidad",
  "Bloqueo articular ocasional",
  "Tumefacción y calor local",
  "Parestesias en territorio de",
  "Episodios previos similares",
  "Primer episodio de estas características",
  "Consultó previamente en guardia donde",
  "Tratamiento previo con antiinflamatorios sin mejoría",
  "Buena respuesta al tratamiento instaurado",
  "Mala respuesta al tratamiento instaurado",
  "Resto de la anamnesis sin datos relevantes",
];

// Frases frecuentes de examen físico para sugerir mientras se escribe
export const FRASES_EXAMEN_FISICO = [
  "Paciente lúcido, orientado en tiempo y espacio",
  "Buen estado general",
  "Regular estado general",
  "Afebril al momento del examen",
  "Hemodinámicamente estable",
  "Normohidratado y normocoloreado",
  "TA 120/80 mmHg",
  "FC 80 lpm, regular",
  "FR 16 rpm",
  "Saturación 98% aire ambiente",
  "Buena entrada de aire bilateral, sin ruidos agregados",
  "Rales crepitantes en base pulmonar",
  "Sibilancias espiratorias difusas",
  "Ruidos cardíacos normofonéticos, silencios libres",
  "Soplo sistólico en foco",
  "Abdomen blando, depresible, indoloro",
  "Abdomen doloroso a la palpación en",
  "Defensa abdominal en",
  "Ruidos hidroaéreos positivos",
  "Sin visceromegalias",
  "Puño percusión lumbar negativa bilateral",
  "Puño percusión lumbar positiva derecha",
  "Sin edemas en miembros inferiores",
  "Edema de miembros inferiores con signo de Godet",
  "Pulsos periféricos presentes y simétricos",
  "Sin signos de foco motor ni sensitivo",
  "Pupilas isocóricas y reactivas",
  "Fauces congestivas",
  "Adenopatías cervicales palpables",
  "Sin adenopatías palpables",
  "Dolor a la palpación de",
  "Dolor a la movilización activa y pasiva de",
  "Limitación de la movilidad de",
  "Rango de movilidad conservado",
  "Tumefacción y aumento de temperatura local en",
  "Sin signos de flogosis",
  "Maniobra de McMurray positiva",
  "Maniobra de Lasègue positiva",
  "Cajón anterior positivo",
  "Bostezo articular positivo",
  "Crepitación articular a la movilización",
  "Marcha conservada",
  "Marcha antálgica",
  "Piel y mucosas sin lesiones",
  "Resto del examen físico sin particularidades",
];

// Diagnósticos frecuentes para sugerir mientras se escribe
export const FRASES_DIAGNOSTICO = [
  "Hipertensión arterial esencial",
  "Diabetes mellitus tipo 2",
  "Dislipemia",
  "Hipotiroidismo",
  "Obesidad",
  "Síndrome metabólico",
  "Infección respiratoria alta",
  "Faringoamigdalitis aguda",
  "Bronquitis aguda",
  "Neumonía adquirida en la comunidad",
  "Asma bronquial",
  "EPOC",
  "Rinitis alérgica",
  "Sinusitis aguda",
  "Otitis media aguda",
  "Infección urinaria baja",
  "Pielonefritis aguda",
  "Litiasis renal",
  "Gastritis",
  "Enfermedad por reflujo gastroesofágico",
  "Síndrome de intestino irritable",
  "Gastroenteritis aguda",
  "Lumbalgia mecánica",
  "Lumbociatalgia",
  "Cervicalgia",
  "Gonartrosis",
  "Coxartrosis",
  "Lesión meniscal de rodilla",
  "Ruptura de ligamento cruzado anterior",
  "Esguince de tobillo",
  "Tendinitis de",
  "Síndrome del túnel carpiano",
  "Hombro doloroso (síndrome del manguito rotador)",
  "Osteoporosis",
  "Artritis reumatoidea",
  "Fibromialgia",
  "Cefalea tensional",
  "Migraña",
  "Vértigo posicional paroxístico benigno",
  "Trastorno de ansiedad",
  "Episodio depresivo",
  "Insomnio",
  "Anemia ferropénica",
  "Dermatitis de contacto",
  "Celulitis de",
  "Herpes zóster",
  "Insuficiencia venosa crónica",
  "Fibrilación auricular",
  "Insuficiencia cardíaca",
  "Cardiopatía isquémica",
];

// Frases frecuentes de evaluación / impresión clínica
export const FRASES_EVALUACION = [
  "Paciente estable, sin criterios de gravedad",
  "Cuadro compatible con",
  "Impresión diagnóstica:",
  "Se descarta patología aguda",
  "Evolución favorable",
  "Evolución tórpida",
  "Buena respuesta al tratamiento instaurado",
  "Mala respuesta al tratamiento instaurado",
  "Requiere estudios complementarios para confirmar diagnóstico",
  "Se solicitan estudios complementarios",
  "Se ajusta medicación",
  "Se indica tratamiento sintomático",
  "Se indica reposo relativo",
  "Se deriva a especialista de",
  "Se deriva a guardia para evaluación urgente",
  "Control clínico en 7 días",
  "Control clínico en 15 días",
  "Control clínico en 30 días",
  "Control con resultados de estudios",
  "Pautas de alarma explicadas y comprendidas",
  "Paciente comprende indicaciones",
  "Alta de seguimiento",
  "Continúa seguimiento por consultorio externo",
  "Riesgo cardiovascular bajo",
  "Riesgo cardiovascular moderado",
  "Riesgo cardiovascular alto",
  "Buen control metabólico",
  "Mal control metabólico, se refuerzan pautas higiénico-dietéticas",
];

// Estudios de rutina frecuentes (baja complejidad) para sugerir mientras se escribe
export const ESTUDIOS_FRECUENTES = [
  "Hemograma completo",
  "Glucemia",
  "Uremia",
  "Creatininemia",
  "Uricemia",
  "Hepatograma",
  "Colesterol total",
  "Colesterol HDL",
  "Colesterol LDL",
  "Trigliceridemia",
  "Perfil lipídico",
  "Ionograma plasmático",
  "Hemoglobina glicosilada (HbA1c)",
  "TSH",
  "T4 libre",
  "T3",
  "Ferremia",
  "Ferritina",
  "Transferrina",
  "Vitamina D (25-OH)",
  "Vitamina B12",
  "Ácido fólico",
  "Coagulograma",
  "Tiempo de protrombina",
  "KPTT",
  "Eritrosedimentación",
  "Proteína C reactiva",
  "Orina completa",
  "Urocultivo",
  "Sedimento urinario",
  "Microalbuminuria",
  "Clearance de creatinina",
  "PSA total",
  "PSA libre",
  "Sangre oculta en materia fecal",
  "Coprocultivo",
  "Parasitológico de materia fecal",
  "Test de embarazo (subunidad beta)",
  "Grupo y factor sanguíneo",
  "Serología para Chagas",
  "VDRL",
  "HIV",
  "Hepatitis B (HBsAg)",
  "Hepatitis C (anti-HCV)",
  "Glucemia post prandial",
  "Prueba de tolerancia oral a la glucosa",
  "Insulinemia",
  "Cortisol",
  "Prolactina",
  "Testosterona total",
  "Estradiol",
  "FSH",
  "LH",
  "Calcemia",
  "Fosfatemia",
  "Magnesemia",
  "Amilasemia",
  "CPK",
  "LDH",
  "Troponina",
  "Rx de tórax frente",
  "Rx de tórax frente y perfil",
  "Rx de columna lumbosacra frente y perfil",
  "Rx de columna cervical frente y perfil",
  "Rx de abdomen de pie",
  "Rx de senos paranasales",
  "Rx de cráneo frente y perfil",
  "Rx de pelvis frente",
  "Rx de rodilla frente y perfil",
  "Rx de tobillo frente y perfil",
  "Rx de mano frente y oblicua",
  "Rx de hombro frente",
  "Rx de cadera frente",
  "Rx de pie frente y perfil",
  "Rx de codo frente y perfil",
  "Rx de muñeca frente y perfil",
  "Espirometría",
  "Audiometría",
  "Fondo de ojo",
  "Densitometría ósea",
  // Ecografías (las Doppler van por alta complejidad)
  "Ecografía de abdomen completo",
  "Ecografía hepatobiliar",
  "Ecografía renal y de vías urinarias",
  "Ecografía vesical",
  "Ecografía de tiroides",
  "Ecografía de partes blandas",
  "Ecografía de cuello",
  "Ecografía testicular",
  "Ecografía ginecológica",
  "Ecografía transvaginal",
  "Ecografía obstétrica",
  "Ecografía mamaria bilateral",
  "Ecografía de hombro",
  "Ecografía de rodilla",
  "Ecografía pleural",
  // Mamografía
  "Mamografía bilateral",
  "Mamografía con proyección axilar",
  // Prácticas cardiológicas de rutina
  "Electrocardiograma (ECG)",
  "Ergometría (prueba de esfuerzo)",
  "Ecocardiograma",
  "Holter de 24 hs",
  "Presurometría (MAPA)",
  "Riesgo quirúrgico",
];
