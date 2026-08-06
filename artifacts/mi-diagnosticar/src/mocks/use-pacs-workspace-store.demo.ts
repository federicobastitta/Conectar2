// Store simulado en memoria para el Workspace PACS (solo UI de desarrollo).
// useSyncExternalStore sobre un singleton de módulo: el estado sobrevive a la
// navegación entre páginas pero se reinicia al recargar (es intencional: demo).
import { useSyncExternalStore } from "react";
import {
  ESTUDIOS_MOCK,
  INFORMES_INICIALES_MOCK,
  type EstudioMock,
  type InformeMock,
  type ImagenClaveMock,
  type EstadoOperativo,
} from "./pacs-workspace-mock";

interface WorkspaceState {
  estudios: EstudioMock[];
  informes: InformeMock[];
}

let state: WorkspaceState = {
  estudios: ESTUDIOS_MOCK.map((e) => ({ ...e })),
  informes: INFORMES_INICIALES_MOCK.map((i) => ({
    ...i,
    imagenesClaveBorrador: [...i.imagenesClaveBorrador],
    versiones: i.versiones.map((v) => ({ ...v, imagenesClave: [...v.imagenesClave] })),
  })),
};

const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePacsWorkspaceStore(): WorkspaceState {
  return useSyncExternalStore(subscribe, () => state);
}

function actualizarInforme(informeId: number, fn: (i: InformeMock) => InformeMock) {
  state = {
    ...state,
    informes: state.informes.map((i) => (i.informeId === informeId ? fn(i) : i)),
  };
  emit();
}

function actualizarEstudio(ordenId: number, fn: (e: EstudioMock) => EstudioMock) {
  state = {
    ...state,
    estudios: state.estudios.map((e) => (e.ordenId === ordenId ? fn(e) : e)),
  };
  emit();
}

export function obtenerOCrearInforme(ordenId: number): InformeMock {
  const existente = state.informes.find((i) => i.ordenId === ordenId);
  if (existente) return existente;
  const nuevo: InformeMock = {
    informeId: 7000 + ordenId,
    ordenId,
    estado: "borrador",
    borradorActual: "",
    imagenesClaveBorrador: [],
    versiones: [],
  };
  state = { ...state, informes: [...state.informes, nuevo] };
  emit();
  return nuevo;
}

export function guardarBorrador(informeId: number, texto: string) {
  actualizarInforme(informeId, (i) => ({ ...i, borradorActual: texto, estado: "borrador" }));
}

export function alternarImagenClave(informeId: number, imagen: ImagenClaveMock) {
  actualizarInforme(informeId, (i) => {
    const ya = i.imagenesClaveBorrador.some((k) => k.keyImageId === imagen.keyImageId);
    const imagenes = ya
      ? i.imagenesClaveBorrador.filter((k) => k.keyImageId !== imagen.keyImageId)
      : [...i.imagenesClaveBorrador, { ...imagen, orden: i.imagenesClaveBorrador.length + 1 }];
    return { ...i, imagenesClaveBorrador: imagenes.map((k, idx) => ({ ...k, orden: idx + 1 })) };
  });
}

export function comentarImagenClave(informeId: number, keyImageId: string, comentario: string) {
  actualizarInforme(informeId, (i) => ({
    ...i,
    imagenesClaveBorrador: i.imagenesClaveBorrador.map((k) =>
      k.keyImageId === keyImageId ? { ...k, comentarioMedico: comentario } : k,
    ),
  }));
}

// Firmar crea una versión inmutable (contrato: cada firma = nueva versión)
export function firmarInforme(informeId: number, firmadoPor: string) {
  const informe = state.informes.find((i) => i.informeId === informeId);
  if (!informe || !informe.borradorActual.trim()) return;
  actualizarInforme(informeId, (i) => ({
    ...i,
    estado: "firmado",
    versiones: [
      ...i.versiones,
      {
        version: i.versiones.length + 1,
        texto: i.borradorActual,
        firmadoPor,
        firmadoEn: new Date().toISOString(),
        publicadoEn: null,
        imagenesClave: i.imagenesClaveBorrador.map((k) => ({ ...k })),
      },
    ],
  }));
  actualizarEstudio(informe.ordenId, (e) => ({ ...e, estadoOperativo: "INFORMADO" }));
}

export function publicarInforme(informeId: number) {
  actualizarInforme(informeId, (i) => {
    if (i.versiones.length === 0) return i;
    const ultima = i.versiones[i.versiones.length - 1]!;
    return {
      ...i,
      estado: "publicado",
      versiones: [
        ...i.versiones.slice(0, -1),
        { ...ultima, publicadoEn: ultima.publicadoEn ?? new Date().toISOString() },
      ],
    };
  });
}

export function corregirInforme(informeId: number) {
  // Habilita una nueva edición sobre la última versión firmada (crea borrador)
  actualizarInforme(informeId, (i) => ({ ...i, estado: "borrador" }));
}

export function cambiarEstadoOperativo(ordenId: number, estado: EstadoOperativo) {
  actualizarEstudio(ordenId, (e) => ({ ...e, estadoOperativo: estado }));
}
