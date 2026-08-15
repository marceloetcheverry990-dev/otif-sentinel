import React, { useCallback, useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';

type Props = {
  visible: boolean;
  expectedOtId: string;
  clientName?: string;
  onCancel: () => void;
  onMatched: (codigo: string) => void;
};

function normalizeLocal(raw: string, expected: string): string | null {
  const data = String(raw || '').trim();
  if (!data) return null;
  if (data === expected) return data;
  if (data.startsWith('{')) {
    try {
      const obj = JSON.parse(data);
      const id = obj?.ot_id || obj?.otId || obj?.stop_id;
      if (id && String(id).trim() === expected) return String(id).trim();
    } catch {
      /* ignore */
    }
  }
  try {
    const u = new URL(data);
    const q = u.searchParams.get('ot_id') || u.searchParams.get('ot') || u.searchParams.get('stop_id');
    if (q && q.trim() === expected) return q.trim();
  } catch {
    /* ignore */
  }
  return data === expected ? data : null;
}

/**
 * Escáner QR/barcode: el contenido debe coincidir con el ot_id de la parada.
 * Incluye ingreso manual por si la cámara falla o aún no hay etiqueta impresa.
 */
export default function ScanOtModal({
  visible,
  expectedOtId,
  clientName,
  onCancel,
  onMatched,
}: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [manual, setManual] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setScanned(false);
      setManual('');
      setError(null);
      if (!permission?.granted) {
        requestPermission().catch(() => {});
      }
    }
  }, [visible, permission?.granted, requestPermission]);

  const acceptIfMatch = useCallback(
    (raw: string) => {
      const match = normalizeLocal(raw, expectedOtId);
      if (match) {
        setScanned(true);
        setError(null);
        onMatched(match);
        return;
      }
      setError(`Código incorrecto. Debe ser: ${expectedOtId}`);
    },
    [expectedOtId, onMatched]
  );

  const onBarcodeScanned = useCallback(
    ({ data }: { data: string }) => {
      if (scanned) return;
      acceptIfMatch(data);
    },
    [scanned, acceptIfMatch]
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
      <View style={styles.root}>
        <Text style={styles.title}>Escanear paquete</Text>
        <Text style={styles.sub}>
          {clientName ? `${clientName}\n` : ''}OT: {expectedOtId}
        </Text>

        {!permission ? (
          <ActivityIndicator color="#fff" style={{ marginTop: 40 }} />
        ) : !permission.granted ? (
          <View style={styles.permBox}>
            <Text style={styles.permText}>Necesitamos la cámara para leer el QR del paquete.</Text>
            <TouchableOpacity style={styles.btnPrimary} onPress={() => requestPermission()}>
              <Text style={styles.btnText}>Permitir cámara</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.cameraWrap}>
            <CameraView
              style={StyleSheet.absoluteFillObject}
              facing="back"
              barcodeScannerSettings={{
                barcodeTypes: ['qr', 'code128', 'code39', 'ean13', 'ean8'],
              }}
              onBarcodeScanned={scanned ? undefined : onBarcodeScanned}
            />
            <View style={styles.frame} />
          </View>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Text style={styles.manualLabel}>O ingresá el código a mano</Text>
        <TextInput
          style={styles.input}
          value={manual}
          onChangeText={setManual}
          placeholder={expectedOtId}
          autoCapitalize="characters"
          autoCorrect={false}
        />
        <TouchableOpacity
          style={styles.btnPrimary}
          onPress={() => acceptIfMatch(manual)}
        >
          <Text style={styles.btnText}>Validar código</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.btnCancel} onPress={onCancel}>
          <Text style={styles.btnText}>Cancelar</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0f172a',
    paddingTop: 48,
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', textAlign: 'center' },
  sub: { color: '#94a3b8', textAlign: 'center', marginTop: 8, marginBottom: 12 },
  cameraWrap: {
    height: 280,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#000',
    marginBottom: 12,
  },
  frame: {
    position: 'absolute',
    top: '20%',
    left: '15%',
    right: '15%',
    bottom: '20%',
    borderWidth: 2,
    borderColor: '#38bdf8',
    borderRadius: 8,
  },
  error: { color: '#f87171', textAlign: 'center', marginBottom: 8 },
  manualLabel: { color: '#cbd5e1', marginBottom: 6, marginTop: 4 },
  input: {
    backgroundColor: '#1e293b',
    color: '#fff',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  btnPrimary: {
    backgroundColor: '#0284c7',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 10,
  },
  btnCancel: {
    backgroundColor: '#475569',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  btnText: { color: '#fff', fontWeight: '700' },
  permBox: { marginTop: 40, alignItems: 'center' },
  permText: { color: '#e2e8f0', textAlign: 'center', marginBottom: 16 },
});
