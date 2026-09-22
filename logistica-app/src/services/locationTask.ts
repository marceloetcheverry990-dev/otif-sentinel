import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import { Platform } from 'react-native';
import { useSyncStore } from '../store/syncStore';

export const BACKGROUND_LOCATION_TASK = 'BACKGROUND_LOCATION_TASK';

// Agregamos "async" aquí abajo para cumplir con el tipado estricto de Expo
if (Platform.OS !== 'web') {
  TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
    if (error) {
      // Antes solo console.error: si se revoca el permiso de ubicación en
      // background, el chofer nunca se enteraba (nadie ve la consola en
      // producción) y el tracking dejaba de mandar pings en silencio.
      console.error("Error en Background Location:", error.message);
      useSyncStore.getState().setLocationError(error.message || 'Error de ubicación en segundo plano');
      return;
    }

    if (data) {
      const { locations } = data as { locations: Location.LocationObject[] };
      const latestLocation = locations[0];

      if (latestLocation) {
        console.log("GPS Track:", latestLocation.coords.latitude, latestLocation.coords.longitude);

        // Task funcionando de nuevo: limpiar cualquier error previo.
        useSyncStore.getState().setLocationError(null);

        // Solo enviar pings si hay un viaje activo: /api/gps/ping exige trip_id
        // asignado al chofer del token
        const { currentTripId, addAction } = useSyncStore.getState();
        if (currentTripId) {
          addAction('/tracking', {
            trip_id: currentTripId,
            lat: latestLocation.coords.latitude,
            lng: latestLocation.coords.longitude,
            timestamp: latestLocation.timestamp,
          });
        }
      }
    }
  });
}