-- =============================================================
-- 範例資料（Phase 1＋2，僅供開發測試）
-- 執行前請先跑 schema.sql；重跑會先清空所有資料表
-- =============================================================
DELETE FROM inventory_movements;
DELETE FROM sale_items;
DELETE FROM sales;
DELETE FROM roasted_lots;
DELETE FROM roast_batch_inputs;
DELETE FROM roast_batches;
DELETE FROM green_bean_lots;
DELETE FROM purchase_items;
DELETE FROM purchases;
DELETE FROM doc_sequences;
DELETE FROM customer_preferences;
DELETE FROM customers;
DELETE FROM products;
DELETE FROM roasted_beans;
DELETE FROM packaging_items;
DELETE FROM green_beans;
DELETE FROM suppliers;
DELETE FROM sqlite_sequence;

-- ---------- 供應商 ----------
INSERT INTO suppliers (supplier_id, name, tax_id, contact_name, phone, email, address, country, payment_terms, bank_info, note) VALUES
 (1, '生豆研究所貿易有限公司', '24567890', '林先生', '07-3301234', 'sales@greenlab.example', '高雄市三民區民族一路 100 號', '台灣', '月結 30 天', '台灣銀行 高雄分行 末四碼 1234', '主要非洲、南美生豆'),
 (2, 'Andes Coffee Importers', NULL, 'Carlos', '+57-1-555-0100', 'carlos@andes.example', 'Bogotá, Colombia', '哥倫比亞', '預付', '電匯（台幣換算後入帳）', '中南美直送'),
 (3, '南台包材行', '53219876', '陳小姐', '07-7215566', 'pack@southpack.example', '高雄市鳳山區中山路 50 號', '台灣', '現結', NULL, '夾鏈袋、標籤、濾掛袋');

-- ---------- 客戶 ----------
INSERT INTO customers (customer_id, name, customer_type, price_level, tax_id, phone, email, line_id, shipping_address, payment_terms, credit_limit, birthday, source, note) VALUES
 (1, '王小明',           '零售',   '零售價', NULL,       '0912-345-678', 'ming@example.com', 'ming_coffee', '高雄市左營區博愛二路 1 號', '現結', NULL,  '1990-05-12', '門市', NULL),
 (2, '巷口咖啡館',       '咖啡廳', '批發價', '87654321', '07-5550101',   'hello@alley.example', NULL,     '高雄市苓雅區四維三路 8 號', '月結 30 天', 50000, NULL, '朋友介紹', '每週二送貨'),
 (3, '豆好選物 電商',    '電商',   '批發價', '11223344', '02-27001234',  'buy@doohow.example', NULL,     '台北市大安區復興南路 99 號', '月結 30 天', 80000, NULL, '展覽', NULL),
 (4, '李美華',           '零售',   'VIP',    NULL,       '0933-111-222', NULL, 'meihua', '高雄市鼓山區美術東路 20 號', '現結', NULL, '1985-11-20', 'LINE', '訂閱客');

INSERT INTO customer_preferences (customer_id, roast_level, flavor_notes, grind_size, brew_method, favorite_products, dislikes, note) VALUES
 (1, '淺焙',   '花香、柑橘',   '手沖', 'V60',      '耶加雪菲 水洗', '過苦', NULL),
 (2, '中深焙', '堅果、巧克力', '義式', '義式機',   '招牌綜合',       NULL,  '奶咖用'),
 (4, '中焙',   '果酸、焦糖',   '原豆', 'Kalita',   '哥倫比亞 慧蘭',  '發酵味太重', NULL),
 (4, '淺焙',   '莓果',         '冷萃', '冷萃瓶',   NULL,             NULL,  '夏天喝冷萃');

-- ---------- 生豆品項 ----------
INSERT INTO green_beans (bean_id, name, country, region, farm, process, variety, altitude, crop_year, cupping_score, default_supplier_id, safety_stock_kg, note) VALUES
 (1, '衣索比亞 耶加雪菲 G1 水洗', '衣索比亞', '耶加雪菲', '科契爾處理廠', '水洗', '原生種', '1900-2100m', '2025/26', 87.5, 1, 20, NULL),
 (2, '巴西 喜拉朵 日曬',          '巴西',     '喜拉朵',   NULL,           '日曬', '黃波旁', '1100m',      '2025/26', 83.0, 1, 30, '綜合豆基底'),
 (3, '哥倫比亞 慧蘭 水洗',        '哥倫比亞', '慧蘭',     NULL,           '水洗', 'Caturra', '1700m',     '2025/26', 85.0, 2, 15, NULL),
 (4, '瓜地馬拉 安提瓜 水洗',      '瓜地馬拉', '安提瓜',   NULL,           '水洗', '波旁',   '1500m',      '2025/26', 84.5, 2, 15, NULL),
 (5, '肯亞 AA 水洗',              '肯亞',     '涅里',     NULL,           '水洗', 'SL28',   '1800m',      '2025/26', 88.0, 1, 10, '尚未進貨');

-- ---------- 包材 ----------
INSERT INTO packaging_items (packaging_id, name, unit, unit_cost, supplier_id, safety_stock, note) VALUES
 (1, '250g 單向閥夾鏈袋', '個', 6.0, 3, 300, NULL),
 (2, '產品標籤',           '張', 1.5, 3, 500, NULL),
 (3, '濾掛袋',             '個', 0.8, 3, 1000, NULL);

-- ---------- 熟豆品項（Phase 2）----------
INSERT INTO roasted_beans (roasted_bean_id, name, roast_level, shelf_life_days, safety_stock_kg, note) VALUES
 (1, '耶加雪菲 水洗（淺焙）', '淺焙',   60, 3, NULL),
 (2, '哥倫比亞 慧蘭（中焙）', '中焙',   60, 3, '尚未烘焙'),
 (3, '招牌綜合（中深焙）',    '中深焙', 45, 5, '巴西 6：哥倫比亞 4');

-- ---------- 產品（roasted_bean_id：使用哪個熟豆品項；250g 與 1kg 共用同一鍋熟豆）----------
INSERT INTO products (product_id, sku, name, category, roast_level, net_weight_g, retail_price, wholesale_price, shelf_life_days, roasted_bean_id) VALUES
 (1, 'SO-ETH-250', '耶加雪菲 水洗 250g', '單品豆', '淺焙',   250, 520, 420, 60, 1),
 (2, 'SO-COL-250', '哥倫比亞 慧蘭 250g', '單品豆', '中焙',   250, 450, 360, 60, 2),
 (3, 'BL-HSE-250', '招牌綜合 250g',      '綜合豆', '中深焙', 250, 380, 300, 60, 3),
 (4, 'BL-HSE-1KG', '招牌綜合 1kg（營業用）', '綜合豆', '中深焙', 1000, 1300, 1050, 45, 3),
 (5, 'DB-ETH-10',  '耶加雪菲 濾掛 10入', '濾掛',   '淺焙',   100, 300, 230, 90, 1),
 (6, 'EQ-V60-01',  'V60 濾杯 01',        '器具',   NULL,     NULL, 350, 280, NULL, NULL);

-- =============================================================
-- 進貨單（數字已依規則計算：運費＋稅額只攤給生豆，依 kg 比例）
-- =============================================================

-- P20261102-01：明細 36,000、運費 1,200、稅 1,800 → 攤提 3,000 / 120kg = 25 元/kg
INSERT INTO purchases (purchase_id, purchase_no, purchase_date, supplier_id, items_amount, shipping_fee, tax_amount, total_amount, invoice_no, payment_status, due_date, note, created_by) VALUES
 (1, 'P20261102-01', '2026-11-02', 1, 36000, 1200, 1800, 39000, 'AB12345678', '未付', '2026-12-02', NULL, 'seed');
INSERT INTO purchase_items (item_id, purchase_id, line_no, item_type, bean_id, packaging_id, qty, unit_price, amount, alloc_amount, landed_unit_cost) VALUES
 (1, 1, 1, '生豆', 1, NULL, 60, 380, 22800, 1500, 405),
 (2, 1, 2, '生豆', 2, NULL, 60, 220, 13200, 1500, 245);

-- P20261108-01：明細 21,600、運費 600、稅 1,080 → 攤提 1,680 / 60kg = 28 元/kg（包材不攤）
INSERT INTO purchases (purchase_id, purchase_no, purchase_date, supplier_id, items_amount, shipping_fee, tax_amount, total_amount, invoice_no, payment_status, due_date, note, created_by) VALUES
 (2, 'P20261108-01', '2026-11-08', 2, 21600, 600, 1080, 23280, NULL, '未付', NULL, '含夾鏈袋', 'seed');
INSERT INTO purchase_items (item_id, purchase_id, line_no, item_type, bean_id, packaging_id, qty, unit_price, amount, alloc_amount, landed_unit_cost) VALUES
 (3, 2, 1, '生豆', 3, NULL, 30, 300, 9000, 840, 328),
 (4, 2, 2, '生豆', 4, NULL, 30, 320, 9600, 840, 348),
 (5, 2, 3, '包材', NULL, 1, 500, 6, 3000, 0, 6);

-- P20261112-01：只有包材 → 無生豆可攤，運費＋稅只計入合計
INSERT INTO purchases (purchase_id, purchase_no, purchase_date, supplier_id, items_amount, shipping_fee, tax_amount, total_amount, invoice_no, payment_status, due_date, note, created_by) VALUES
 (3, 'P20261112-01', '2026-11-12', 3, 3100, 150, 155, 3405, 'CD87654321', '未付', NULL, NULL, 'seed');
INSERT INTO purchase_items (item_id, purchase_id, line_no, item_type, bean_id, packaging_id, qty, unit_price, amount, alloc_amount, landed_unit_cost) VALUES
 (6, 3, 1, '包材', NULL, 2, 1000, 1.5, 1500, 0, 1.5),
 (7, 3, 2, '包材', NULL, 3, 2000, 0.8, 1600, 0, 0.8);

-- ---------- 生豆批號 ----------
INSERT INTO green_bean_lots (lot_id, lot_no, bean_id, purchase_item_id, received_date, initial_kg, unit_cost, storage_location) VALUES
 (1, 'L20261102-01', 1, 1, '2026-11-02', 60, 405, 'A-1'),
 (2, 'L20261102-02', 2, 2, '2026-11-02', 60, 245, 'A-2'),
 (3, 'L20261108-01', 3, 3, '2026-11-08', 30, 328, 'B-1'),
 (4, 'L20261108-02', 4, 4, '2026-11-08', 30, 348, 'B-2');

-- ---------- 庫存異動 ----------
INSERT INTO inventory_movements (movement_date, item_type, item_ref_id, movement_type, qty, unit_cost, amount, ref_doc_type, ref_doc_id, ref_item_id, note, created_by) VALUES
 ('2026-11-02 00:00:00', '生豆', 1, '進貨入庫', 60,   405, 24300, 'purchases', 1, 1, 'L20261102-01', 'seed'),
 ('2026-11-02 00:00:00', '生豆', 2, '進貨入庫', 60,   245, 14700, 'purchases', 1, 2, 'L20261102-02', 'seed'),
 ('2026-11-08 00:00:00', '生豆', 3, '進貨入庫', 30,   328,  9840, 'purchases', 2, 3, 'L20261108-01', 'seed'),
 ('2026-11-08 00:00:00', '生豆', 4, '進貨入庫', 30,   348, 10440, 'purchases', 2, 4, 'L20261108-02', 'seed'),
 ('2026-11-08 00:00:00', '包材', 1, '進貨入庫', 500,  6,    3000, 'purchases', 2, 5, NULL, 'seed'),
 ('2026-11-12 00:00:00', '包材', 2, '進貨入庫', 1000, 1.5,  1500, 'purchases', 3, 6, NULL, 'seed'),
 ('2026-11-12 00:00:00', '包材', 3, '進貨入庫', 2000, 0.8,  1600, 'purchases', 3, 7, NULL, 'seed'),
 -- 示範出庫：寄樣品 0.5kg 耶加雪菲生豆（此異動使 P20261102-01 鎖定、不可修改）
 ('2026-11-10 14:00:00', '生豆', 1, '樣品',     -0.5, 405,  -202.5, NULL, NULL, NULL, '寄給巷口咖啡館試烘', 'seed');

-- =============================================================
-- Phase 2：烘焙批次、熟豆庫存、銷貨
-- =============================================================

-- R20261109-01：耶加雪菲 10kg × 405 = 4,050 → 產出 8.5kg，失重 15%，熟豆 476.4706 元/kg
-- R20261110-01：巴西 12kg × 245 + 哥倫比亞 8kg × 328 = 5,564 → 產出 16.8kg，失重 16%，熟豆 331.1905 元/kg
INSERT INTO roast_batches (batch_id, batch_no, roast_date, roasted_bean_id, input_total_kg, output_kg, loss_rate, input_total_cost, unit_cost, note, created_by) VALUES
 (1, 'R20261109-01', '2026-11-09', 1, 10, 8.5,  0.15, 4050, 476.4706, NULL, 'seed'),
 (2, 'R20261110-01', '2026-11-10', 3, 20, 16.8, 0.16, 5564, 331.1905, NULL, 'seed');
INSERT INTO roast_batch_inputs (input_id, batch_id, line_no, lot_id, input_kg, unit_cost, amount) VALUES
 (1, 1, 1, 1, 10, 405, 4050),
 (2, 2, 1, 2, 12, 245, 2940),
 (3, 2, 2, 3, 8,  328, 2624);
INSERT INTO roasted_lots (roasted_lot_id, batch_id, roasted_bean_id, roast_date, best_before, initial_kg, unit_cost) VALUES
 (1, 1, 1, '2026-11-09', '2027-01-08', 8.5,  476.4706),
 (2, 2, 3, '2026-11-10', '2026-12-25', 16.8, 331.1905);

-- S20261111-01：王小明 門市現金，耶加雪菲 250g × 2 → 扣熟豆 0.5kg
-- S20261113-01：巷口咖啡館 批發月結，招牌綜合 1kg × 5 ＋ 250g × 4 → 扣熟豆 6kg
INSERT INTO sales (sale_id, sale_no, sale_date, customer_id, channel, subtotal, discount, shipping_fee, total_amount, cost_amount, payment_method, payment_status, due_date, note, created_by) VALUES
 (1, 'S20261111-01', '2026-11-11', 1, '門市', 1040, 0, 0, 1040, 238.24,  '現金', '已收清', NULL, NULL, 'seed'),
 (2, 'S20261113-01', '2026-11-13', 2, '批發', 6450, 0, 0, 6450, 1987.14, '月結', '未收', '2026-12-13', '週二送貨', 'seed');
INSERT INTO sale_items (item_id, sale_id, line_no, product_id, grind_size, qty, unit_price, amount, deduct_kg, unit_cost, cost_amount) VALUES
 (1, 1, 1, 1, '手沖', 2, 520,  1040, 0.5, 119.12,   238.24),
 (2, 2, 1, 4, '原豆', 5, 1050, 5250, 5,   331.19,   1655.95),
 (3, 2, 2, 3, '原豆', 4, 300,  1200, 1,   82.7975,  331.19);

INSERT INTO inventory_movements (movement_date, item_type, item_ref_id, movement_type, qty, unit_cost, amount, ref_doc_type, ref_doc_id, ref_item_id, note, created_by) VALUES
 ('2026-11-09 00:00:00', '生豆', 1, '烘焙投入', -10,  405,      -4050,    'roast_batches', 1, 1, 'R20261109-01', 'seed'),
 ('2026-11-09 00:00:00', '熟豆', 1, '烘焙產出', 8.5,  476.4706, 4050,     'roast_batches', 1, NULL, 'R20261109-01', 'seed'),
 ('2026-11-10 00:00:00', '生豆', 2, '烘焙投入', -12,  245,      -2940,    'roast_batches', 2, 2, 'R20261110-01', 'seed'),
 ('2026-11-10 00:00:00', '生豆', 3, '烘焙投入', -8,   328,      -2624,    'roast_batches', 2, 3, 'R20261110-01', 'seed'),
 ('2026-11-10 00:00:00', '熟豆', 2, '烘焙產出', 16.8, 331.1905, 5564,     'roast_batches', 2, NULL, 'R20261110-01', 'seed'),
 ('2026-11-11 00:00:00', '熟豆', 1, '銷貨出庫', -0.5, 476.4706, -238.24,  'sales', 1, 1, 'S20261111-01', 'seed'),
 ('2026-11-13 00:00:00', '熟豆', 2, '銷貨出庫', -5,   331.1905, -1655.95, 'sales', 2, 2, 'S20261113-01', 'seed'),
 ('2026-11-13 00:00:00', '熟豆', 2, '銷貨出庫', -1,   331.1905, -331.19,  'sales', 2, 3, 'S20261113-01', 'seed');

-- ---------- 流水號 ----------
INSERT INTO doc_sequences (prefix, ymd, last_no) VALUES
 ('P', '20261102', 1), ('P', '20261108', 1), ('P', '20261112', 1),
 ('L', '20261102', 2), ('L', '20261108', 2),
 ('R', '20261109', 1), ('R', '20261110', 1),
 ('S', '20261111', 1), ('S', '20261113', 1);
