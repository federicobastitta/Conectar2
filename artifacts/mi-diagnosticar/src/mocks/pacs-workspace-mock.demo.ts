// ── Datos SIMULADOS del Workspace PACS (contrato v1.0 CONGELADO) ─────────────
// Solo para desarrollo de UI. PACS_WORKSPACE_ENABLED sigue en false: nada de
// esto contacta al backend ni al PACS real. Cuando DiagnosticPACS confirme el
// contrato, estas estructuras se reemplazan por hooks generados desde OpenAPI.

// Estados operativos del módulo (proyección de la máquina de turnos, ver plan)
export type EstadoOperativo =
  | "AGENDADO"
  | "RECEPCIONADO"
  | "PENDIENTE_DE_INFORME"
  | "INFORMADO"
  | "AUSENTE";

export type EstadoInforme = "borrador" | "firmado" | "publicado";

export interface EstudioMock {
  ordenId: number;
  accessionNumber: string;
  studyInstanceUid: string;
  modality: string;
  practica: string;
  motivoEstudio: string;
  diagnosticoPresuntivo?: string;
  antecedentes?: string;
  observacionesTecnico?: string;
  sede: string;
  fecha: string; // YYYY-MM-DD
  hora: string;
  estadoOperativo: EstadoOperativo;
  paciente: {
    id: number;
    nombre: string;
    apellido: string;
    dni: string;
    cobertura: string;
    nroAfiliado: string;
    fechaNacimiento: string;
    sexo: "F" | "M";
  };
  profesionalSolicitante: string;
  series: SerieMock[];
}

export interface SerieMock {
  seriesInstanceUid: string;
  descripcion: string;
  cantidadImagenes: number;
  imagenes: ImagenMock[];
}

export interface ImagenMock {
  sopInstanceUid: string;
  numero: number;
  descripcion: string;
}

export interface ImagenClaveMock {
  keyImageId: string;
  studyInstanceUid: string;
  seriesInstanceUid: string;
  sopInstanceUid: string;
  titulo: string;
  comentarioMedico: string;
  orden: number;
}

export interface VersionInformeMock {
  version: number;
  texto: string;
  firmadoPor: string | null;
  firmadoEn: string | null; // ISO
  publicadoEn: string | null;
  imagenesClave: ImagenClaveMock[];
}

export interface InformeMock {
  informeId: number;
  ordenId: number;
  estado: EstadoInforme;
  borradorActual: string;
  imagenesClaveBorrador: ImagenClaveMock[];
  versiones: VersionInformeMock[];
}

// ── Pacientes y estudios de ejemplo ──────────────────────────────────────────

const HOY = new Date().toISOString().split("T")[0];
const ayer = (dias: number) => {
  const d = new Date();
  d.setDate(d.getDate() - dias);
  return d.toISOString().split("T")[0] as string;
};

function serie(uidBase: string, n: number, desc: string, cant: number): SerieMock {
  return {
    seriesInstanceUid: `${uidBase}.${n}`,
    descripcion: desc,
    cantidadImagenes: cant,
    imagenes: Array.from({ length: cant }, (_, i) => ({
      sopInstanceUid: `${uidBase}.${n}.${i + 1}`,
      numero: i + 1,
      descripcion: `${desc} — imagen ${i + 1}`,
    })),
  };
}

export const ESTUDIOS_MOCK: EstudioMock[] = [
  {
    ordenId: 9001,
    accessionNumber: "C26-000000009001",
    studyInstanceUid: "1.2.840.99999.1.9001",
    modality: "CR",
    practica: "Rx de tórax frente y perfil",
    motivoEstudio: "Tos persistente de 3 semanas, descartar neumonía",
    diagnosticoPresuntivo: "J18.9 — Neumonía, no especificada",
    antecedentes: "Ex tabaquista (20 p/y). HTA medicada.",
    observacionesTecnico: "Paciente colaborador. Inspiración adecuada.",
    sede: "Sede Central",
    fecha: HOY as string,
    hora: "09:15",
    estadoOperativo: "PENDIENTE_DE_INFORME",
    paciente: {
      id: 501,
      nombre: "Marta",
      apellido: "Giménez",
      dni: "16.482.335",
      cobertura: "IOMA",
      nroAfiliado: "1648233501",
      fechaNacimiento: "1963-04-12",
      sexo: "F",
    },
    profesionalSolicitante: "Dr. Hernán Soria (Clínica Médica)",
    series: [
      serie("1.2.840.99999.1.9001", 1, "Tórax frente (PA)", 1),
      serie("1.2.840.99999.1.9001", 2, "Tórax perfil izquierdo", 1),
    ],
  },
  {
    ordenId: 9002,
    accessionNumber: "C26-000000009002",
    studyInstanceUid: "1.2.840.99999.1.9002",
    modality: "US",
    practica: "Ecografía abdominal completa",
    motivoEstudio: "Dolor en hipocondrio derecho postprandial, sospecha de litiasis vesicular",
    diagnosticoPresuntivo: "K80.2 — Litiasis vesicular sin colecistitis",
    antecedentes: "Dispepsia crónica. Sin cirugías previas.",
    sede: "Sede Central",
    fecha: HOY as string,
    hora: "10:40",
    estadoOperativo: "PENDIENTE_DE_INFORME",
    paciente: {
      id: 502,
      nombre: "Rubén",
      apellido: "Aguirre",
      dni: "22.153.987",
      cobertura: "OSDE 210",
      nroAfiliado: "61-22153987-2",
      fechaNacimiento: "1971-09-30",
      sexo: "M",
    },
    profesionalSolicitante: "Dra. Paula Ferreyra (Gastroenterología)",
    series: [
      serie("1.2.840.99999.1.9002", 1, "Hígado y vía biliar", 12),
      serie("1.2.840.99999.1.9002", 2, "Vesícula", 8),
      serie("1.2.840.99999.1.9002", 3, "Riñones y bazo", 10),
    ],
  },
  {
    ordenId: 9003,
    accessionNumber: "C26-000000009003",
    studyInstanceUid: "1.2.840.99999.1.9003",
    modality: "MG",
    practica: "Mamografía bilateral con proyecciones complementarias",
    motivoEstudio: "Control anual. Madre con antecedente de ca. de mama a los 58 años",
    antecedentes: "Sin nódulos palpables. Última mamografía 07/2025: BI-RADS 2.",
    observacionesTecnico: "Se realizaron proyecciones CC y MLO bilaterales.",
    sede: "Sede Norte",
    fecha: HOY as string,
    hora: "11:20",
    estadoOperativo: "RECEPCIONADO",
    paciente: {
      id: 503,
      nombre: "Silvia",
      apellido: "Domínguez",
      dni: "20.774.612",
      cobertura: "Swiss Medical SMG20",
      nroAfiliado: "800020774612",
      fechaNacimiento: "1969-02-18",
      sexo: "F",
    },
    profesionalSolicitante: "Dra. Inés Maldonado (Ginecología)",
    series: [
      serie("1.2.840.99999.1.9003", 1, "CC derecha / izquierda", 2),
      serie("1.2.840.99999.1.9003", 2, "MLO derecha / izquierda", 2),
    ],
  },
  {
    ordenId: 9004,
    accessionNumber: "C26-000000009004",
    studyInstanceUid: "1.2.840.99999.1.9004",
    modality: "CT",
    practica: "TC de cerebro sin contraste",
    motivoEstudio: "Cefalea intensa de inicio brusco, descartar sangrado",
    diagnosticoPresuntivo: "R51 — Cefalea",
    antecedentes: "Migrañosa conocida. Niega traumatismo.",
    sede: "Sede Central",
    fecha: ayer(1),
    hora: "18:05",
    estadoOperativo: "INFORMADO",
    paciente: {
      id: 504,
      nombre: "Carolina",
      apellido: "Bustos",
      dni: "31.908.554",
      cobertura: "IOMA",
      nroAfiliado: "3190855400",
      fechaNacimiento: "1985-11-02",
      sexo: "F",
    },
    profesionalSolicitante: "Dr. Facundo Leiva (Guardia)",
    series: [
      serie("1.2.840.99999.1.9004", 1, "Axial cerebro s/c", 32),
    ],
  },
  {
    ordenId: 9005,
    accessionNumber: "C26-000000009005",
    studyInstanceUid: "1.2.840.99999.1.9005",
    modality: "MR",
    practica: "RM de rodilla derecha",
    motivoEstudio: "Dolor y bloqueo articular post traumatismo deportivo, sospecha de lesión meniscal",
    antecedentes: "Futbolista amateur. Entorsis hace 3 semanas.",
    sede: "Sede Norte",
    fecha: HOY as string,
    hora: "15:30",
    estadoOperativo: "AGENDADO",
    paciente: {
      id: 505,
      nombre: "Lucas",
      apellido: "Pereyra",
      dni: "38.226.741",
      cobertura: "Galeno Azul",
      nroAfiliado: "220038226741",
      fechaNacimiento: "1994-06-25",
      sexo: "M",
    },
    profesionalSolicitante: "Dr. Martín Olguín (Traumatología)",
    series: [],
  },
  {
    ordenId: 9006,
    accessionNumber: "C26-000000009006",
    studyInstanceUid: "1.2.840.99999.1.9006",
    modality: "CR",
    practica: "Rx de tórax frente",
    motivoEstudio: "Control evolutivo de neumonía basal derecha",
    sede: "Sede Central",
    fecha: ayer(2),
    hora: "08:50",
    estadoOperativo: "AUSENTE",
    paciente: {
      id: 501,
      nombre: "Marta",
      apellido: "Giménez",
      dni: "16.482.335",
      cobertura: "IOMA",
      nroAfiliado: "1648233501",
      fechaNacimiento: "1963-04-12",
      sexo: "F",
    },
    profesionalSolicitante: "Dr. Hernán Soria (Clínica Médica)",
    series: [],
  },
];

// Estudios previos del mismo paciente (para comparación)
export const ESTUDIOS_PREVIOS_MOCK: Record<number, Array<{
  studyInstanceUid: string;
  fecha: string;
  modality: string;
  practica: string;
  informeResumen: string;
}>> = {
  501: [
    {
      studyInstanceUid: "1.2.840.99999.1.8801",
      fecha: ayer(180),
      modality: "CR",
      practica: "Rx de tórax frente y perfil",
      informeResumen: "Playas pulmonares libres. Índice cardiotorácico conservado. Sin imágenes patológicas.",
    },
    {
      studyInstanceUid: "1.2.840.99999.1.8654",
      fecha: ayer(420),
      modality: "CT",
      practica: "TC de tórax sin contraste",
      informeResumen: "Granuloma calcificado en LSD de 4 mm, sin cambios respecto a estudios previos.",
    },
  ],
  502: [
    {
      studyInstanceUid: "1.2.840.99999.1.8702",
      fecha: ayer(365),
      modality: "US",
      practica: "Ecografía abdominal",
      informeResumen: "Barro biliar. Resto del examen sin particularidades.",
    },
  ],
  503: [
    {
      studyInstanceUid: "1.2.840.99999.1.8503",
      fecha: ayer(370),
      modality: "MG",
      practica: "Mamografía bilateral",
      informeResumen: "BI-RADS 2: calcificaciones benignas dispersas bilaterales. Control anual.",
    },
  ],
};

// Informes iniciales: la orden 9004 ya tiene informe firmado (v1)
export const INFORMES_INICIALES_MOCK: InformeMock[] = [
  {
    informeId: 7004,
    ordenId: 9004,
    estado: "firmado",
    borradorActual:
      "TC DE CEREBRO SIN CONTRASTE\n\nTécnica: adquisición helicoidal sin contraste endovenoso.\n\nHallazgos: no se observan imágenes hiperdensas compatibles con sangrado intra ni extraaxial. Sistema ventricular de morfología y tamaño conservados, en línea media. Surcos corticales acordes a la edad. Fosa posterior sin alteraciones. Estructuras óseas sin lesiones líticas ni blásticas.\n\nConclusión: estudio sin evidencia de patología aguda intracraneal.",
    imagenesClaveBorrador: [],
    versiones: [
      {
        version: 1,
        texto:
          "TC DE CEREBRO SIN CONTRASTE\n\nTécnica: adquisición helicoidal sin contraste endovenoso.\n\nHallazgos: no se observan imágenes hiperdensas compatibles con sangrado intra ni extraaxial. Sistema ventricular de morfología y tamaño conservados, en línea media. Surcos corticales acordes a la edad. Fosa posterior sin alteraciones. Estructuras óseas sin lesiones líticas ni blásticas.\n\nConclusión: estudio sin evidencia de patología aguda intracraneal.",
        firmadoPor: "Dr. Gustavo Medina (MP 4.412)",
        firmadoEn: new Date(Date.now() - 20 * 3600 * 1000).toISOString(),
        publicadoEn: null,
        imagenesClave: [
          {
            keyImageId: "ki-9004-1",
            studyInstanceUid: "1.2.840.99999.1.9004",
            seriesInstanceUid: "1.2.840.99999.1.9004.1",
            sopInstanceUid: "1.2.840.99999.1.9004.1.16",
            titulo: "Corte axial a nivel de ganglios basales",
            comentarioMedico: "Sin imágenes hiperdensas. Línea media conservada.",
            orden: 1,
          },
        ],
      },
    ],
  },
];

export const ETIQUETAS_ESTADO: Record<EstadoOperativo, string> = {
  AGENDADO: "Agendado",
  RECEPCIONADO: "Recepcionado",
  PENDIENTE_DE_INFORME: "Pendiente de informe",
  INFORMADO: "Informado",
  AUSENTE: "Ausente",
};

export const COLORES_ESTADO: Record<EstadoOperativo, string> = {
  AGENDADO: "bg-slate-100 text-slate-700 border-slate-200",
  RECEPCIONADO: "bg-blue-50 text-blue-700 border-blue-200",
  PENDIENTE_DE_INFORME: "bg-amber-50 text-amber-700 border-amber-200",
  INFORMADO: "bg-emerald-50 text-emerald-700 border-emerald-200",
  AUSENTE: "bg-red-50 text-red-600 border-red-200",
};

export const MODALIDADES = ["CR", "CT", "MR", "US", "MG"] as const;
