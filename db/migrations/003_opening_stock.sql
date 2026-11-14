-- =============================================================
-- 期初庫存升級（既有資料庫才需要；全新安裝直接跑 schema.sql）
-- inventory_movements 的 movement_type 新增「期初」。SQLite 不能直接改 CHECK，
-- 所以重建資料表並搬移資料（資料不變）。跑完本檔後再跑一次 db/schema.sql 重建 view。
-- 注意：本檔只能跑一次。
-- =============================================================
DROP VIEW IF EXISTS v_green_bean_lot_stock;
DROP VIEW IF EXISTS v_packaging_stock;
DROP VIEW IF EXISTS v_roasted_lot_stock;

CREATE TABLE inventory_movements_new (
  movement_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  movement_date TEXT    NOT NULL,
  item_type     TEXT    NOT NULL CHECK (item_type IN ('生豆','熟豆','包材','成品')),
  item_ref_id   INTEGER NOT NULL,
  movement_type TEXT    NOT NULL CHECK (movement_type IN (
                  '期初','進貨入庫','烘焙投入','烘焙產出','包裝耗用','銷貨出庫','退貨',
                  '盤盈','盤虧','試喝','樣品','報廢')),
  qty           REAL    NOT NULL CHECK (qty <> 0),
  unit_cost     REAL    NOT NULL DEFAULT 0,
  amount        REAL    NOT NULL DEFAULT 0,
  ref_doc_type  TEXT,                                 -- 'purchases'／'roast_batches'／'sales'／'opening'（期初庫存）
  ref_doc_id    INTEGER,
  ref_item_id   INTEGER,                              -- 來源明細（purchase_items.item_id …）
  note          TEXT,
  created_by    TEXT,                                 -- Cloudflare Access email（users 表於 Phase 5）
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
);
INSERT INTO inventory_movements_new
  (movement_id, movement_date, item_type, item_ref_id, movement_type, qty, unit_cost, amount, ref_doc_type, ref_doc_id, ref_item_id, note, created_by, created_at)
SELECT movement_id, movement_date, item_type, item_ref_id, movement_type, qty, unit_cost, amount, ref_doc_type, ref_doc_id, ref_item_id, note, created_by, created_at
FROM inventory_movements;

DROP TABLE inventory_movements;
ALTER TABLE inventory_movements_new RENAME TO inventory_movements;

CREATE INDEX IF NOT EXISTS idx_mv_date ON inventory_movements(movement_date);
CREATE INDEX IF NOT EXISTS idx_mv_item ON inventory_movements(item_type, item_ref_id, movement_date);
CREATE INDEX IF NOT EXISTS idx_mv_ref  ON inventory_movements(ref_doc_type, ref_doc_id);
