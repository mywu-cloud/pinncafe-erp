-- =============================================================
-- Phase 2 → Phase 3 升級（既有資料庫才需要）
-- 先跑 db/schema.sql 建立 Phase 3 新表，再跑本檔。
-- Phase 3 起收付款狀態一律由沖帳（payment_allocations）決定：
-- Phase 2 依付款方式自動標「已收清」的銷貨單會改回「未收」，需到「銀行收支」登錄入帳並沖帳。
-- 本檔可重複執行。
-- =============================================================
UPDATE sales SET payment_status = CASE
  WHEN total_amount <= 0.005 THEN '已收清'
  WHEN COALESCE((SELECT SUM(a.amount) FROM payment_allocations a WHERE a.doc_type = 'sales' AND a.doc_id = sales.sale_id), 0) <= 0.005 THEN '未收'
  WHEN COALESCE((SELECT SUM(a.amount) FROM payment_allocations a WHERE a.doc_type = 'sales' AND a.doc_id = sales.sale_id), 0) + 0.005 >= total_amount THEN '已收清'
  ELSE '部分收款' END;
UPDATE purchases SET payment_status = CASE
  WHEN total_amount <= 0.005 THEN '已付清'
  WHEN COALESCE((SELECT SUM(a.amount) FROM payment_allocations a WHERE a.doc_type = 'purchases' AND a.doc_id = purchases.purchase_id), 0) <= 0.005 THEN '未付'
  WHEN COALESCE((SELECT SUM(a.amount) FROM payment_allocations a WHERE a.doc_type = 'purchases' AND a.doc_id = purchases.purchase_id), 0) + 0.005 >= total_amount THEN '已付清'
  ELSE '部分付款' END;
