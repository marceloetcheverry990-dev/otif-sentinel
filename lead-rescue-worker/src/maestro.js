require('dotenv').config({ path: '.dev.vars' });
const { createClient } = require('@supabase/supabase-js');

// Script standalone con service-role key (bypassa RLS): --tenant es obligatorio,
// si no, arriesga leer/escribir clientes de TODOS los tenants mezclados en una
// sola pasada (ver auditoría: "scripts de importación sin filtro de tenant_id").
const TENANT_ARG = process.argv.find((a) => a.startsWith('--tenant='));
const TENANT_ID = TENANT_ARG ? TENANT_ARG.slice('--tenant='.length).trim() : null;
if (!TENANT_ID) {
  console.error('❌ Falta --tenant=<tenant_id>. Este script usa la service-role key (bypassa RLS) y sin --tenant explícito puede mezclar datos de todos los tenants.');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function sincronizarClientes() {
    console.log(`🔍 Iniciando Maestro de Clientes (V2 Enterprise) — tenant=${TENANT_ID}...`);

    // 1. Buscamos órdenes (solo de este tenant)
    const { data: ordenes, error: errOrdenes } = await supabase
        .from('ordenes_pendientes')
        .select('cliente')
        .eq('tenant_id', TENANT_ID)
        .eq('estado_operacional', 'PENDIENTE_RUTEO');

    if (errOrdenes) return console.error("❌ Error leyendo órdenes:", errOrdenes);
    if (!ordenes || ordenes.length === 0) return console.log("⚠️ No hay órdenes pendientes.");

    // 2. Limpieza nivel Dios (Sugerencia de tu CTO)
    const clientesUnicos = [
      ...new Set(
        ordenes
          .map(o => o.cliente?.trim().toUpperCase())
          .filter(Boolean)
      )
    ];

    console.log(`👤 Se encontraron ${clientesUnicos.length} clientes únicos perfectamente limpios.`);

    // 3. Preparamos para la nueva estructura
    const datosParaInsertar = clientesUnicos.map(nombre => {
        // Le quitamos las palabras genéricas para tener un nombre "Normalizado"
        const nombreNormalizado = nombre.replace(/\b(LTDA|LIMITADA|SPA|S A|SA|S\.A\.)\b/g, '').trim();

        return {
            tenant_id: TENANT_ID,
            nombre_cliente_raw: nombre,
            nombre_cliente_normalizado: nombreNormalizado
        };
    });

    // 4. Inyectamos (onConflict debe matchear el índice único real: (tenant_id, nombre_cliente_raw))
    const { error: errInsert } = await supabase
        .from('clientes')
        .upsert(datosParaInsertar, { onConflict: 'tenant_id,nombre_cliente_raw', ignoreDuplicates: true });

    if (errInsert) {
        console.error("❌ Error guardando clientes:", errInsert.message);
    } else {
        console.log("✅ ¡Libreta de Direcciones actualizada con éxito!");
        console.log("🔜 TAREA MANUAL: Ve a Supabase y llena 3 a 5 direcciones con lat/lng.");
    }
}

sincronizarClientes();