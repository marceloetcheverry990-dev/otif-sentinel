import React, { useState, useEffect, useRef } from 'react';
import { 
  View, Text, StyleSheet, FlatList, TouchableOpacity, 
  Linking, Alert, Modal, Image, TextInput, ActivityIndicator,
  KeyboardAvoidingView, Platform, RefreshControl
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { useAuthStore } from '../store/authStore';
import { useSyncStore } from '../store/syncStore';
import { useChatStore } from '../store/chatStore';
import { uploadEvidencePhoto } from '../services/evidence';
import ScanOtModal from '../components/ScanOtModal';
import SignaturePad from '../components/SignaturePad';
import { API_BASE_URL } from '../config/api';

type StopStatus = 'BLOQUEADA' | 'ACTIVA' | 'EN_SITIO' | 'COMPLETADA' | 'PROBLEMA';
type EventResult = 'ok' | 'queued' | 'failed';

interface PodRequirements {
  foto: boolean;
  firma: boolean;
  scan: boolean;
  notas: boolean;
}

interface StopInfo {
  id: string;
  client: string;
  address: string;
  lat: number | null;
  lng: number | null;
  status: StopStatus;
  pod_requirements?: PodRequirements;
}

const DEFAULT_POD: PodRequirements = { foto: true, firma: true, scan: true, notas: false };

function resolveStopPod(stop?: StopInfo | null): PodRequirements {
  const p = stop?.pod_requirements;
  if (!p || typeof p !== 'object') return DEFAULT_POD;
  return {
    foto: p.foto !== false,
    firma: p.firma !== false,
    scan: p.scan !== false,
    notas: !!p.notas,
  };
}

async function captureCoords(): Promise<{ latitud: number; longitud: number } | null> {
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== 'granted') {
      const req = await Location.requestForegroundPermissionsAsync();
      if (req.status !== 'granted') return null;
    }
    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    return {
      latitud: pos.coords.latitude,
      longitud: pos.coords.longitude,
    };
  } catch {
    return null;
  }
}

export default function HomeScreen() {
  const { tenantId, rut, driverName, token, logout } = useAuthStore();
  const { addAction, setCurrentTrip, queue, isSyncing, retryFailed, processQueue } = useSyncStore();
  const failedQueue = queue.filter((a) => a.failed);
  const pendingQueue = queue.filter((a) => !a.failed);
  
  // --- ESTADOS DEL CHAT ---
  const { messages, fetchMessages, sendMessage, clearChat, isSending } = useChatStore();
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatInputText, setChatInputText] = useState('');
  const chatListRef = useRef<FlatList>(null);
  const shownRescueMissionRef = useRef<string | null>(null);
  
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false); // <-- NUEVO ESTADO
  const [error, setError] = useState<string | null>(null);
  const [viajes, setViajes] = useState<any[]>([]);
  const [stops, setStops] = useState<StopInfo[]>([]);
  
  const [activeStopId, setActiveStopId] = useState<string | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [firmaPreview, setFirmaPreview] = useState<string | null>(null);
  const [isFirmaOpen, setIsFirmaOpen] = useState(false);
  const [isScanOpen, setIsScanOpen] = useState(false);
  const [scannedCodigo, setScannedCodigo] = useState<string | null>(null);
  
  const [isProblemModalOpen, setIsProblemModalOpen] = useState(false);
  const [problemStep, setProblemStep] = useState<'LIST' | 'OTHER'>('LIST');
  const [customProblemText, setCustomProblemText] = useState('');
  const [problemPhoto, setProblemPhoto] = useState<string | null>(null);

  // ==========================================
  // NUEVO: FUNCIÓN EXTRAÍDA PARA RECARGAR
  // ==========================================
  const fetchViajes = async () => {
    if (!tenantId || !rut) {
      setError('Credenciales de usuario incompletas.');
      setIsLoading(false);
      return;
    }
    try {
      setError(null);
      const url = `${API_BASE_URL}/api/app-chofer-rutas?tenant_id=${tenantId}&rut=${rut}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      });
      if (response.status === 401) {
        // Token restaurado inválido/expirado: cerrar sesión en vez de reintentar
        await logout();
        return;
      }
      if (!response.ok) throw new Error('Detalle del Backend: Falló la red');

      const data = await response.json();
      console.log('📦 RESPUESTA RUTAS:', JSON.stringify(data, null, 2));
      if (data.viajes && data.viajes.length > 0) {
        const viajeActivo = data.viajes[0];
        const misiones = data.misiones_rescate || viajeActivo.misiones_rescate || [];
        if (Array.isArray(misiones) && misiones.length > 0) {
          const m = misiones[0];
          const mid = String(m.id || m.source_trip_id || '');
          if (mid && shownRescueMissionRef.current !== mid) {
            shownRescueMissionRef.current = mid;
            Alert.alert(
              'Misión de rescate',
              m.mensaje ||
                `Te asignaron ${Array.isArray(m.ot_ids) ? m.ot_ids.length : 0} parada(s) desde ${m.source_trip_id || 'otro viaje'}. Revisá la secuencia.`
            );
          }
        }

        const syncQueue = useSyncStore.getState().queue;
        const hasPendingEvent = (stopId: string, tipo: string) =>
          syncQueue.some(
            (a) =>
              a.endpoint === '/chofer/evento' &&
              !a.failed &&
              String(a.payload?.stop_id) === String(stopId) &&
              String(a.payload?.tipo_evento || '').toUpperCase() === tipo
          );

        let stopActivaEncontrada = false;

        const paradasMapeadas: StopInfo[] = viajeActivo.paradas
          .sort((a: any, b: any) => a.orden - b.orden)
          .map((p: any) => {
            let statusCalculado: StopStatus = 'BLOQUEADA';
            const estadoDB = p.estado_bd;

            // 1. Verificar si ya se procesó
            if (estadoDB === 'ENTREGADO' || estadoDB === 'COMPLETADA') {
                statusCalculado = 'COMPLETADA';
            } else if (estadoDB === 'RECHAZADO' || estadoDB === 'PROBLEMA') {
                statusCalculado = 'PROBLEMA';
            } else if (estadoDB === 'EN_SITIO') {
                // El chofer ya registró llegada — está en el sitio esperando descargar
                statusCalculado = 'EN_SITIO';
                stopActivaEncontrada = true; // Esta parada es la activa
            } else {
                // 2. Si no está terminada, la primera pendiente que encontremos será la ACTIVA
                if (!stopActivaEncontrada) {
                    statusCalculado = 'ACTIVA';
                    stopActivaEncontrada = true;
                } else {
                    statusCalculado = 'BLOQUEADA';
                }
            }

            return {
              id: p.id,
              client: p.nombre,
              address: p.direccion,
              lat: typeof p.lat === 'number' ? p.lat : (p.lat != null ? Number(p.lat) : null),
              lng: typeof p.lng === 'number' ? p.lng : (p.lng != null ? Number(p.lng) : null),
              status: statusCalculado,
              pod_requirements: p.pod_requirements
                ? {
                    foto: p.pod_requirements.foto !== false,
                    firma: p.pod_requirements.firma !== false,
                    scan: p.pod_requirements.scan !== false,
                    notas: !!p.pod_requirements.notas,
                  }
                : DEFAULT_POD,
            };
          });

        // M2: no revertir EN_SITIO / COMPLETADA optimistas mientras el evento sigue en cola
        setStops((prev) => {
          const merged = paradasMapeadas.map((mapped) => {
            const old = prev.find((p) => p.id === mapped.id);
            if (!old) return mapped;
            if (
              old.status === 'EN_SITIO' &&
              mapped.status === 'ACTIVA' &&
              hasPendingEvent(mapped.id, 'LLEGADA')
            ) {
              return { ...mapped, status: 'EN_SITIO' as StopStatus };
            }
            if (
              old.status === 'COMPLETADA' &&
              mapped.status !== 'COMPLETADA' &&
              mapped.status !== 'PROBLEMA' &&
              hasPendingEvent(mapped.id, 'ENTREGA')
            ) {
              return { ...mapped, status: 'COMPLETADA' as StopStatus };
            }
            return mapped;
          });
          // Recalcular ACTIVA/BLOQUEADA tras preservar EN_SITIO
          let activaOk = false;
          return merged.map((s) => {
            if (s.status === 'COMPLETADA' || s.status === 'PROBLEMA') return s;
            if (s.status === 'EN_SITIO') {
              activaOk = true;
              return s;
            }
            if (!activaOk) {
              activaOk = true;
              return { ...s, status: 'ACTIVA' as StopStatus };
            }
            return { ...s, status: 'BLOQUEADA' as StopStatus };
          });
        });

        // HEURÍSTICA DE SEGURIDAD: 
        // Si el chofer ya tiene alguna parada en 'COMPLETADA' o 'PROBLEMA', 
        // significa que la ruta YA INICIÓ, sin importar lo que diga el servidor.
        // Esto evita que vuelva a salir el botón "Comenzar Ruta" por latencia de red.
        const algunaProcesada = paradasMapeadas.some(p => p.status === 'COMPLETADA' || p.status === 'PROBLEMA');
        if (algunaProcesada) {
            viajeActivo.estado = 'EN_RUTA';
        }

        setViajes([viajeActivo]);
        setCurrentTrip(viajeActivo.trip_id);
      } else {
        setViajes([]);
        setStops([]);
        setCurrentTrip(null);
      }
    } catch (err: any) {
      setError(err.message || 'Error desconocido al obtener las rutas.');
    } finally {
      setIsLoading(false);
    }
  };

  // Carga inicial
  useEffect(() => {
    setIsLoading(true);
    fetchViajes();
  }, [tenantId, rut]);

  // Poll liviano para detectar re-opt mid-day (cambio de secuencia / nuevas paradas)
  useEffect(() => {
    if (!tenantId || !rut || !token) return;
    const id = setInterval(() => {
      fetchViajes();
    }, 45000);
    return () => clearInterval(id);
  }, [tenantId, rut, token]);

  // Si una mutación queda en cola (ej. SALIDA tras PROBLEMA por 5xx transitorio),
  // reintentar en background para no dejar la UI pegada en "pendiente" indefinidamente.
  useEffect(() => {
    if (!tenantId || !rut || !token) return;
    if (pendingQueue.length === 0 && failedQueue.length === 0) return;

    processQueue();
    const retryId = setInterval(() => {
      const sync = useSyncStore.getState();
      if (sync.isSyncing) return;
      if (sync.queue.some((a) => a.failed && a.endpoint === '/chofer/evento')) {
        sync.retryFailed();
      } else {
        sync.processQueue();
      }
    }, 10000);

    return () => clearInterval(retryId);
  }, [tenantId, rut, token, pendingQueue.length, failedQueue.length, processQueue]);

  // Acción al deslizar hacia abajo
  const onRefresh = async () => {
    setRefreshing(true);
    await fetchViajes();
    setRefreshing(false);
  };

  // --- EFECTO DE SINCRONIZACIÓN DEL CHAT ---
  useEffect(() => {
    let interval: ReturnType<typeof setInterval>; 
    if (isChatOpen && viajes.length > 0 && tenantId) {
      const activeTripId = viajes[0].trip_id;
      fetchMessages(tenantId, activeTripId); 
      interval = setInterval(() => { fetchMessages(tenantId, activeTripId); }, 5000);
    }
    return () => clearInterval(interval);
  }, [isChatOpen, viajes, tenantId]);

  const handleSendChat = async () => {
    if (!chatInputText.trim() || viajes.length === 0 || !tenantId || !rut) return;
    const textToSend = chatInputText;
    setChatInputText(''); 
    await sendMessage(tenantId, viajes[0].trip_id, rut, textToSend, null);
  };

  const iniciarRuta = async () => {
    if (viajes.length === 0 || !tenantId || !rut || !token) return;

    const tripId = viajes[0].trip_id;
    const nuevosViajes = [...viajes];
    nuevosViajes[0].estado = 'EN_RUTA';
    setViajes(nuevosViajes);

    // Persistencia inmediata (no solo cola): dispara guía Res.154 en el Worker
    try {
      const res = await fetch(`${API_BASE_URL}/api/mobile-sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          path: '/viajes/estado',
          payload: { trip_id: tripId, estado: 'EN_RUTA', timestamp: Date.now() },
          tenant_id: tenantId,
          rut,
        }),
      });
      if (!res.ok && res.status !== 401) {
        addAction('/viajes/estado', {
          trip_id: tripId,
          estado: 'EN_RUTA',
          timestamp: Date.now(),
        });
      }
      if (res.status === 401) {
        await logout();
        return;
      }
    } catch {
      addAction('/viajes/estado', {
        trip_id: tripId,
        estado: 'EN_RUTA',
        timestamp: Date.now(),
      });
    }

    await sendMessage(tenantId, tripId, rut, '🚀 ¡He comenzado la ruta y voy en camino!');
    // Refresco corto para ver guías en Torre / estado flota
    setTimeout(() => { fetchViajes(); }, 1200);
  };

  const handleStopInteraction = (stop: StopInfo, action: () => void) => {
    if (stop.status === 'BLOQUEADA') return Alert.alert("Alto ahí", "Debes terminar la entrega actual.");
    if (stop.status === 'COMPLETADA' || stop.status === 'PROBLEMA') return Alert.alert("Aviso", "Esta parada ya fue procesada.");
    action();
  };

  const handleNavigate = async (lat: number | null, lng: number | null) => {
    if (
      lat == null ||
      lng == null ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng)
    ) {
      Alert.alert(
        'Sin pin GPS',
        'Esta parada no tiene coordenadas exactas. Pedí a Torre de Control que valide la dirección con N° de casa.'
      );
      return;
    }
    const wazeUrl = `waze://?ll=${lat},${lng}&navigate=yes`;
    try {
      if (await Linking.canOpenURL(wazeUrl)) await Linking.openURL(wazeUrl);
      else await Linking.openURL(`geo:${lat},${lng}?q=${lat},${lng}`);
    } catch {
      Alert.alert("Error", "No se pudo abrir la navegación.");
    }
  };

  const openCamera = async (): Promise<string | null> => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permiso Denegado', 'Necesitamos la cámara para capturar la evidencia.');
      return null;
    }
    const result = await ImagePicker.launchCameraAsync({quality: 0.5, base64: true});
    return result.canceled
    ? null
    : `data:image/jpeg;base64,${result.assets[0].base64}`;
  };  

  const handleDeliveryCamera = async (stopId: string) => {
    setActiveStopId(stopId);
    setScannedCodigo(null);
    const stop = stops.find((s) => s.id === stopId);
    const pod = resolveStopPod(stop);
    if (pod.scan) {
      setIsScanOpen(true);
      return;
    }
    if (pod.foto) {
      const uri = await openCamera();
      if (uri) setPhotoPreview(uri);
      else Alert.alert('Sin foto', 'Necesitamos la foto de evidencia (POD).');
      return;
    }
    if (pod.firma) {
      setIsFirmaOpen(true);
      return;
    }
    processStop(stopId, 'COMPLETADA', {});
  };

  const onScanMatched = async (codigo: string) => {
    setScannedCodigo(codigo);
    setIsScanOpen(false);
    const stop = stops.find((s) => s.id === activeStopId);
    const pod = resolveStopPod(stop);
    if (pod.foto) {
      const uri = await openCamera();
      if (uri) {
        setPhotoPreview(uri);
      } else {
        setScannedCodigo(null);
        Alert.alert('Sin foto', 'El escaneo quedó OK, pero necesitamos la foto de evidencia (POD).');
      }
      return;
    }
    if (pod.firma) {
      setIsFirmaOpen(true);
      return;
    }
    processStop(activeStopId!, 'COMPLETADA', { codigo_escaneado: codigo });
  };

  const handleProblemCamera = async () => {
    const uri = await openCamera();
    if (uri) setProblemPhoto(uri);
  };

  const closeProblemModal = () => {
    setIsProblemModalOpen(false);
    setProblemStep('LIST');
    setCustomProblemText('');
    setProblemPhoto(null);
  };

  // ─── Máquina de estados: llama al nuevo endpoint /api/chofer/evento ─────────
  const registrarEvento = async (
    stopId: string,
    tipo_evento: 'LLEGADA' | 'ENTREGA' | 'SALIDA' | 'PROBLEMA',
    extras: { foto_url?: string | null; firma_url?: string | null; razon?: string; codigo_escaneado?: string | null } = {}
  ): Promise<EventResult> => {
    if (!tenantId || !rut || !token || viajes.length === 0) return 'failed';
    const trip_id = viajes[0].trip_id;

    // El Worker solo acepta URLs de su storage: subir base64 primero
    let fotoUrl = extras.foto_url || null;
    let firmaUrl = extras.firma_url || null;
    let pendingPhoto: string | null = null;
    let pendingFirma: string | null = null;
    if (fotoUrl && fotoUrl.startsWith('data:image')) {
      const uploaded = await uploadEvidencePhoto(token, fotoUrl);
      if (uploaded) {
        fotoUrl = uploaded;
      } else {
        pendingPhoto = fotoUrl;
        fotoUrl = null;
      }
    }
    if (firmaUrl && firmaUrl.startsWith('data:image')) {
      const uploaded = await uploadEvidencePhoto(token, firmaUrl);
      if (uploaded) {
        firmaUrl = uploaded;
      } else {
        pendingFirma = firmaUrl;
        firmaUrl = null;
      }
    }

    const coords = await captureCoords();

    const eventBody: Record<string, unknown> = {
      trip_id,
      stop_id: stopId,
      tipo_evento,
      razon: extras.razon,
      foto_url: fotoUrl,
      firma_url: firmaUrl,
    };
    if (extras.codigo_escaneado) {
      eventBody.codigo_escaneado = extras.codigo_escaneado;
    }
    if (coords) {
      eventBody.latitud = coords.latitud;
      eventBody.longitud = coords.longitud;
    }

    if (pendingPhoto || pendingFirma) {
      addAction('/chofer/evento', {
        ...eventBody,
        pending_photo: pendingPhoto,
        pending_firma: pendingFirma,
        timestamp: Date.now(),
      });
      return 'queued';
    }

    try {
      const res = await fetch(
        `${API_BASE_URL}/api/chofer/evento?tenant_id=${encodeURIComponent(tenantId)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify(eventBody),
        }
      );
      if (res.status === 401) {
        await logout();
        return 'failed';
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 4xx de negocio: no encolar (evita loop); 5xx/red → catch
        if (res.status >= 400 && res.status < 500) {
          Alert.alert('No se pudo registrar', data.error || `Error ${res.status}`);
          return 'failed';
        }
        throw new Error(data.error || 'Error del servidor');
      }
      return 'ok';
    } catch (err: any) {
      // Fallback offline / 5xx: encolar en syncStore para reintento automático
      addAction('/chofer/evento', { ...eventBody, timestamp: Date.now() });
      return 'queued';
    }
  };

  const handleLlegada = async (stopId: string) => {
    const result = await registrarEvento(stopId, 'LLEGADA');
    if (result === 'failed') return;
    // ok o queued (offline): UI en sitio; el poll no lo revierte si sigue en cola
    setStops(prev => prev.map(s => s.id === stopId ? { ...s, status: 'EN_SITIO' } : s));
    if (result === 'ok') {
      const stopActual = stops.find(s => s.id === stopId);
      await sendMessage(tenantId!, viajes[0].trip_id, rut!, `📍 Llegué al cliente: ${stopActual?.client || stopId}`);
    }
  };

  const handleSelectProblem = (reason: string) => {
    if (reason === 'Otro (Describir y Fotografiar)') {
      setProblemStep('OTHER');
    } else {
      processStop(activeStopId!, 'PROBLEMA', { reason, photo: null });
    }
  };

  const submitCustomProblem = () => {
    if (!customProblemText.trim()) return Alert.alert("Falta detalle", "Por favor describe el problema brevemente.");
    processStop(activeStopId!, 'PROBLEMA', { reason: customProblemText, photo: problemPhoto });
  };

  const processStop = async (stopId: string, finalStatus: 'COMPLETADA' | 'PROBLEMA', payloadData: any) => {
    const stopActual = stops.find(s => s.id === stopId);
    const clientName = stopActual?.client || 'Cliente';
    const fotoUrl = payloadData?.foto_url || payloadData?.photo || null;
    const firmaUrl = payloadData?.firma_url || payloadData?.firma || null;

    // Calcular siguiente parada ANTES del setStops optimista — el índice es válido aquí
    const currentIndex = stops.findIndex(s => s.id === stopId);
    const siguienteStop = stops
      .slice(currentIndex + 1)
      .find(s => s.status !== 'COMPLETADA' && s.status !== 'PROBLEMA');

    let eventResult: EventResult = 'failed';
    if (finalStatus === 'COMPLETADA') {
      const pod = resolveStopPod(stopActual);
      const codigo = payloadData?.codigo_escaneado || scannedCodigo;
      if (pod.scan && !codigo) {
        Alert.alert('Falta escaneo', 'Escaneá el QR del paquete antes de confirmar la entrega.');
        return;
      }
      if (pod.firma && !firmaUrl) {
        Alert.alert('Falta firma', 'Pedí la firma del receptor antes de confirmar.');
        return;
      }
      if (pod.foto && !fotoUrl) {
        Alert.alert('Falta foto', 'Tomá la foto de evidencia antes de confirmar.');
        return;
      }
      eventResult = await registrarEvento(stopId, 'ENTREGA', {
        foto_url: fotoUrl,
        firma_url: firmaUrl,
        codigo_escaneado: codigo || null,
      });
      setScannedCodigo(null);
      setFirmaPreview(null);
    } else {
      eventResult = await registrarEvento(stopId, 'PROBLEMA', {
        foto_url: fotoUrl,
        razon: payloadData?.reason || null,
      });
    }

    if (eventResult === 'failed') {
      // No avanzar UI ni emitir SALIDA si el evento principal falló
      return;
    }

    // Actualización optimista (ok o queued offline)
    setStops(prev => {
      const newStops = [...prev];
      const idx = newStops.findIndex(s => s.id === stopId);
      if (idx < 0) return prev;
      newStops[idx] = { ...newStops[idx], status: finalStatus };
      if (idx + 1 < newStops.length && newStops[idx + 1].status === 'BLOQUEADA') {
        newStops[idx + 1] = { ...newStops[idx + 1], status: 'ACTIVA' };
      }
      return newStops;
    });

    if (viajes.length > 0 && tenantId && rut && eventResult === 'ok') {
      if (finalStatus === 'COMPLETADA') {
        const textoEntrega = `✅ Entrega confirmada en ${clientName}.`;
        await sendMessage(tenantId, viajes[0].trip_id, rut, textoEntrega, fotoUrl);

        if (siguienteStop) {
          await sendMessage(
            tenantId, viajes[0].trip_id, rut,
            `🚗 En camino a la siguiente entrega: ${siguienteStop.client}`
          );
        } else {
          await sendMessage(
            tenantId, viajes[0].trip_id, rut,
            `🏁 Última entrega completada. Regresando a bodega.`
          );
        }
      } else {
        const textoProblema = `⚠️ Problema reportado en ${clientName}: ${payloadData?.reason || 'Sin detalle'}`;
        await sendMessage(tenantId, viajes[0].trip_id, rut, textoProblema, fotoUrl);
      }
    }

    // SALIDA solo si ENTREGA/PROBLEMA quedó ok o en cola (no si falló)
    await registrarEvento(stopId, 'SALIDA');

    setPhotoPreview(null);
    closeProblemModal();
    setActiveStopId(null);
  };

  const renderStop = ({ item, index }: { item: StopInfo, index: number }) => {
    const isRutaIniciada = viajes[0]?.estado === 'EN_RUTA';
    const isLocked = !isRutaIniciada || item.status === 'BLOQUEADA';
    const isDone = item.status === 'COMPLETADA' || item.status === 'PROBLEMA';
    const isProblem = item.status === 'PROBLEMA';
    return (
        <View style={[styles.card, isLocked && styles.cardLocked, item.status === 'COMPLETADA' && styles.cardDone, isProblem && styles.cardProblem]}>
            <View style={styles.cardHeader}>
          <View style={[styles.stopBadge, isDone && styles.stopBadgeDone]}>
            <Text style={[styles.stopBadgeText, isDone && styles.textWhite]}>{index + 1}</Text>
          </View>
          <View style={styles.cardInfo}>
            <Text style={styles.clientName}>
              {item.client}
              {isLocked && ' 🔒'}
              {item.status === 'EN_SITIO' && ' 📍'}
              {item.status === 'COMPLETADA' && ' ✅'}
              {item.status === 'PROBLEMA' && ' ⚠️'}
            </Text>
            <Text style={styles.clientAddress}>{item.address}</Text>
          </View>
        </View>

        {/* ── PASO 1: Chofer llegó al punto — botón Registrar Llegada ── */}
        {item.status === 'ACTIVA' && isRutaIniciada && (
          <View style={styles.actionPanel}>
            {/* Navegar: ancho completo arriba */}
            <TouchableOpacity style={styles.btnNav} onPress={() => handleNavigate(item.lat, item.lng)}>
              <Text style={styles.btnTextNav}>🗺 Navegar</Text>
            </TouchableOpacity>
            {/* Llegada + Problema: misma fila, mismo tamaño */}
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[styles.btnLlegada, { flex: 1, marginRight: 5 }]}
                onPress={() => handleLlegada(item.id)}
              >
                <Text style={styles.btnTextWhite}>📍 Registrar Llegada</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btnProblem, { flex: 1, marginLeft: 5 }]}
                onPress={() => { setActiveStopId(item.id); setIsProblemModalOpen(true); }}
              >
                <Text style={styles.btnTextWhite}>Problema ⚠️</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ── PASO 2: Chofer en sitio — botón Confirmar Entrega (requiere foto) ── */}
        {item.status === 'EN_SITIO' && isRutaIniciada && (
          <View style={styles.actionPanel}>
            <View style={styles.enSitioBanner}>
              <Text style={styles.enSitioText}>📍 En sitio — esperando descarga</Text>
            </View>
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={styles.btnDeliver}
                onPress={() => handleDeliveryCamera(item.id)}
              >
                <Text style={styles.btnTextWhite}>
                  {(() => {
                    const pod = resolveStopPod(item);
                    if (!pod.foto && !pod.firma && !pod.scan) return 'Confirmar entrega ✓';
                    return 'Escanear y entregar 📦';
                  })()}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.btnProblem}
                onPress={() => { setActiveStopId(item.id); setIsProblemModalOpen(true); }}
              >
                <Text style={styles.btnTextWhite}>Problema ⚠️</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {(isLocked || isDone) && <TouchableOpacity style={styles.overlayTouch} onPress={() => handleStopInteraction(item, () => {})} />}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>Hola, {driverName?.split(' ')[0] || 'Chofer'}</Text>
          <Text style={styles.rutText}>RUT: {rut}</Text>
        </View>
        <TouchableOpacity onPress={logout} style={styles.logoutButton}>
          <Text style={styles.logoutText}>Salir</Text>
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color="#0056D2" />
          <Text style={styles.loadingText}>Cargando tus rutas...</Text>
        </View>
      ) : error ? (
        <View style={styles.centerContainer}>
          <Text style={styles.errorText}>Error: {error}</Text>
        </View>
      ) : viajes.length === 0 || stops.length === 0 ? (
        <View style={styles.centerContainer}>
          <Text style={styles.emptyText}>No tienes rutas asignadas en este momento</Text>
        </View>
      ) : (
        <>
          {failedQueue.length > 0 ? (
            <View style={styles.syncBannerFail}>
              <Text style={styles.syncBannerText}>
                {failedQueue.length} evento(s) no sincronizados
                {failedQueue[0]?.lastError ? ` · ${failedQueue[0].lastError}` : ''}
              </Text>
              <TouchableOpacity onPress={() => retryFailed()} style={styles.syncBannerBtn}>
                <Text style={styles.syncBannerBtnText}>Reintentar</Text>
              </TouchableOpacity>
            </View>
          ) : pendingQueue.length > 0 ? (
            <TouchableOpacity
              style={styles.syncBannerPending}
              onPress={() => processQueue()}
              disabled={isSyncing}
            >
              <Text style={styles.syncBannerText}>
                {isSyncing ? 'Sincronizando…' : `${pendingQueue.length} pendiente(s) de envío · tocar para sync`}
              </Text>
            </TouchableOpacity>
          ) : null}

          <View style={styles.summaryCard}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <View>
                <Text style={styles.summaryTitle}>Ruta Activa</Text>
                <Text style={styles.summaryTripId}>{viajes[0]?.trip_id || 'SIN ID'}</Text>
              </View>
              <TouchableOpacity style={styles.btnChatLaunch} onPress={() => setIsChatOpen(true)}>
                <Text style={styles.btnTextWhite}>💬 Chat</Text>
              </TouchableOpacity>
            </View>
          </View>

          <Text style={styles.sectionTitle}>Entregas ({stops.length})</Text>
          
          {viajes[0]?.estado !== 'EN_RUTA' && (
            <TouchableOpacity 
              style={{ backgroundColor: '#10b981', padding: 16, marginHorizontal: 16, borderRadius: 8, alignItems: 'center', marginBottom: 16, elevation: 3 }} 
              onPress={iniciarRuta}
            >
              <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 18 }}>🚀 COMENZAR RUTA</Text>
            </TouchableOpacity>
          )}

          <FlatList 
            data={stops} 
            keyExtractor={(item) => item.id.toString()} 
            renderItem={renderStop} 
            contentContainerStyle={styles.listContainer} 
            // ==========================================
            // NUEVO: PULL TO REFRESH CONFIGURADO
            // ==========================================
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#0056D2']} />
            }
          />
        </>
      )}

      {/* MODAL DE CHAT */}
      <Modal visible={isChatOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setIsChatOpen(false)}>
        <KeyboardAvoidingView style={styles.chatContainer} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.chatHeader}>
            <View>
              <Text style={styles.chatTitle}>Centro de Control</Text>
              <Text style={{ color: '#94a3b8', fontSize: 12, marginTop: 2 }}>
                👤 {driverName?.split(' ')[0]} • 🚚 {viajes[0]?.trip_id}
              </Text>
            </View>
            <TouchableOpacity onPress={() => setIsChatOpen(false)}>
              <Text style={styles.chatCloseText}>Cerrar</Text>
            </TouchableOpacity>
          </View>

          <FlatList
            ref={chatListRef}
            data={messages}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ padding: 16 }}
            onContentSizeChange={() => chatListRef.current?.scrollToEnd({ animated: true })}
            renderItem={({ item }) => {
              const isMe = item.tipo_evento !== 'CHAT_TORRE';
              const time = new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              return (
                <View style={[styles.chatBubbleWrapper, isMe ? styles.chatBubbleRight : styles.chatBubbleLeft]}>
                  <View style={[styles.chatBubble, isMe ? styles.chatBubbleMe : styles.chatBubbleThem]}>
                    <Text style={{ fontSize: 10, color: isMe ? 'rgba(255,255,255,0.7)' : '#64748b', marginBottom: 4, fontWeight: 'bold' }}>
                      {isMe ? 'Tú' : 'Torre de Control'}
                    </Text>

                    {item.foto_url ? (
                      <TouchableOpacity onPress={() => Linking.openURL(item.foto_url)}>
                    <Image
                      source={{ uri: item.foto_url }}
                      style={{width: 200, height: 200, borderRadius: 8, marginBottom: item.mensaje ? 8 : 0, backgroundColor: '#e2e8f0',}}/>
            <Text
              style={{
                fontSize: 11,
                color: isMe ? '#dbeafe' : '#2563eb',
                marginTop: 4,
                textAlign: 'center',
              }}
            >
            ⬇️ Ver / Descargar evidencia
          </Text>
        </TouchableOpacity>
                ) : null}
  
                    {item.mensaje ? <Text style={isMe ? styles.chatTextMe : styles.chatTextThem}>{item.mensaje}</Text> : null}
                    <Text style={isMe ? styles.chatTimeMe : styles.chatTimeThem}>{time}</Text>
                  </View>
                </View>
              );
            }}
          />

          <View style={styles.chatInputRow}>
            <TextInput
              style={styles.chatInput}
              placeholder="Avisar a la torre..."
              value={chatInputText}
              onChangeText={setChatInputText}
              multiline
              editable={!isSending}
            />
            <TouchableOpacity 
              style={[styles.btnSendChat, (!chatInputText.trim() || isSending) && { backgroundColor: '#94a3b8' }]} 
              disabled={!chatInputText.trim() || isSending}
              onPress={handleSendChat}
            >
              <Text style={styles.btnTextWhite}>{isSending ? '...' : 'Enviar'}</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* MODAL ESCANEO QR / BARCODE */}
      <ScanOtModal
        visible={isScanOpen && !!activeStopId}
        expectedOtId={activeStopId || ''}
        clientName={stops.find((s) => s.id === activeStopId)?.client}
        onCancel={() => {
          setIsScanOpen(false);
          setScannedCodigo(null);
        }}
        onMatched={onScanMatched}
      />

      {/* MODAL DE FOTO DE ENTREGA */}
      <Modal visible={!!photoPreview && !isFirmaOpen} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Confirmar Evidencia</Text>
            {scannedCodigo ? (
              <Text style={{ textAlign: 'center', marginBottom: 8, color: '#059669' }}>
                Código OK: {scannedCodigo}
              </Text>
            ) : null}
            {photoPreview && <Image source={{ uri: photoPreview }} style={styles.previewImage} />}
            <TouchableOpacity
              style={styles.btnModalSuccess}
              onPress={() => {
                const pod = resolveStopPod(stops.find((s) => s.id === activeStopId));
                if (pod.firma) {
                  setIsFirmaOpen(true);
                  return;
                }
                processStop(activeStopId!, 'COMPLETADA', {
                  photo: photoPreview,
                  codigo_escaneado: scannedCodigo,
                });
                setPhotoPreview(null);
              }}
            >
              <Text style={styles.btnTextWhite}>
                {resolveStopPod(stops.find((s) => s.id === activeStopId)).firma
                  ? 'CONTINUAR A FIRMA'
                  : 'CONFIRMAR ENTREGA'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.btnModalDanger} onPress={() => setPhotoPreview(null)}>
              <Text style={styles.btnTextWhite}>VOLVER A TOMAR FOTO</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={isFirmaOpen} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '90%' }]}>
            <SignaturePad
              onCancel={() => setIsFirmaOpen(false)}
              onSigned={(dataUrl) => {
                setFirmaPreview(dataUrl);
                setIsFirmaOpen(false);
                processStop(activeStopId!, 'COMPLETADA', {
                  photo: photoPreview,
                  firma: dataUrl,
                  codigo_escaneado: scannedCodigo,
                });
                setPhotoPreview(null);
              }}
            />
          </View>
        </View>
      </Modal>   

      {/* MODAL: REPORTE DE PROBLEMAS */}
      <Modal visible={isProblemModalOpen} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Reportar Inconveniente</Text>
            
            {problemStep === 'LIST' ? (
              <>
                {['Local Cerrado', 'Cliente Rechaza', 'Dirección Inaccesible', 'Otro (Describir y Fotografiar)'].map((reason) => (
                  <TouchableOpacity key={reason} style={styles.problemOption} onPress={() => handleSelectProblem(reason)}>
                    <Text style={[styles.problemOptionText, reason.startsWith('Otro') && styles.textBold]}>{reason}</Text>
                  </TouchableOpacity>
                ))}
              </>
            ) : (
              <View>
                <TextInput
                  style={styles.textArea}
                  placeholder="Ej: Choque en la autopista, vehículo averiado..."
                  multiline
                  numberOfLines={4}
                  value={customProblemText}
                  onChangeText={setCustomProblemText}
                />
                
                {problemPhoto ? (
                  <View>
                    <Image source={{ uri: problemPhoto }} style={styles.smallPreview} />
                    <TouchableOpacity style={styles.btnSecondary} onPress={handleProblemCamera}>
                      <Text style={styles.btnTextSecondary}>Cambiar Foto</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity style={styles.btnSecondary} onPress={handleProblemCamera}>
                    <Text style={styles.btnTextSecondary}>Añadir Foto de Respaldo 📸 (Opcional)</Text>
                  </TouchableOpacity>
                )}

                <TouchableOpacity style={styles.btnModalDanger} onPress={submitCustomProblem}>
                  <Text style={styles.btnTextWhite}>ENVIAR REPORTE</Text>
                </TouchableOpacity>
              </View>
            )}

            <TouchableOpacity style={{marginTop: 24, padding: 10}} onPress={closeProblemModal}>
              <Text style={{color: '#666', textAlign: 'center', fontWeight: 'bold'}}>CANCELAR</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F5F5' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#0056D2', padding: 24, paddingTop: 60, paddingBottom: 20 },
  greeting: { fontSize: 24, fontWeight: 'bold', color: '#FFF' },
  rutText: { fontSize: 14, color: '#E0E0E0', marginTop: 4 },
  logoutButton: { padding: 8, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 6 },
  logoutText: { color: '#FFF', fontWeight: '600' },
  
  centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  loadingText: { marginTop: 12, fontSize: 16, color: '#666' },
  errorText: { color: '#D32F2F', fontSize: 16, fontWeight: 'bold', textAlign: 'center' },
  emptyText: { color: '#666', fontSize: 16, textAlign: 'center', fontStyle: 'italic' },

  syncBannerFail: {
    marginHorizontal: 16, marginTop: 12, padding: 12, borderRadius: 8,
    backgroundColor: '#FEE2E2', borderWidth: 1, borderColor: '#FCA5A5',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8,
  },
  syncBannerPending: {
    marginHorizontal: 16, marginTop: 12, padding: 12, borderRadius: 8,
    backgroundColor: '#FEF3C7', borderWidth: 1, borderColor: '#FCD34D',
  },
  syncBannerText: { flex: 1, fontSize: 13, fontWeight: '600', color: '#1F2937' },
  syncBannerBtn: { backgroundColor: '#B91C1C', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6 },
  syncBannerBtnText: { color: '#FFF', fontWeight: '700', fontSize: 13 },

  summaryCard: { backgroundColor: '#FFF', margin: 16, padding: 16, borderRadius: 8, borderLeftWidth: 4, borderLeftColor: '#2E7D32', elevation: 2 },
  summaryTitle: { fontSize: 12, color: '#666', textTransform: 'uppercase', fontWeight: 'bold' },
  summaryTripId: { fontSize: 22, fontWeight: 'bold', color: '#1A1A1A', marginVertical: 4 },
  sectionTitle: { fontSize: 16, fontWeight: 'bold', color: '#1A1A1A', marginLeft: 16, marginBottom: 8 },
  listContainer: { paddingHorizontal: 16, paddingBottom: 24 },
  
  card: { backgroundColor: '#FFF', padding: 16, borderRadius: 8, marginBottom: 12, elevation: 2 },
  cardLocked: { opacity: 0.5, backgroundColor: '#E0E0E0' },
  cardDone: { backgroundColor: '#F1F8E9' },
  cardProblem: { backgroundColor: '#FFEBEE' },
  overlayTouch: { ...StyleSheet.absoluteFillObject },
  cardHeader: { flexDirection: 'row', alignItems: 'center' },
  stopBadge: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#E3F2FD', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  stopBadgeDone: { backgroundColor: '#2E7D32' },
  stopBadgeText: { color: '#0056D2', fontWeight: 'bold', fontSize: 16 },
  textWhite: { color: '#FFF' },
  textBold: { fontWeight: 'bold', color: '#0056D2' },
  cardInfo: { flex: 1 },
  clientName: { fontSize: 16, fontWeight: 'bold', color: '#1A1A1A' },
  clientAddress: { fontSize: 14, color: '#666', marginTop: 2 },
  
  actionPanel: { marginTop: 16, borderTopWidth: 1, borderTopColor: '#EEE', paddingTop: 16 },
  actionRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  btnNav: { backgroundColor: '#E3F2FD', padding: 12, borderRadius: 6, alignItems: 'center' },
  btnTextNav: { color: '#0056D2', fontWeight: 'bold', fontSize: 14 },
  btnLlegada: { backgroundColor: '#F57C00', padding: 14, borderRadius: 6, alignItems: 'center', marginTop: 10 },
  btnDeliver: { flex: 1, backgroundColor: '#2E7D32', padding: 14, borderRadius: 6, alignItems: 'center', marginRight: 5 },
  btnProblem: { flex: 1, backgroundColor: '#D32F2F', padding: 14, borderRadius: 6, alignItems: 'center', marginLeft: 5 },
  enSitioBanner: { backgroundColor: '#FFF3E0', borderRadius: 6, padding: 10, marginBottom: 10, alignItems: 'center' },
  enSitioText: { color: '#E65100', fontWeight: '700', fontSize: 14 },
  btnTextWhite: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },
  
  btnChatLaunch: { backgroundColor: '#2563eb', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 },
  chatContainer: { flex: 1, backgroundColor: '#f1f5f9' },
  chatHeader: { flexDirection: 'row', justifyContent: 'space-between', padding: 16, paddingTop: 24, backgroundColor: '#0f172a' },
  chatTitle: { color: '#FFF', fontSize: 18, fontWeight: 'bold' },
  chatCloseText: { color: '#38bdf8', fontSize: 16, fontWeight: 'bold' },
  chatBubbleWrapper: { marginBottom: 12, flexDirection: 'row' },
  chatBubbleRight: { justifyContent: 'flex-end' },
  chatBubbleLeft: { justifyContent: 'flex-start' },
  chatBubble: { maxWidth: '80%', padding: 12, borderRadius: 12 },
  chatBubbleMe: { backgroundColor: '#2563eb', borderBottomRightRadius: 0 },
  chatBubbleThem: { backgroundColor: '#ffffff', borderBottomLeftRadius: 0, borderWidth: 1, borderColor: '#e2e8f0' },
  chatTextMe: { color: '#ffffff', fontSize: 15 },
  chatTextThem: { color: '#0f172a', fontSize: 15 },
  chatTimeMe: { color: 'rgba(255,255,255,0.7)', fontSize: 10, marginTop: 4, alignSelf: 'flex-end' },
  chatTimeThem: { color: '#94a3b8', fontSize: 10, marginTop: 4, alignSelf: 'flex-end' },
  chatInputRow: { flexDirection: 'row', padding: 12, backgroundColor: '#ffffff', borderTopWidth: 1, borderColor: '#e2e8f0', alignItems: 'flex-end' },
  chatInput: { flex: 1, backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 20, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10, fontSize: 15, maxHeight: 100 },
  btnSendChat: { marginLeft: 12, backgroundColor: '#2563eb', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 20, justifyContent: 'center' },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 },
  modalContent: { backgroundColor: '#FFF', padding: 24, borderRadius: 12 },
  modalTitle: { fontSize: 18, fontWeight: 'bold', marginBottom: 20, textAlign: 'center' },
  previewImage: { width: '100%', height: 300, borderRadius: 8, marginBottom: 16, resizeMode: 'cover' },
  smallPreview: { width: '100%', height: 120, borderRadius: 8, marginBottom: 10, resizeMode: 'cover' },
  problemOption: { padding: 16, borderBottomWidth: 1, borderBottomColor: '#EEE' },
  problemOptionText: { fontSize: 16, color: '#1A1A1A', textAlign: 'center' },
  textArea: { backgroundColor: '#F5F5F5', borderWidth: 1, borderColor: '#DDD', borderRadius: 8, padding: 12, minHeight: 100, textAlignVertical: 'top', marginBottom: 16, fontSize: 16 },
  btnSecondary: { backgroundColor: '#E3F2FD', padding: 12, borderRadius: 6, alignItems: 'center' },
  btnTextSecondary: { color: '#0056D2', fontWeight: 'bold', fontSize: 14 },
  btnModalSuccess: { backgroundColor: '#2E7D32', padding: 16, borderRadius: 8, alignItems: 'center', marginTop: 12 },
  btnModalDanger: { backgroundColor: '#D32F2F', padding: 16, borderRadius: 8, alignItems: 'center', marginTop: 12 }
});