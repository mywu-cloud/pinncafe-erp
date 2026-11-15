-- =============================================================
-- Phase 3 → Phase 4 升級（既有資料庫才需要；全新安裝直接跑 schema.sql）
-- 只新增欄位，不動現有資料。跑完本檔後再跑一次 db/schema.sql 建立 Phase 4 新表。
-- 注意：本檔只能跑一次（重跑會出現 duplicate column name，可忽略）。
-- =============================================================
ALTER TABLE sale_items ADD COLUMN packaging_cost REAL NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN subscription_id INTEGER REFERENCES subscriptions(subscription_id);
