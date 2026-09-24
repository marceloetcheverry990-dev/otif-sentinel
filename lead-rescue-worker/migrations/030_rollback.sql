-- Rollback 030: recrea las columnas vacías (los valores no se recuperan).
-- La función y el cron no se recrean: tenían el token del bot adentro y fallaban.
ALTER TABLE public.choferes ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT UNIQUE;
ALTER TABLE public.transaction_logs ADD COLUMN IF NOT EXISTS telegram_message_id TEXT;
ALTER TABLE public.tenant_settings ADD COLUMN IF NOT EXISTS telegram_ops_chat_id VARCHAR(64);
