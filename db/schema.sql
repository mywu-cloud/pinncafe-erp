-- =============================================================
-- 咖啡烘豆進銷存系統 — Phase 1 Schema（Cloudflare D1 / SQLite）
-- 範圍：主檔（供應商、客戶＋喜好、生豆品項、包材、產品）
--       進貨（表頭＋明細）、生豆批號、庫存異動
-- 規格：ARCHITECTURE.md
--
-- 慣例
--   * 日期 date      → TEXT 'YYYY-MM-DD'
--   * 日期時間 datetime → TEXT 'YYYY-MM-DD HH:MM:SS'（UTC+8 台灣時間）
--   * 金額 / 重量 decimal → REAL（新台幣，進貨一律以台幣輸入）
--   * 布林 bool → INTEGER 0/1
--   * enum → TEXT + CHECK（直接存中文值，與規格一致）
--   * 現有庫存不存欄位，一律由 inventory_movements 加總（見下方 VIEW）
-- =============================================================

PRAGMA foreign_keys = ON;

-- -------------------------------------------------------------
-- 2.1 供應商
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppliers (
  supplier_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  tax_id         TEXT,
  contact_name   TEXT,
  phone          TEXT,
  email          TEXT,
  address        TEXT,
  country        TEXT,
  payment_terms  TEXT,
  bank_info      TEXT,
  note           TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at     TEXT    NOT NULL DEFAULT (datetime('now','+8 hours')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(name);

-- -------------------------------------------------------------
-- 2.2 客戶
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  customer_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  customer_type    TEXT    NOT NULL DEFAULT '零售'
                   CHECK (customer_type IN ('零售','批發','咖啡廳','電商')),
  price_level      TEXT    NOT NULL DEFAULT '零售價'
                   CHECK (price_level IN ('零售價','批發價','VIP')),
  tax_id           TEXT,
  phone            TEXT,
  email            TEXT,
  line_id          TEXT,
  shipping_address TEXT,
  payment_terms    TEXT,
  credit_limit     REAL,
  birthday         TEXT,
  source           TEXT,
  note             TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at       TEXT    NOT NULL DEFAULT (datetime('now','+8 hours')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX IF NOT EXISTS idx_customers_name  ON customers(name);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

-- -------------------------------------------------------------
-- 2.3 客戶喜好（客戶子表，一個客戶可有多筆）
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_preferences (
  pref_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id       INTEGER NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  roast_level       TEXT CHECK (roast_level IS NULL OR roast_level IN ('淺焙','中焙','中深焙','深焙')),
  flavor_notes      TEXT,
  grind_size        TEXT CHECK (grind_size IS NULL OR grind_size IN ('原豆','手沖','義式','法壓','冷萃')),
  brew_method       TEXT,
  favorite_products TEXT,
  dislikes          TEXT,
  note              TEXT,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX IF NOT EXISTS idx_customer_prefs_customer ON customer_preferences(customer_id);

-- -------------------------------------------------------------
-- 2.4 生豆品項
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS green_beans (
  bean_id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT    NOT NULL,
  country             TEXT,
  region              TEXT,
  farm                TEXT,
  process             TEXT CHECK (process IS NULL OR process IN ('水洗','日曬','蜜處理','厭氧','其他')),
  variety             TEXT,
  altitude            TEXT,
  crop_year           TEXT,
  cupping_score       REAL,
  default_supplier_id INTEGER REFERENCES suppliers(supplier_id),
  safety_stock_kg     REAL    NOT NULL DEFAULT 0,
  note                TEXT,
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at          TEXT    NOT NULL DEFAULT (datetime('now','+8 hours')),
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX IF NOT EXISTS idx_green_beans_name ON green_beans(name);

-- -------------------------------------------------------------
-- 2.7 包材（原 Phase 4，提前至 Phase 1：進貨單可進包材）
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS packaging_items (
  packaging_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  unit          TEXT    NOT NULL DEFAULT '個',
  unit_cost     REAL,
  supplier_id   INTEGER REFERENCES suppliers(supplier_id),
  safety_stock  INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','+8 hours')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
);

-- -------------------------------------------------------------
-- 2.5 產品
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  product_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  sku             TEXT UNIQUE,
  name            TEXT    NOT NULL,
  category        TEXT    NOT NULL DEFAULT '單品豆'
                  CHECK (category IN ('單品豆','綜合豆','濾掛','禮盒','器具','其他')),
  roast_level     TEXT CHECK (roast_level IS NULL OR roast_level IN ('淺焙','中焙','中深焙','深焙')),
  net_weight_g    INTEGER,
  retail_price    REAL,
  wholesale_price REAL,
  shelf_life_days INTEGER,
  note            TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now','+8 hours')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
);

-- -------------------------------------------------------------
-- 3.1 進貨（表頭）
--   purchase_no：進貨單號，自動產生 P{YYYYMMDD}-{NN}，存檔前可修改
--   total_amount = Σ明細小計 + shipping_fee + tax_amount
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchases (
  purchase_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_no    TEXT    NOT NULL UNIQUE,
  purchase_date  TEXT    NOT NULL,
  supplier_id    INTEGER NOT NULL REFERENCES suppliers(supplier_id),
  items_amount   REAL    NOT NULL DEFAULT 0,          -- auto 明細小計合計
  shipping_fee   REAL    NOT NULL DEFAULT 0,
  tax_amount     REAL    NOT NULL DEFAULT 0,
  total_amount   REAL    NOT NULL DEFAULT 0,          -- auto
  invoice_no     TEXT,
  payment_status TEXT    NOT NULL DEFAULT '未付'
                 CHECK (payment_status IN ('未付','部分付款','已付清')),
  due_date       TEXT,
  note           TEXT,
  created_by     TEXT,                                -- Cloudflare Access email
  created_at     TEXT    NOT NULL DEFAULT (datetime('now','+8 hours')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX IF NOT EXISTS idx_purchases_date     ON purchases(purchase_date);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier_id);

-- -------------------------------------------------------------
-- 3.2 進貨明細
--   item_type：生豆 → bean_id 必填、qty 單位 kg，存檔時建立 green_bean_lots
--              包材 → packaging_id 必填、qty 單位依包材主檔
--   alloc_amount：攤入的運費＋稅額（只攤給生豆，依 kg 比例）
--   landed_unit_cost = (amount + alloc_amount) / qty
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_items (
  item_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id      INTEGER NOT NULL REFERENCES purchases(purchase_id) ON DELETE CASCADE,
  line_no          INTEGER NOT NULL DEFAULT 1,
  item_type        TEXT    NOT NULL CHECK (item_type IN ('生豆','包材')),
  bean_id          INTEGER REFERENCES green_beans(bean_id),
  packaging_id     INTEGER REFERENCES packaging_items(packaging_id),
  qty              REAL    NOT NULL CHECK (qty > 0),
  unit_price       REAL    NOT NULL CHECK (unit_price >= 0),
  amount           REAL    NOT NULL,                  -- auto qty × unit_price
  alloc_amount     REAL    NOT NULL DEFAULT 0,        -- auto
  landed_unit_cost REAL    NOT NULL,                  -- auto
  note             TEXT,
  CHECK ( (item_type = '生豆' AND bean_id IS NOT NULL AND packaging_id IS NULL)
       OR (item_type = '包材' AND packaging_id IS NOT NULL AND bean_id IS NULL) )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_items_line ON purchase_items(purchase_id, line_no);
CREATE INDEX IF NOT EXISTS idx_purchase_items_bean     ON purchase_items(bean_id);

-- -------------------------------------------------------------
-- 4.1 生豆批號
--   lot_no：自動產生 L{YYYYMMDD}-{NN}，存檔前可修改
--   current_kg / status 不存欄位 → 見 v_green_bean_lot_stock
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS green_bean_lots (
  lot_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  lot_no           TEXT    NOT NULL UNIQUE,
  bean_id          INTEGER NOT NULL REFERENCES green_beans(bean_id),
  purchase_item_id INTEGER UNIQUE REFERENCES purchase_items(item_id) ON DELETE CASCADE,
  received_date    TEXT    NOT NULL,
  initial_kg       REAL    NOT NULL CHECK (initial_kg > 0),
  unit_cost        REAL    NOT NULL,                  -- 每 kg 成本（含攤提運費＋稅）
  storage_location TEXT,
  note             TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX IF NOT EXISTS idx_lots_bean ON green_bean_lots(bean_id);
CREATE INDEX IF NOT EXISTS idx_lots_date ON green_bean_lots(received_date);

-- -------------------------------------------------------------
-- 4.5 庫存異動（核心表）
--   qty：正數 = 入庫、負數 = 出庫
--   item_ref_id：生豆 → lot_id、熟豆 → roasted_lot_id、包材 → packaging_id、成品 → product_id
--   amount = qty × unit_cost（帶正負號，方便加總庫存金額）
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_movements (
  movement_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  movement_date TEXT    NOT NULL,
  item_type     TEXT    NOT NULL CHECK (item_type IN ('生豆','熟豆','包材','成品')),
  item_ref_id   INTEGER NOT NULL,
  movement_type TEXT    NOT NULL CHECK (movement_type IN (
                  '進貨入庫','烘焙投入','烘焙產出','包裝耗用','銷貨出庫','退貨',
                  '盤盈','盤虧','試喝','樣品','報廢')),
  qty           REAL    NOT NULL CHECK (qty <> 0),
  unit_cost     REAL    NOT NULL DEFAULT 0,
  amount        REAL    NOT NULL DEFAULT 0,
  ref_doc_type  TEXT,                                 -- 'purchases' …
  ref_doc_id    INTEGER,
  ref_item_id   INTEGER,                              -- 來源明細（purchase_items.item_id …）
  note          TEXT,
  created_by    TEXT,                                 -- Cloudflare Access email（users 表於 Phase 5）
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX IF NOT EXISTS idx_mv_date ON inventory_movements(movement_date);
CREATE INDEX IF NOT EXISTS idx_mv_item ON inventory_movements(item_type, item_ref_id, movement_date);
CREATE INDEX IF NOT EXISTS idx_mv_ref  ON inventory_movements(ref_doc_type, ref_doc_id);

-- -------------------------------------------------------------
-- 單號流水號
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doc_sequences (
  prefix  TEXT NOT NULL,     -- 'P' 進貨單、'L' 生豆批號
  ymd     TEXT NOT NULL,     -- 'YYYYMMDD'
  last_no INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (prefix, ymd)
);

-- =============================================================
-- VIEWS
-- =============================================================

-- 生豆批號現有庫存（全期間）
DROP VIEW IF EXISTS v_green_bean_lot_stock;
CREATE VIEW v_green_bean_lot_stock AS
SELECT
  l.lot_id, l.lot_no, l.bean_id, b.name AS bean_name,
  l.received_date, l.initial_kg, l.unit_cost, l.storage_location,
  ROUND(COALESCE(SUM(m.qty), 0), 3)    AS current_kg,
  ROUND(COALESCE(SUM(m.amount), 0), 2) AS current_amount,
  CASE WHEN COALESCE(SUM(m.qty), 0) > 0.0005 THEN '使用中' ELSE '已用完' END AS status,
  -- 除了進貨入庫之外是否已有其他異動（有 → 進貨單鎖定不可改）
  SUM(CASE WHEN m.movement_type <> '進貨入庫' THEN 1 ELSE 0 END) AS other_movement_count
FROM green_bean_lots l
JOIN green_beans b ON b.bean_id = l.bean_id
LEFT JOIN inventory_movements m
       ON m.item_type = '生豆' AND m.item_ref_id = l.lot_id
GROUP BY l.lot_id;

-- 包材現有庫存
DROP VIEW IF EXISTS v_packaging_stock;
CREATE VIEW v_packaging_stock AS
SELECT
  p.packaging_id, p.name, p.unit, p.safety_stock,
  ROUND(COALESCE(SUM(m.qty), 0), 3)    AS current_qty,
  ROUND(COALESCE(SUM(m.amount), 0), 2) AS current_amount
FROM packaging_items p
LEFT JOIN inventory_movements m
       ON m.item_type = '包材' AND m.item_ref_id = p.packaging_id
GROUP BY p.packaging_id;
