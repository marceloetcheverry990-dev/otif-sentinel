// src/store/chatStore.ts
import { create } from 'zustand';
import { useAuthStore } from './authStore';
import { API_BASE_URL } from '../config/api';

const authHeaders = (): Record<string, string> => {
  const { token } = useAuthStore.getState();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
};

export interface ChatMessage {
  id: string;
  emisor_tipo: 'CHOFER' | 'TORRE';
  mensaje: string;
  created_at: string;
  foto_url?: string | null;}

interface ChatState {
  messages: ChatMessage[];
  isLoading: boolean;
  isSending: boolean;
  fetchMessages: (tenantId: string, tripId: string) => Promise<void>;
  sendMessage: (tenantId: string, tripId: string, rutChofer: string, texto: string, fotoUrl?: string | null) => Promise<boolean>;
  clearChat: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isLoading: false,
  isSending: false,

  fetchMessages: async (tenantId, tripId) => {
    try {
      const response = await fetch(
        `${API_BASE_URL}/api/chat?tenant_id=${tenantId}&trip_id=${tripId}`,
        { headers: authHeaders() }
      );
      const data = await response.json();
      if (data.exito) {
        set({ messages: data.mensajes });
      }
    } catch (err) {
      console.log("Error leyendo chat:", err);
    }
  },

    sendMessage: async (tenantId, tripId, rutChofer, texto, fotoUrl = null) => {
    // Prevenir envíos duplicados
    if (get().isSending) {
      console.log('Ya hay un mensaje enviándose, ignorando...');
      return false;
    }

    set({ isSending: true });

    try {
      let uploadedPhotoUrl = null;

      // Si hay foto base64, subirla primero al servidor
      if (fotoUrl && fotoUrl.startsWith('data:image')) {
        try {
          const uploadResponse = await fetch(`${API_BASE_URL}/api/upload-evidence`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ photo: fotoUrl }),
          });
          const uploadData = await uploadResponse.json();
          if (uploadData.url) {
            uploadedPhotoUrl = uploadData.url;
          }
        } catch (uploadErr) {
          console.error('[UPLOAD_ERROR]', uploadErr);
          // Si falla el upload, continuar sin foto
        }
      } else if (fotoUrl) {
        // URL pública — usar directamente
        uploadedPhotoUrl = fotoUrl;
      }

      // Optimistic Update
      const tempMsg: ChatMessage = {
        id: `temp-${Date.now()}`,
        emisor_tipo: 'CHOFER',
        mensaje: texto,
        created_at: new Date().toISOString(),
        foto_url: uploadedPhotoUrl,
      };

      set((state) => ({
        messages: [...state.messages, tempMsg]
      }));

      // 2. Mandar chat con URL real
      const response = await fetch(`${API_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
        tenant_id: tenantId,
        trip_id: tripId,
          rut_chofer: rutChofer,
          emisor: 'CHOFER',
          mensaje: texto,
          foto_url: uploadedPhotoUrl
        }),
      });

      const data = await response.json();

      if (data.exito) {
        // No hacer fetchMessages aquí - el optimistic update ya agregó el mensaje
        // El polling periódico se encargará de sincronizar si es necesario
        set({ isSending: false });
        return true;
      }

      // Si falla, remover el mensaje temporal
      set((state) => ({
        messages: state.messages.filter(m => m.id !== tempMsg.id),
        isSending: false
      }));
      return false;
    } catch (err) {
      set((state) => ({
        messages: state.messages.filter(
          m => !m.id.startsWith('temp-')
        ),
        isSending: false
      }));
      return false;
    }
  },

  clearChat: () => set({ messages: [] })
}));