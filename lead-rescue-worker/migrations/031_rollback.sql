-- 031_rollback.sql
-- Deshace 031_erp_pp.sql. OJO: borra las recetas y órdenes de producción.
-- Antes de correrlo, cierre (TECO) las órdenes liberadas: el stock que tengan
-- apartado se devuelve acá a libre utilización para no perderlo.

BEGIN;

UPDATE public.inventario_bodega
   SET qty_disponible = qty_disponible + qty_reservada_produccion,
       qty_reservada_produccion = 0
 WHERE qty_reservada_produccion > 0;

DROP TABLE IF EXISTS public.erp_ordenes_componentes;
DROP TABLE IF EXISTS public.erp_ordenes_produccion;
DROP TABLE IF EXISTS public.erp_listas_materiales_pos;
DROP TABLE IF EXISTS public.erp_listas_materiales;

DROP INDEX IF EXISTS public.idx_erp_doc_material_pos_orden;
ALTER TABLE public.erp_documentos_material_pos
  DROP COLUMN IF EXISTS aufnr,
  DROP COLUMN IF EXISTS rspos;

ALTER TABLE public.inventario_bodega
  DROP CONSTRAINT IF EXISTS inventario_bodega_qty_prod_chk,
  DROP COLUMN IF EXISTS qty_reservada_produccion;

COMMIT;
