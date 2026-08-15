// src/ai.js — Motor de riesgo OTIF
// Por defecto: score determinista (sin OpenAI en el camino crítico).
// Opt-in LLM: OPENAI_ENRICH_ENABLED=true + OPENAI_API_KEY.
import { CONFIG, SLA_CACHE, cleanSLACache, AISchema } from './config.js';

function riskScoreFromLabel(riesgo) {
  switch (riesgo) {
    case 'CRÍTICO_MÁXIMO_CAMIÓN_ESPERANDO': return 95;
    case 'CRÍTICO': return 80;
    case 'MEDIO': return 50;
    case 'BAJO': return 20;
    default: return 50;
  }
}

function buildDeterministicIA(contextoMatematico, riesgoFisico, viabilidadFinanciera) {
  const fin = contextoMatematico.analisis_financiero || {};
  const ia = {
    riesgo: riesgoFisico,
    risk_score: riskScoreFromLabel(riesgoFisico),
    alerta_tactica: `Riesgo ${riesgoFisico} · etapa ${contextoMatematico.etapa_fisica || 'N/A'} · espera ${contextoMatematico.minutos_espera || 0} min`,
    accion_recomendada: viabilidadFinanciera,
    impacto_financiero:
      `Esperar~$${fin.costo_esperar_total ?? 0} vs 2do flete~$${fin.costo_hacer_segundo_viaje ?? 0}` +
      (fin.multa_total_atraso ? ` · multa proyectada~$${fin.multa_total_atraso}` : ''),
  };
  const validated = AISchema.safeParse(ia);
  return {
    matematica: contextoMatematico,
    ia: validated.success ? validated.data : ia,
  };
}

export async function evaluateOTRiskWithOpenAI(otData, env, dbClient) {
  let fallbackDecision = "Revisar costos manualmente (Error previo al motor financiero).";
  let riesgoSeguro = "MEDIO";

  try {
    const clienteName = otData.cliente || "DEFAULT";
    let reglasCliente;
    
    const cachedSLA = SLA_CACHE.get(clienteName);
    if (cachedSLA && cachedSLA.expires > Date.now()) {
      reglasCliente = cachedSLA.data;
    } else {
      const resMatrix = await dbClient.query(`
        SELECT penalidad, costo_mitigacion, horas_criticas, distancia_km, valor_orden_compra, porcentaje_multa_diaria
        FROM client_sla_matrix WHERE cliente = $1 OR cliente = 'DEFAULT' ORDER BY cliente = $1 DESC LIMIT 1
      `, [clienteName]);
      if (resMatrix.rowCount === 0) throw new Error("SLA_MATRIX_EMPTY_OR_DEFAULT_DELETED");
      reglasCliente = resMatrix.rows[0];
      cleanSLACache();
      SLA_CACHE.set(clienteName, { data: reglasCliente, expires: Date.now() + 300000 });
    }

    const base = Number(otData.produccion_estandar);
    const desviacion = base <= 0 ? null : ((otData.produccion_real - base) / base) * 100;
    
    const riesgoFisico =
      (base <= 0 && otData.produccion_real > 0) ? "CRÍTICO_MÁXIMO_CAMIÓN_ESPERANDO"
        : (otData.etapa === "CAMION_ASIGNADO" && (otData.produccion_real < base || otData.minutos_camion_esperando >= 30)) ? "CRÍTICO_MÁXIMO_CAMIÓN_ESPERANDO"
        : (["PICKING", "PACKING"].includes(otData.etapa) && otData.horas_para_sla <= 6) ? "CRÍTICO"
        : (otData.etapa === "EN_RUTA" && otData.horas_para_sla <= 2) ? "CRÍTICO"
        : (otData.etapa === "BODEGA" && otData.horas_para_sla > 8) ? "BAJO" : "MEDIO";

    riesgoSeguro = riesgoFisico;

    const distancia = Number(reglasCliente.distancia_km) || 50;
    const costoFleteBase = (1450 * distancia) * 1.19; 
    const costoSobreestadiaHora = costoFleteBase * 0.15;
    const costoSobreestadiaAcumulada = (otData.minutos_camion_esperando / 60) * costoSobreestadiaHora;
    const costoSegundoViaje = costoFleteBase; 

    const porcentajeMulta = Number(reglasCliente.porcentaje_multa_diaria) || 0;
    const multaPorAtrasoDiario = porcentajeMulta > 0 
      ? (Number(reglasCliente.valor_orden_compra) * (porcentajeMulta / 100))
      : Number(reglasCliente.penalidad); 

    const diasEstimadosAtraso = otData.horas_para_sla < 0 ? Math.ceil(Math.abs(otData.horas_para_sla) / 24) : 0;
    const multaTotalAtraso = multaPorAtrasoDiario * diasEstimadosAtraso;
    const costoEsperarTotal = costoSobreestadiaAcumulada + multaTotalAtraso;

    const ahorroEstimado = Math.max(0, Math.abs(costoSegundoViaje - costoEsperarTotal));

    const viabilidadFinanciera = otData.etapa === "EN_RUTA"
      ? "MONITOREO_ACTIVO (El camión ya está en tránsito. Contactar cliente para gestionar recepción)."
      : costoEsperarTotal < costoSegundoViaje
        ? "RETENER_CAMION_Y_COMPLETAR (Costo de esperar + multa contractual es menor al 2do flete)."
        : "DESPACHAR_PARCIAL (La sobreestadía + multa superó el valor de un flete nuevo. Cortar carga).";
    
    fallbackDecision = viabilidadFinanciera;

    const contextoMatematicoCompleto = {
      ...otData, etapa_fisica: otData.etapa, minutos_espera: otData.minutos_camion_esperando, 
      riesgo_operativo_calculado: riesgoFisico, desviacion_porcentual: desviacion !== null ? Math.round(desviacion * 100) / 100 : 'N/A',
      analisis_financiero: {
        costo_flete_base: Math.round(costoFleteBase), costo_sobreestadia_acumulada: Math.round(costoSobreestadiaAcumulada),
        dias_estimados_atraso: diasEstimadosAtraso, multa_total_atraso: Math.round(multaTotalAtraso),
        costo_esperar_total: Math.round(costoEsperarTotal), costo_hacer_segundo_viaje: Math.round(costoSegundoViaje),
        ahorro_telemetria: Math.round(ahorroEstimado), decision_gerencial: viabilidadFinanciera
      }
    };

    const contextoIAReducido = {
      etapa: otData.etapa,
      riesgo_calculado: riesgoFisico,
      desviacion: contextoMatematicoCompleto.desviacion_porcentual,
      costo_esperar: contextoMatematicoCompleto.analisis_financiero.costo_esperar_total,
      costo_flete_nuevo: contextoMatematicoCompleto.analisis_financiero.costo_hacer_segundo_viaje,
      decision_sugerida: viabilidadFinanciera
    };

    // Camino crítico: sin OpenAI (opt-in explícito)
    const openaiOn = String(env?.OPENAI_ENRICH_ENABLED || '').toLowerCase() === 'true';
    if (!openaiOn || !env?.OPENAI_API_KEY) {
      return buildDeterministicIA(contextoMatematicoCompleto, riesgoFisico, viabilidadFinanciera);
    }

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(CONFIG.AI_TIMEOUT_MS),
        body: JSON.stringify({
          model: "gpt-4o-mini", response_format: { type: "json_object" },
          messages: [
            { role: "system", content: `Eres OTIF Sentinel. Devuelve SOLO JSON: {"riesgo": "BAJO", "MEDIO", "CRÍTICO" o "CRÍTICO_MÁXIMO_CAMIÓN_ESPERANDO", "risk_score": número 0 a 100, "alerta_tactica": "1 línea", "accion_recomendada": "Instrucción gerencial", "impacto_financiero": "Justifica usando costos"}.` },
            { role: "user", content: JSON.stringify(contextoIAReducido) }
          ]
        })
      });

      if (!res.ok) throw new Error(`OPENAI_HTTP_${res.status}`);
      const json = await res.json();
      let content = json?.choices?.[0]?.message?.content;

      if (Array.isArray(content)) {
        content = content.map(x => x.text ?? x.content ?? '').join('');
      }
      if (!content) throw new Error("EMPTY_OPENAI_RESPONSE");

      let parsed;
      try { parsed = JSON.parse(content.trim()); }
      catch {
        parsed = {
          riesgo: riesgoSeguro,
          risk_score: 50,
          alerta_tactica: "Formato IA inválido.",
          accion_recomendada: viabilidadFinanciera,
          impacto_financiero: `Fallback aplicado: ${fallbackDecision}`,
        };
      }

      const validated = AISchema.safeParse(parsed);
      if (!validated.success) throw new Error("AI_SCHEMA_INVALID");

      return { matematica: contextoMatematicoCompleto, ia: validated.data };
    } catch (llmErr) {
      console.warn("[EVAL_LLM_FALLBACK]", llmErr.message);
      return buildDeterministicIA(contextoMatematicoCompleto, riesgoFisico, viabilidadFinanciera);
    }
  } catch (e) {
    console.error("[EVAL_FAIL]", e.message);
    throw e;
  }
}
