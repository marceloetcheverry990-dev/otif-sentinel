// src/api/login-page.js
// Página HTML de login para operadores de Torre de Control.
// Sin dependencias externas — HTML, CSS y JS completamente inline.
// La sesión se entrega como cookie HttpOnly; JavaScript nunca recibe el token.

export function handleLoginPage(request, env) {
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Torre de Control — Acceso</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 16px;
      padding: 40px;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.4);
    }
    .logo {
      text-align: center;
      font-size: 2rem;
      margin-bottom: 8px;
    }
    h1 {
      text-align: center;
      font-size: 1.25rem;
      font-weight: 700;
      color: #f1f5f9;
      margin-bottom: 4px;
    }
    .subtitle {
      text-align: center;
      font-size: 0.875rem;
      color: #94a3b8;
      margin-bottom: 32px;
    }
    label {
      display: block;
      font-size: 0.8125rem;
      font-weight: 600;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 6px;
    }
    input {
      width: 100%;
      padding: 12px 14px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 8px;
      color: #e2e8f0;
      font-size: 1rem;
      margin-bottom: 20px;
      transition: border-color 0.2s;
      outline: none;
    }
    input:focus { border-color: #3b82f6; }
    button {
      width: 100%;
      padding: 13px;
      background: #2563eb;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover:not(:disabled) { background: #1d4ed8; }
    button:disabled { background: #475569; cursor: not-allowed; }
    .msg {
      margin-top: 16px;
      padding: 12px 14px;
      border-radius: 8px;
      font-size: 0.875rem;
      font-weight: 600;
      display: none;
    }
    .msg.error { background: rgba(239,68,68,0.15); color: #f87171; border: 1px solid rgba(239,68,68,0.3); }
    .msg.warn  { background: rgba(245,158,11,0.15); color: #fbbf24; border: 1px solid rgba(245,158,11,0.3); }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">🏗️</div>
    <h1>Torre de Control</h1>
    <p class="subtitle">OTIF Sentinel — Acceso operadores</p>

    <form id="loginForm">
      <label for="username">Usuario</label>
      <input type="text" id="username" name="username" autocomplete="username" required>

      <label for="password">Contraseña</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required>

      <button type="submit" id="submitBtn">Ingresar</button>
    </form>

    <div class="msg" id="msg"></div>
  </div>

  <script>
    const form = document.getElementById('loginForm');
    const btn  = document.getElementById('submitBtn');
    const msg  = document.getElementById('msg');

    function showMsg(text, type) {
      msg.textContent = text;
      msg.className = 'msg ' + type;
      msg.style.display = 'block';
    }

    form.addEventListener('submit', async function(e) {
      e.preventDefault();
      msg.style.display = 'none';
      btn.disabled = true;
      btn.textContent = 'Verificando...';

      const username = document.getElementById('username').value.trim();
      const password = document.getElementById('password').value;
      const controller = new AbortController();
      const timeoutId = setTimeout(function() { controller.abort(); }, 15000);

      try {
        const res = await fetch('/api/operator/login', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
          signal: controller.signal,
        });

        const data = await res.json().catch(() => ({}));

        if (res.ok && data.success) {
          window.__loginNavigating = true;
          btn.textContent = 'Entrando...';
          window.location.replace('/control-tower');
          return;
        }

        if (res.status === 429) {
          const secs = data.retry_after_seconds ?? 60;
          showMsg('Demasiados intentos. Esperá ' + secs + ' segundos antes de volver a intentar.', 'warn');
        } else if (res.status === 401) {
          showMsg('Usuario o contraseña incorrectos.', 'error');
        } else if (res.status === 503) {
          showMsg(data.error || 'El servicio no está configurado. Contactá al administrador.', 'error');
        } else {
          showMsg('Error inesperado (' + res.status + '). Intentá nuevamente.', 'error');
        }

      } catch (err) {
        if (err && err.name === 'AbortError') {
          showMsg('El servidor no respondió a tiempo. Revisá /health e intentá de nuevo.', 'error');
        } else {
          showMsg('Error de conexión. Verificá tu red e intentá nuevamente.', 'error');
        }
      } finally {
        clearTimeout(timeoutId);
        if (!window.__loginNavigating) {
          btn.disabled = false;
          btn.textContent = 'Ingresar';
        }
      }
    });
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
