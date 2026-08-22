import { create } from 'zustand';
import type {} from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { useAuthStore } from './authStore';
import { uploadEvidencePhoto } from '../services/evidence';
import { API_BASE_URL } from '../config/api';

const { persist, createJSONStorage } =
  require('zustand/middleware.js') as typeof import('zustand/middleware');

const MAX_RETRIES = 3;

/** Prioridad: eventos operativos antes que telemetría GPS. */
function syncPriority(endpoint: string): number {
  if (endpoint === '/chofer/evento' || endpoint === '/entregas/sync') return 0;
  if (endpoint === '/tracking') return 2;
  return 1;
}

export interface SyncAction {
  id: string;
  endpoint: string;
  payload: any;
  timestamp: number;
  retries: number;
  ownerRut: string;
  ownerTenant: string;
  /** Fallo 4xx en POD/evento: no borrar en silencio */
  failed?: boolean;
  lastError?: string;
}

interface SyncState {
  queue: SyncAction[];
  isSyncing: boolean;
  currentTripId: string | null;
  setCurrentTrip: (tripId: string | null) => void;
  addAction: (endpoint: string, payload: any) => void;
  processQueue: () => Promise<void>;
  removeAction: (id: string) => void;
  clearQueue: () => void;
  /** Reencola ítems failed (eventos operativos) para reintento manual. */
  retryFailed: () => void;
}

function isChoferEvento(action: SyncAction): boolean {
  return action.endpoint === '/chofer/evento';
}

function markActionFailed(set: (fn: (s: SyncState) => Partial<SyncState>) => void, id: string, lastError: string) {
  set((s) => ({
    queue: s.queue.map((a) =>
      a.id === id ? { ...a, failed: true, lastError } : a
    ),
  }));
}

let inFlight = false;

export const useSyncStore = create<SyncState>()(
  persist(
    (set, get) => ({
      queue: [],
      isSyncing: false,
      currentTripId: null,

      setCurrentTrip: (tripId) => set({ currentTripId: tripId }),

      addAction: (endpoint, payload) => {
        const { tenantId, rut } = useAuthStore.getState();
        if (!tenantId || !rut) {
          console.warn('⚠️ Acción descartada: no hay sesión activa');
          return;
        }
        const newAction: SyncAction = {
          id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
          endpoint,
          payload,
          timestamp: Date.now(),
          retries: 0,
          ownerRut: rut,
          ownerTenant: tenantId,
        };

        console.log(`📥 Guardando acción en la cola local: ${endpoint}`);
        set((state) => ({ queue: [...state.queue, newAction] }));
        get().processQueue();
      },

      removeAction: (id) => {
        set((state) => ({ queue: state.queue.filter(a => a.id !== id) }));
      },

      clearQueue: () => {
        set({ queue: [], isSyncing: false, currentTripId: null });
      },

      retryFailed: () => {
        set((s) => ({
          queue: s.queue.map((a) =>
            a.failed ? { ...a, failed: false, retries: 0, lastError: undefined } : a
          ),
        }));
        get().processQueue();
      },

      processQueue: async () => {
        if (inFlight) return;

        const { tenantId, rut, token, logout } = useAuthStore.getState();
        if (!tenantId || !rut || !token) return;

        const state = get();
        if (state.queue.length === 0) return;

        inFlight = true;
        set({ isSyncing: true });

        try {
          // Operativos primero; pings GPS ordenados por timestamp del device
          const actionsToProcess = [...get().queue]
            .filter((a) => !a.failed)
            .sort((a, b) => {
              const pa = syncPriority(a.endpoint);
              const pb = syncPriority(b.endpoint);
              if (pa !== pb) return pa - pb;
              if (a.endpoint === '/tracking' && b.endpoint === '/tracking') {
                const ta = Number(a.payload?.timestamp ?? a.timestamp);
                const tb = Number(b.payload?.timestamp ?? b.timestamp);
                return ta - tb;
              }
              return a.timestamp - b.timestamp;
            });

          for (const action of actionsToProcess) {
            if (action.ownerRut !== rut || action.ownerTenant !== tenantId) {
              console.warn(`🗑️ Acción ${action.id} de otra sesión (${action.ownerRut}) — descartada`);
              get().removeAction(action.id);
              continue;
            }

            try {
              console.log(`🚀 Intentando enviar acción: ${action.endpoint}...`);

              let eventPayload = action.payload;
              if (action.endpoint === '/chofer/evento' && (action.payload.pending_photo || action.payload.pending_firma)) {
                eventPayload = { ...action.payload };
                if (eventPayload.pending_photo) {
                  const url = await uploadEvidencePhoto(token, eventPayload.pending_photo);
                  if (!url) {
                    throw new Error('upload_evidencia_fallo');
                  }
                  eventPayload.foto_url = url;
                  delete eventPayload.pending_photo;
                }
                if (eventPayload.pending_firma) {
                  const urlFirma = await uploadEvidencePhoto(token, eventPayload.pending_firma);
                  if (!urlFirma) {
                    throw new Error('upload_firma_fallo');
                  }
                  eventPayload.firma_url = urlFirma;
                  delete eventPayload.pending_firma;
                }
                set((s) => ({
                  queue: s.queue.map(a => a.id === action.id ? { ...a, payload: eventPayload } : a),
                }));
              }

              const finalPayload =
                action.endpoint === '/entregas/sync'
                  ? {
                      tenant_id: tenantId,
                      rut,
                      stopId: action.payload.stopId,
                      status: action.payload.status,
                      payload: action.payload.payload,
                    }
                  : action.endpoint === '/chofer/evento'
                  ? {
                      trip_id: eventPayload.trip_id,
                      stop_id: eventPayload.stop_id,
                      tipo_evento: eventPayload.tipo_evento,
                      foto_url: eventPayload.foto_url || null,
                      firma_url: eventPayload.firma_url || null,
                      razon: eventPayload.razon || null,
                      codigo_escaneado: eventPayload.codigo_escaneado || null,
                      latitud: eventPayload.latitud ?? eventPayload.lat ?? null,
                      longitud: eventPayload.longitud ?? eventPayload.lng ?? null,
                      // Res.154 S1: hora del device (inicio real del traslado / offline queue)
                      evento_ts_device: eventPayload.timestamp ?? action.timestamp,
                    }
                  : action.endpoint === '/tracking'
                  ? {
                      tenant_id: tenantId,
                      trip_id: action.payload.trip_id,
                      lat: action.payload.lat,
                      lng: action.payload.lng,
                      // Hora del device / GPS — crítica para offline replay
                      timestamp: action.payload.timestamp ?? action.timestamp,
                    }
                  : {
                      path: action.endpoint,
                      payload: action.payload,
                      tenant_id: tenantId,
                      rut,
                    };

              const workerEndpoint =
                action.endpoint === '/entregas/sync'
                  ? '/api/app-chofer-sync'
                  : action.endpoint === '/chofer/evento'
                  ? `/api/chofer/evento?tenant_id=${encodeURIComponent(tenantId)}`
                  : action.endpoint === '/tracking'
                  ? '/api/gps/ping'
                  : '/api/mobile-sync';

              const response = await fetch(`${API_BASE_URL}${workerEndpoint}`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token}`,
                  'Idempotency-Key': action.id,
                },
                body: JSON.stringify(finalPayload),
              });

              if (response.ok) {
                console.log(`✅ [SYNC OK] Acción ${action.endpoint} guardada en BD!`);
                get().removeAction(action.id);
                continue;
              }

              if (response.status === 401) {
                console.warn('🔒 401 del servidor — cerrando sesión');
                get().removeAction(action.id);
                await logout();
                break;
              }

              if (response.status >= 400 && response.status < 500) {
                if (isChoferEvento(action)) {
                  // LLEGADA / ENTREGA / SALIDA / PROBLEMA: no borrar en silencio
                  console.error(`⛔ Evento 4xx (${response.status}) — marcado failed`);
                  markActionFailed(set, action.id, `HTTP ${response.status}`);
                } else {
                  console.warn(`🗑️ ${response.status} no recuperable en ${action.endpoint} — descartada`);
                  get().removeAction(action.id);
                }
                continue;
              }

              throw new Error(`Error de servidor: ${response.status}`);
            } catch (error: any) {
              console.warn(`❌ Error en ${action.id}:`, error.message);

              // GPS: si falla red, reintentar; si supera retries, dropear ping viejo
              if (action.endpoint === '/tracking') {
                if (action.retries + 1 >= MAX_RETRIES) {
                  get().removeAction(action.id);
                } else {
                  set((s) => ({
                    queue: s.queue.map(a => a.id === action.id ? { ...a, retries: a.retries + 1 } : a),
                  }));
                }
                continue;
              }

              if (action.retries + 1 >= MAX_RETRIES) {
                if (isChoferEvento(action)) {
                  console.error('⛔ Evento agotó reintentos — marcado failed');
                  markActionFailed(set, action.id, error.message || 'max_retries');
                } else {
                  console.warn('💀 Límite de reintentos superado, descartando.');
                  get().removeAction(action.id);
                }
              } else {
                set((s) => ({
                  queue: s.queue.map(a => a.id === action.id ? { ...a, retries: a.retries + 1 } : a),
                }));
              }
            }
          }
        } finally {
          inFlight = false;
          set({ isSyncing: false });
        }
      },
    }),
    {
      name: 'offline-sync-queue-v2',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ queue: state.queue, currentTripId: state.currentTripId }) as SyncState,
    }
  )
);

NetInfo.addEventListener((netState) => {
  if (netState.isConnected) {
    useSyncStore.getState().processQueue();
  }
});
