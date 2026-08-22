import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { useAuthStore } from '../store/authStore';

export default function LoginScreen({ navigation }: any) {
  const { login, isLoading } = useAuthStore();
  const [tenantId, setTenantId] = useState('empresa_base');
  const [rut, setRut] = useState('11111111-1');
  const [pin, setPin] = useState('');
  const [formError, setFormError] = useState('');

  const handleLogin = async () => {
    setFormError('');
    if (!tenantId || !rut || pin.length !== 4) {
      const msg = 'Complete código de empresa, RUT válido y PIN de 4 dígitos.';
      setFormError(msg);
      Alert.alert('Error', msg);
      return;
    }

    try {
      await login(tenantId.trim(), rut.trim(), pin);
      // Redirección manejada por estado global en el App Navigator
    } catch (error: any) {
      const msg = error?.message || 'Credenciales inválidas.';
      setFormError(msg);
      Alert.alert('Acceso Denegado', msg);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Logística Driver</Text>
      
      <View style={styles.inputContainer}>
        <Text style={styles.label}>Código de Empresa (Tenant ID)</Text>
        <TextInput
          style={styles.input}
          value={tenantId}
          onChangeText={setTenantId}
          placeholder="empresa_base"
          autoCapitalize="none"
          accessibilityLabel="Código de Empresa"
          editable={!isLoading}
        />
      </View>

      <View style={styles.inputContainer}>
        <Text style={styles.label}>RUT (con guión)</Text>
        <TextInput
          style={styles.input}
          value={rut}
          onChangeText={setRut}
          placeholder="11111111-1"
          keyboardType="default"
          autoCapitalize="none"
          accessibilityLabel="RUT"
          editable={!isLoading}
        />
      </View>

      <View style={styles.inputContainer}>
        <Text style={styles.label}>PIN de Acceso</Text>
        <TextInput
          style={styles.input}
          value={pin}
          onChangeText={(text) => setPin(text.replace(/[^0-9]/g, ''))}
          placeholder="PIN de 4 dígitos"
          keyboardType="numeric"
          secureTextEntry
          maxLength={4}
          accessibilityLabel="PIN de Acceso"
          editable={!isLoading}
        />
      </View>

      {!!formError && <Text style={styles.errorText}>{formError}</Text>}

      <TouchableOpacity
        style={[styles.button, isLoading && styles.disabled]}
        onPress={handleLogin}
        disabled={isLoading}
        accessibilityRole="button"
        accessibilityLabel="Ingresar"
      >
        {isLoading ? <ActivityIndicator color="#FFF" /> : <Text style={styles.buttonText}>INGRESAR</Text>}
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.secondaryButton}
        onPress={() => navigation.navigate('Activation')}
        disabled={isLoading}
        accessibilityRole="button"
        accessibilityLabel="Ir a Activar Cuenta"
      >
        <Text style={styles.secondaryButtonText}>¿Primer ingreso? Activa tu cuenta</Text>
      </TouchableOpacity>
    </View>
  );
}

// (Reutiliza el StyleSheet del LoginScreen original, añadiendo 'secondaryButton' y 'secondaryButtonText')
const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, justifyContent: 'center', backgroundColor: '#F5F5F5' },
  title: { fontSize: 28, fontWeight: 'bold', color: '#1A1A1A', marginBottom: 40, textAlign: 'center' },
  inputContainer: { marginBottom: 16 },
  label: { fontSize: 14, fontWeight: '600', color: '#4A4A4A', marginBottom: 8 },
  input: { backgroundColor: '#FFF', borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 8, padding: 16, fontSize: 16 },
  button: { backgroundColor: '#0056D2', padding: 16, borderRadius: 8, alignItems: 'center', marginTop: 12 },
  disabled: { backgroundColor: '#A0A0A0' },
  buttonText: { color: '#FFF', fontSize: 16, fontWeight: 'bold' },
  secondaryButton: { marginTop: 24, alignItems: 'center' },
  secondaryButtonText: { color: '#0056D2', fontSize: 14, fontWeight: '600' },
  errorText: { color: '#b91c1c', marginBottom: 8, fontSize: 14, textAlign: 'center' },
});