import { create } from 'zustand';
import type {} from 'zustand/middleware';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { API_BASE_URL as API_URL } from '../config/api';

const { persist, createJSONStorage } =
  require('zustand/middleware.js') as typeof import('zustand/middleware');

// expo-secure-store no funciona en web — usar localStorage como fallback
const secureStorage =
  Platform.OS === 'web'
    ? {
        getItem: async (name: string): Promise<string | null> =>
          typeof localStorage !== 'undefined' ? localStorage.getItem(name) : null,
        setItem: async (name: string, value: string): Promise<void> => {
          if (typeof localStorage !== 'undefined') localStorage.setItem(name, value);
        },
        removeItem: async (name: string): Promise<void> => {
          if (typeof localStorage !== 'undefined') localStorage.removeItem(name);
        },
      }
    : {
        getItem: async (name: string): Promise<string | null> => await SecureStore.getItemAsync(name),
        setItem: async (name: string, value: string): Promise<void> => await SecureStore.setItemAsync(name, value),
        removeItem: async (name: string): Promise<void> => await SecureStore.deleteItemAsync(name),
      };

interface AuthState {
  token: string | null;
  tenantId: string | null;
  rut: string | null;
  driverName: string | null;
  gpsInterval: number | null; 
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (tenantId: string, rut: string, pin: string) => Promise<void>;
  checkRUT: (tenantId: string, rut: string) => Promise<{ canActivate: boolean }>;
  activateAccount: (tenantId: string, rut: string, newPin: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      tenantId: null,
      rut: null,
      driverName: null,
      gpsInterval: null,
      isAuthenticated: false,
      isLoading: false,

      // --- LOGIN REAL CONECTADO A CLOUDFLARE ---
      login: async (tenantId, rut, pin) => {
        set({ isLoading: true });
        try {
          const response = await fetch(`${API_URL}/api/choferes/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tenant_id: tenantId, rut, pin })
          });

          const data = await response.json();

          if (!response.ok) {
            throw new Error(data.error || "Error al iniciar sesión");
          }

          set({ 
            token: data.token, 
            tenantId, 
            rut, 
            driverName: data.driverName,
            gpsInterval: data.gpsInterval,
            isAuthenticated: true, 
            isLoading: false 
          });
        } catch (error: any) {
          set({ isLoading: false });
          throw new Error(error.message || "No se pudo conectar al servidor");
        }
      },

      // --- VERIFICAR SI PUEDE ACTIVAR ---
      checkRUT: async (tenantId, rut) => {
        set({ isLoading: true });
        try {
          const response = await fetch(`${API_URL}/api/choferes/check-rut`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tenant_id: tenantId, rut })
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Error al verificar RUT");
          
          set({ isLoading: false });
          return { canActivate: data.canActivate };
        } catch (error: any) {
          set({ isLoading: false });
          throw new Error(error.message);
        }
      },

      // --- GUARDAR EL PIN EN LA BASE DE DATOS ---
      activateAccount: async (tenantId, rut, newPin) => {
        set({ isLoading: true });
        try {
          const response = await fetch(`${API_URL}/api/choferes/activate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tenant_id: tenantId, rut, pin: newPin })
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Error al activar cuenta");

          set({ 
            token: data.token, 
            tenantId, 
            rut, 
            driverName: data.driverName,
            gpsInterval: data.gpsInterval,
            isAuthenticated: true, 
            isLoading: false 
          });
        } catch (error: any) {
          set({ isLoading: false });
          throw new Error(error.message);
        }
      },

      logout: async () => {
        const token = useAuthStore.getState().token;
        if (token) {
          try {
            await fetch(`${API_URL}/api/choferes/logout`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
              },
            });
          } catch {
            // Local logout still proceeds if the network call fails
          }
        }
        set({
          token: null,
          tenantId: null,
          rut: null,
          driverName: null,
          gpsInterval: null,
          isAuthenticated: false,
        });
      }
    }),
    // 🔴 ESTA ES LA PARTE QUE SE TE HABÍA BORRADO 🔴
    {
      name: 'auth-storage',
      storage: createJSONStorage(() => secureStorage),
      partialize: (state) => ({ 
        token: state.token, 
        tenantId: state.tenantId, 
        rut: state.rut, 
        driverName: state.driverName, 
        gpsInterval: state.gpsInterval,
        isAuthenticated: state.isAuthenticated 
      }),
    }
  )
);