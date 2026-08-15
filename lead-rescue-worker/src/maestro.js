require('dotenv').config({ path: '.dev.vars' });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function sincronizarClientes() {
    console.log("🔍 Iniciando Maestro de Clientes (V2 Enterprise)...");

    // 1. Buscamos órdenes
    const { data: ordenes, error: errOrdenes } = await supabase
        .from('ordenes_pendientes')
        .select('cliente')
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
            nombre_cliente_raw: nombre,
            nombre_cliente_normalizado: nombreNormalizado
        };
    });

    // 4. Inyectamos
    const { error: errInsert } = await supabase
        .from('clientes')
        .upsert(datosParaInsertar, { onConflict: 'nombre_cliente_raw', ignoreDuplicates: true });

    if (errInsert) {
        console.error("❌ Error guardando clientes:", errInsert.message);
    } else {
        console.log("✅ ¡Libreta de Direcciones actualizada con éxito!");
        console.log("🔜 TAREA MANUAL: Ve a Supabase y llena 3 a 5 direcciones con lat/lng.");
    }
}

sincronizarClientes();