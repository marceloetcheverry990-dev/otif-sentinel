import { describe, expect, it } from 'vitest';
import { sanitizeErrorMessage, captureError, generateErrorFingerprint } from './errors.js';

describe('sanitizeErrorMessage', () => {
  it('redacta email, Bearer token y tarjeta de crédito', () => {
    const msg = 'Fallo para juan@empresa.cl con Authorization: Bearer sk-abc123XYZ y tarjeta 4111111111111111';
    const out = sanitizeErrorMessage(msg);
    expect(out).not.toContain('juan@empresa.cl');
    expect(out).not.toContain('sk-abc123XYZ');
    expect(out).not.toContain('4111111111111111');
  });

  it('sanitiza un stack trace completo igual que el mensaje suelto (V8 embebe el mensaje en la 1ra línea)', () => {
    // Así arma V8 error.stack: "<Name>: <message>\n    at fn (file:line:col)"
    const stack =
      'Error: Fallo autenticando a cliente@empresa.cl con Authorization: Bearer sk-live-secreto123\n' +
      '    at authenticate (file:///app/src/auth.js:42:11)\n' +
      '    at process (file:///app/src/index.js:10:5)';
    const out = sanitizeErrorMessage(stack);
    expect(out).not.toContain('cliente@empresa.cl');
    expect(out).not.toContain('sk-live-secreto123');
    // El resto del stack (ubicación del error) sigue siendo útil para debug.
    expect(out).toContain('at authenticate');
    expect(out).toContain('auth.js:42:11');
  });
});

describe('captureError — persiste stack_trace ya sanitizado, no el crudo', () => {
  it('el valor insertado en la columna stack_trace no contiene el email/token original', async () => {
    const err = new Error('Fallo con juan@empresa.cl y Authorization: Bearer sk-secret-999');
    let inserted = null;
    const fakeClient = {
      query: async (_sql, values) => {
        inserted = values;
        return { rows: [] };
      },
    };
    await captureError(err, { tenant_id: 'empresa_base', trace_id: 't1' }, fakeClient);
    expect(inserted).not.toBeNull();
    const [, , errorMessage, , stackTrace] = inserted; // orden: severity, error_type, error_message, error_fingerprint, stack_trace, ...
    expect(errorMessage).not.toContain('juan@empresa.cl');
    expect(stackTrace).not.toContain('juan@empresa.cl');
    expect(stackTrace).not.toContain('sk-secret-999');
  });
});

describe('generateErrorFingerprint', () => {
  it('produce el mismo fingerprint para el mismo tipo+mensaje normalizado+ubicación', () => {
    const a = new Error('Timeout tras 30 intentos');
    const b = new Error('Timeout tras 45 intentos');
    a.stack = 'Error: Timeout tras 30 intentos\n    at foo (file:///app/x.js:1:1)';
    b.stack = 'Error: Timeout tras 45 intentos\n    at foo (file:///app/x.js:1:1)';
    expect(generateErrorFingerprint(a)).toBe(generateErrorFingerprint(b));
  });
});
