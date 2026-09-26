-- 030: fuera todo lo de Telegram (canal de la versión original del rutero).
-- Hoy el chat app↔Torre va por bitacora_viajes y ningún código usa Telegram.
--
-- Quita:
--   1. Cron pg_cron `revision_minutal_leads` (corría cada minuto y fallaba:
--      buscaba columnas de transaction_logs que ya no existen).
--   2. Función auditoria_automatica_leads(): tenía el token del bot escrito
--      adentro. Revocar/borrar el bot en BotFather igual (el token pudo verse).
--   3. Columnas telegram_* de choferes, transaction_logs y tenant_settings.
--   4. Circuit breaker de Telegram (tg_breaker*) en system_flags.
-- Idempotente.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'revision_minutal_leads') THEN
    PERFORM cron.unschedule('revision_minutal_leads');
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.auditoria_automatica_leads();

ALTER TABLE public.choferes DROP COLUMN IF EXISTS telegram_chat_id;
ALTER TABLE public.transaction_logs DROP COLUMN IF EXISTS telegram_message_id;
ALTER TABLE public.tenant_settings DROP COLUMN IF EXISTS telegram_ops_chat_id;

DELETE FROM public.system_flags WHERE key LIKE 'tg\_breaker%';
