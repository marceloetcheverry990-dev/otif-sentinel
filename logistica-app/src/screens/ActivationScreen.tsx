import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { useAuthStore } from '../store/authStore';

export default function ActivationScreen({ navigation }: any) {
  const { checkRUT, activateAccount, isLoading } = useAuthStore();
  const [step, setStep] = useState<1 | 2>(1);
  const [tenantId, setTenantId] = useState('');
  const [rut, setRut] = useState('');
  const [newPin, setNewPin] = useState('');

  const handleVerify = async () => {
    if (!tenantId || !rut) return Alert.alert("Error", "Ingrese Empresa y RUT.");
    try {
      const { canActivate } = await checkRUT(tenantId.trim(), rut.trim());
      if (canActivate) {
        setStep(2);
      } else {
        Alert.alert("Aviso", "Esta cuenta ya tiene un PIN o no está registrada.");
      }
    } catch (error: any) {
      // CORRECCIÓN: Ahora lee el mensaje real que escupe el authStore (fetch)
      Alert.alert("Error del Servidor", error.message || "Error desconocido.");
    }
  };

  const handleActivate = async () => {
    if (newPin.length !== 4) return Alert.alert("Error", "El PIN debe ser de 4 dígitos.");
    try {
      await activateAccount(tenantId.trim(), rut.trim(), newPin);
      Alert.alert("Éxito", "Cuenta activada correctamente");
      // App Navigator debería reaccionar a isAuthenticated = true automáticamente
    } catch (error: any) {
      // CORRECCIÓN: Ahora lee el mensaje real que escupe el authStore (fetch)
      Alert.alert("Error del Servidor", error.message || "No se pudo activar la cuenta.");
    }
  };
  
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Activar Cuenta</Text>
      
      <View style={styles.inputContainer}>
        <Text style={styles.label}>Código de Empresa</Text>
        <TextInput
          style={styles.input}
          value={tenantId}
          onChangeText={setTenantId}
          placeholder="empresa_base"
          accessibilityLabel="Código de Empresa"
          editable={step === 1 && !isLoading}
        />
      </View>
      
      <View style={styles.inputContainer}>
        <Text style={styles.label}>RUT (con guión)</Text>
        <TextInput
          style={styles.input}
          value={rut}
          onChangeText={setRut}
          placeholder="11111111-1"
          accessibilityLabel="RUT"
          editable={step === 1 && !isLoading}
        />
      </View>

      {step === 2 && (
        <View style={styles.inputContainer}>
          <Text style={styles.label}>Crea tu PIN (4 dígitos)</Text>
          <TextInput 
            style={styles.input} value={newPin} 
            onChangeText={(t) => setNewPin(t.replace(/[^0-9]/g, ''))} 
            placeholder="1234"
            keyboardType="numeric" secureTextEntry maxLength={4}
            accessibilityLabel="Nuevo PIN"
            editable={!isLoading} 
          />
        </View>
      )}

      {step === 1 ? (
        <TouchableOpacity
          style={[styles.button, isLoading && styles.disabled]}
          onPress={handleVerify}
          disabled={isLoading}
          accessibilityRole="button"
          accessibilityLabel="Verificar Identidad"
        >
          {isLoading ? <ActivityIndicator color="#FFF" /> : <Text style={styles.buttonText}>VERIFICAR IDENTIDAD</Text>}
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          style={[styles.button, styles.successButton, isLoading && styles.disabled]}
          onPress={handleActivate}
          disabled={isLoading}
          accessibilityRole="button"
          accessibilityLabel="Establecer PIN y Entrar"
        >
          {isLoading ? <ActivityIndicator color="#FFF" /> : <Text style={styles.buttonText}>ESTABLECER PIN Y ENTRAR</Text>}
        </TouchableOpacity>
      )}

      <TouchableOpacity
        style={styles.secondaryButton}
        onPress={() => navigation.goBack()}
        disabled={isLoading}
        accessibilityRole="button"
        accessibilityLabel="Volver al Login"
      >
        <Text style={styles.secondaryButtonText}>Volver al Login</Text>
      </TouchableOpacity>
    </View>
  );
}

// (Reutiliza los mismos estilos de LoginScreen, añadiendo 'successButton: { backgroundColor: '#2E7D32' }')
const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, justifyContent: 'center', backgroundColor: '#F5F5F5' },
  title: { fontSize: 28, fontWeight: 'bold', color: '#1A1A1A', marginBottom: 40, textAlign: 'center' },
  inputContainer: { marginBottom: 16 },
  label: { fontSize: 14, fontWeight: '600', color: '#4A4A4A', marginBottom: 8 },
  input: { backgroundColor: '#FFF', borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 8, padding: 16, fontSize: 16 },
  button: { backgroundColor: '#0056D2', padding: 16, borderRadius: 8, alignItems: 'center', marginTop: 12 },
  successButton: { backgroundColor: '#2E7D32' },
  disabled: { backgroundColor: '#A0A0A0' },
  buttonText: { color: '#FFF', fontSize: 16, fontWeight: 'bold' },
  secondaryButton: { marginTop: 24, alignItems: 'center' },
  secondaryButtonText: { color: '#4A4A4A', fontSize: 14, fontWeight: '600' }
});