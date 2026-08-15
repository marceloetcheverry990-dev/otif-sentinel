import crypto from 'crypto';

const META_APP_SECRET = process.env.META_APP_SECRET;
if (!META_APP_SECRET) {
  throw new Error('META_APP_SECRET is required to sign simulator requests');
}

// 🟢 FIX CRÍTICO: Apuntando explícitamente a la terminal local de Wrangler (IPv4)
const WORKER_URL = 'https://lead-rescue-pipeline.marceloetcheverry990.workers.dev/wms-webhook';

function signPayload(payloadString, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payloadString);
  return `sha256=${hmac.digest('hex')}`;
}

function createWMSPayload(otId, escenario) {
  return {
    source: "WMS_INTERNO",
    timestamp: Math.floor(Date.now() / 1000),
    updates: [{
      ot_id: String(otId),
      cliente: escenario.cliente,
      etapa: escenario.etapa,              
      produccion_estandar: escenario.produccion_estandar,      
      produccion_real: escenario.produccion_real,          
      horas_para_sla: escenario.horas_para_sla,
      minutos_camion_esperando: escenario.minutos_camion_esperando,
      lat: escenario.lat,
      lng: escenario.lng
    }]
  };
}

async function fireWebhook(otId, escenario) {
  console.log(`🚀 [${escenario.cliente}] Simulando OT: ${otId} | Etapa: ${escenario.etapa}`);
  const payload = createWMSPayload(otId, escenario);
  const payloadString = JSON.stringify(payload);
  const signature = signPayload(payloadString, META_APP_SECRET);

  try {
    const response = await fetch(WORKER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': signature
      },
      body: payloadString
    });

    const text = await response.text();
    if (response.status === 202) {
      console.log(`✅ Éxito: 202 - OT [${otId}] encolada correctamente.`);
    } else {
      console.error(`❌ Falló: ${response.status} - ${text}`);
    }
  } catch (error) {
    console.error(`💥 Error de Conexión: ${error.message}`);
  }
}

// ==========================================
// 📦 ESCENARIOS DE NEGOCIO PARA LA DEMO
// ==========================================

const CASO_A_RETENER = {
  cliente: "Enjoy Santiago",
  etapa: "CAMION_ASIGNADO",
  produccion_estandar: 1000,
  produccion_real: 800,
  horas_para_sla: 0,
  minutos_camion_esperando: 15,
  lat: -32.856, lng: -70.714 // Coordenadas de Enjoy
};

const CASO_B_CORTAR = {
  cliente: "Enjoy Santiago",
  etapa: "CAMION_ASIGNADO",
  produccion_estandar: 1000,
  produccion_real: 800,
  horas_para_sla: -1, 
  minutos_camion_esperando: 90,
  lat: -32.856, lng: -70.714 
};

const CASO_C_PANICO = {
  cliente: "Falabella",
  etapa: "EN_RUTA",
  produccion_estandar: 500,
  produccion_real: 500,
  horas_para_sla: 1,
  minutos_camion_esperando: 0,
  lat: -33.437, lng: -70.650 // Centro de Santiago
};

// ==========================================
// 🎬 EJECUCIÓN (Rápida)
// ==========================================

async function runDemo() {
  console.log("🎬 Iniciando OTIF Sentinel - Disparo Rápido...\n");

  await fireWebhook(`OT-ENJOY-RETENER-${Date.now()}`, CASO_A_RETENER);
  await fireWebhook(`OT-ENJOY-CORTAR-${Date.now()}`, CASO_B_CORTAR);
  await fireWebhook(`OT-FALA-PANICO-${Date.now()}`, CASO_C_PANICO);
  
  console.log("\n🎉 Misiles disparados. Revisa la terminal de Wrangler y Telegram.");
}

runDemo();