import React, { useEffect } from 'react';
import { Alert, Platform } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as Location from 'expo-location';

import { useAuthStore } from './src/store/authStore';
import { useSyncStore } from './src/store/syncStore';
import { useChatStore } from './src/store/chatStore';
import LoginScreen from './src/screens/LoginScreen';
import ActivationScreen from './src/screens/ActivationScreen';
import HomeScreen from './src/screens/HomeScreen';

// 1. IMPORTAR LA TAREA ANTES DE CUALQUIER COMPONENTE
import { BACKGROUND_LOCATION_TASK } from './src/services/locationTask';

const Stack = createNativeStackNavigator();

export default function App() {
  const { isAuthenticated, gpsInterval } = useAuthStore();

  // 2. LÓGICA DE PERMISOS ESTRICTOS Y ARRANQUE DE GPS
  useEffect(() => {
    const pingSeconds = Math.min(300, Math.max(15, Number(gpsInterval) || 60));
    const pingMs = pingSeconds * 1000;

    // Al cerrar sesión: detener GPS incondicionalmente y purgar datos locales
    const stopTrackingAndCleanup = async () => {
      try {
        const started = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
        if (started) {
          await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
          console.log('🛑 GPS detenido tras logout');
        }
      } catch (err) {
        console.warn('Error deteniendo GPS:', err);
      }
      useSyncStore.getState().clearQueue();
      useChatStore.getState().clearChat();
    };

    const startBackgroundTracking = async () => {
      if (!isAuthenticated) return;
      if (Platform.OS === 'web') return;

      try {
        // A. Permiso en Primer Plano (OBLIGATORIO PRIMERO)
        const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
        if (fgStatus !== 'granted') {
          Alert.alert("GPS Requerido", "Debes permitir la ubicación para trabajar.");
          return;
        }

        // B. Permiso en Segundo Plano (OBLIGATORIO SEGUNDO)
        const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
        if (bgStatus !== 'granted') {
          Alert.alert("Atención", "Selecciona 'Permitir todo el tiempo' para que la app funcione con la pantalla apagada.");
          return;
        }

        // C. Arrancar (o reiniciar) el Foreground Service de Android
        const started = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
        if (started) {
          await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
        }

        await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: pingMs,
          distanceInterval: 50,
          showsBackgroundLocationIndicator: true,
          foregroundService: {
            notificationTitle: "Logística Activa",
            notificationBody: "Compartiendo ubicación con la central...",
            notificationColor: "#0056D2",
          },
        });
        console.log(`📡 GPS intervalo: ${pingSeconds}s`);
      } catch (err) {
        console.error("Error al iniciar tracking:", err);
      }
    };

    if (isAuthenticated) {
      startBackgroundTracking();
    } else {
      stopTrackingAndCleanup();
    }
  }, [isAuthenticated, gpsInterval]);

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {!isAuthenticated ? (
          <>
            <Stack.Screen name="Login" component={LoginScreen} />
            <Stack.Screen name="Activation" component={ActivationScreen} />
          </>
        ) : (
          <Stack.Screen name="Home" component={HomeScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}