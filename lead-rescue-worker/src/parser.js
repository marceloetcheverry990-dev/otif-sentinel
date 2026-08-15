require('dotenv').config({ path: '.dev.vars' });
const fs = require('fs');
const csv = require('csv-parser');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const NOMBRE_ARCHIVO = 'reporte.csv';
const LOTE_IMPORTACION = crypto.randomUUID();

const guiasExitosas = [];
const guiasConError = [];

console.log(`🚀 OTIF Sentinel Import V5 - Iniciando...`);
console.log(`📦 Lote de seguridad: ${LOTE_IMPORTACION}`);

function extraerAnio(fechaStr) {
    if (!fechaStr) return new Date().getFullYear();
    if (fechaStr.includes('/')) {
        const partes = fechaStr.split(/[\s/]/);
        if (partes.length >= 3 && partes[2].length === 4) return partes[2];
    }
    const d = new Date(fechaStr);
    return isNaN(d) ? new Date().getFullYear() : d.getFullYear();
}

function limpiarMonto(montoStr) {
    if (!montoStr) return 0;
    const limpio = String(montoStr).replace(/\./g, '').replace(/,/g, '.');
    const numero = Number(limpio);
    return isNaN(numero) ? 0 : numero;
}

let lineasLeidas = 0;

fs.createReadStream(NOMBRE_ARCHIVO)
  .pipe(csv({ 
      separator: ';', // <-- Aquí forzamos el punto y coma de tu Excel
      mapHeaders: ({ header }) => header.trim().toLowerCase() // <-- Limpia la basura oculta de Excel
  }))
  .on('data', (fila) => {
    lineasLeidas++;

    try {
        const tipoDTE = fila.tipo || fila['tipo_documento'] || '';
        const tipoLimpio = parseInt(tipoDTE, 10);

        if (tipoLimpio === 52) { // 52 = Guía de Despacho
            const folioRaw = fila.folio || '';
            const folioLimpio = parseInt(folioRaw, 10);
            
            if (isNaN(folioLimpio)) throw new Error("Folio inválido o vacío");

            const fechaEmision = fila.emision || fila.publicacion || new Date().toISOString();
            const year = extraerAnio(fechaEmision);

            const clienteRaw = fila['razon_social_receptor'] || fila.receptor || 'CLIENTE DESCONOCIDO';
            const montoRaw = fila['monto_total'] || fila['monto_neto'] || fila.total || '0';
            const linkDTE = fila.uri || fila.link || '';

            const otLimpia = {
                ot_id: `OT-${year}-${folioLimpio}`,
                cliente: clienteRaw.trim(),
                valor_oc_clp: limpiarMonto(montoRaw),
                link_factura: linkDTE.trim(),
                estado_operacional: 'PENDIENTE_RUTEO',
                fecha_documento: fechaEmision,
                origen_archivo: NOMBRE_ARCHIVO,
                lote_importacion: LOTE_IMPORTACION
            };

            guiasExitosas.push(otLimpia);
        }
    } catch (error) {
        guiasConError.push({
            fila_original: fila, 
            motivo_error: error.message,
            origen_archivo: NOMBRE_ARCHIVO,
            lote_importacion: LOTE_IMPORTACION
        });
    }
  })
  .on('end', async () => {
    console.log(`\n📊 Resumen de Extracción:`);
    console.log(`   👁️ Filas leídas del Excel: ${lineasLeidas}`);
    console.log(`   ✅ Guías (52) válidas: ${guiasExitosas.length}`);
    console.log(`   ❌ Errores: ${guiasConError.length}`);
    
    if (guiasExitosas.length > 0) {
        console.log(`☁️ Subiendo Guías a Supabase...`);
        const { error } = await supabase.from('ordenes_pendientes').upsert(guiasExitosas, { onConflict: 'ot_id' });
        
        if (error) console.error("❌ Error de Supabase:", error.message);
        else console.log(`🎉 ¡Éxito! Las órdenes están en Producción esperando Ruteo.`);
    }

    if (guiasConError.length > 0) {
        const { error } = await supabase.from('ordenes_import_error').insert(guiasConError);
        if (error) console.error("❌ Error subiendo fallos:", error.message);
        else console.log(`⚠️ Se guardaron los errores en la base de datos para revisión.`);
    }
  });