import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import { Platform } from 'react-native';
import { useSyncStore } from '../store/syncStore';

export const BACKGROUND_LOCATION_TASK = 'BACKGROUND_LOCATION_TASK';

// Agregamos "async" aquí abajo para cumplir con el tipado estricto de Expo
if (Platform.OS !== 'web') {
  TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
    if (error) {
      console.error("Error en Background Location:", error.message);
      return;
    }

    if (data) {
      const { locations } = data as { locations: Location.LocationObject[] };
      const latestLocation = locations[0];

      if (latestLocation) {
        console.log("GPS Track:", latestLocation.coords.latitude, latestLocation.coords.longitude);

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