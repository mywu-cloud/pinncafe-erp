// 庫存查詢 — 一律由 inventory_movements 加總，不讀任何「現有量」欄位
//   期初 = 起日之前的異動加總
//   本期入庫 / 出庫 = 起日～迄日內的正 / 負異動
//   期末 = 期初 + 入庫 − 出庫（= 迄日當天結束時的庫存）
// 未給起日 → 期初為 0（從最早紀錄算起）；未給迄日 → 算到目前為止。

import { HttpError, json, toInt, dateRange, round, todayTW } from '../lib/http.js';

/** 迄日的隔天（movement_date < 此值）；days 可指定往後幾天 */
function dayAfter(d, days = 1) {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/** 產生期初／入／出／期末的 SUM 欄位與綁定值 */
function periodCols(from) {
  // from 為 null 時用 '0000'：所有異動都算本期
  const f = from || '0000-00-00';
  return {
    sql: `
      COALESCE(SUM(CASE WHEN m.movement_date <  ? THEN m.qty    END), 0) AS opening_qty,
      COALESCE(SUM(CASE WHEN m.movement_date <  ? THEN m.amount END), 0) AS opening_amount,
      COALESCE(SUM(CASE WHEN m.movement_date >= ? AND m.qty > 0 THEN m.qty    END), 0) AS in_qty,
      COALESCE(SUM(CASE WHEN m.movement_date >= ? AND m.qty > 0 THEN m.amount END), 0) AS in_amount,
      COALESCE(SUM(CASE WHEN m.movement_date >= ? AND m.qty < 0 THEN -m.qty    END), 0) AS out_qty,
      COALESCE(SUM(CASE WHEN m.movement_date >= ? AND m.qty < 0 THEN -m.amount END), 0) AS out_amount,
      COALESCE(SUM(m.qty), 0)    AS closing_qty,
      COALESCE(SUM(m.amount), 0) AS closing_amount`,
    binds: [f, f, f, f, f, f],
  };
}

const QTY_KEYS = ['opening_qty', 'in_qty', 'out_qty', 'closing_qty'];
const AMT_KEYS = ['opening_amount', 'in_amount', 'out_amount', 'closing_amount'];
function tidy(row) {
  for (const k of QTY_KEYS) row[k] = round(row[k], 3);
  for (const k of AMT_KEYS) row[k] = round(row[k], 2);
  return row;
}

// ------------------------------------------------------------------
// GET /api/inventory/green-beans?from=&to=&bean_id=&show_empty=1
// 品項彙總，每個品項下展開批號
// ------------------------------------------------------------------
async function greenBeans(db, url) {
  const { from, to } = dateRange(url);
  const beanId = url.searchParams.get('bean_id');
  const showEmpty = url.searchParams.get('show_empty') === '1';
  const pc = periodCols(from);
  const upper = to ? dayAfter(to) : '9999-12-31';

  const { results: lots } = await db.prepare(
    `SELECT l.lot_id, l.lot_no, l.bean_id, l.received_date, l.initial_kg, l.unit_cost, l.storage_location,
            pu.purchase_id, pu.purchase_no, s.name AS supplier_name, ${pc.sql}
     FROM green_bean_lots l
     LEFT JOIN purchase_items pi ON pi.item_id = l.purchase_item_id
     LEFT JOIN purchases pu ON pu.purchase_id = pi.purchase_id
     LEFT JOIN suppliers s ON s.supplier_id = pu.supplier_id
     LEFT JOIN inventory_movements m
            ON m.item_type = '生豆' AND m.item_ref_id = l.lot_id AND m.movement_date < ?
     ${beanId ? 'WHERE l.bean_id = ?' : ''}
     GROUP BY l.lot_id
     ORDER BY l.received_date, l.lot_id`,
  ).bind(...pc.binds, upper, ...(beanId ? [toInt(beanId, '生豆品項')] : [])).all();

  const { results: beans } = await db.prepare(
    `SELECT bean_id, name, country, process, safety_stock_kg, is_active FROM green_beans
     ${beanId ? 'WHERE bean_id = ?' : ''} ORDER BY is_active DESC, bean_id`,
  ).bind(...(beanId ? [Number(beanId)] : [])).all();

  const zero = () => Object.fromEntries([...QTY_KEYS, ...AMT_KEYS].map((k) => [k, 0]));
  const byBean = new Map(beans.map((b) => [b.bean_id, { ...b, ...zero(), lots: [] }]));
  for (const lot of lots) {
    tidy(lot);
    // 區間內完全沒有數量的批號（期初 0、無進出）不列出
    const touched = lot.opening_qty || lot.in_qty || lot.out_qty || lot.closing_qty;
    if (!touched) continue;
    const b = byBean.get(lot.bean_id);
    if (!b) continue;
    lot.status = lot.closing_qty > 0.0005 ? '使用中' : '已用完';
    b.lots.push(lot);
    for (const k of [...QTY_KEYS, ...AMT_KEYS]) b[k] += lot[k];
  }

  const total = zero();
  const data = [];
  for (const b of byBean.values()) {
    tidy(b);
    b.avg_cost = b.closing_qty > 0 ? round(b.closing_amount / b.closing_qty, 2) : null;
    b.low_stock = b.is_active === 1 && b.safety_stock_kg > 0 && b.closing_qty < b.safety_stock_kg;
    if (!showEmpty && b.lots.length === 0 && !b.low_stock) continue;
    for (const k of [...QTY_KEYS, ...AMT_KEYS]) total[k] += b[k];
    data.push(b);
  }
  return json({ from, to, data, total: tidy(total) });
}

// ------------------------------------------------------------------
// GET /api/inventory/roasted?from=&to=&roasted_bean_id=&show_empty=1
// 熟豆品項彙總，每個品項下展開熟豆批次（= 烘焙批次）
// ------------------------------------------------------------------
async function roasted(db, url) {
  const { from, to } = dateRange(url);
  const beanId = url.searchParams.get('roasted_bean_id');
  const showEmpty = url.searchParams.get('show_empty') === '1';
  const pc = periodCols(from);
  const upper = to ? dayAfter(to) : '9999-12-31';
  const asOf = to || todayTW();
  const soon = dayAfter(asOf, 7); // 距賞味期限 ≤ 7 天 → 出清提醒

  const { results: lots } = await db.prepare(
    `SELECT rl.roasted_lot_id, rl.batch_id, rb.batch_no, rl.roasted_bean_id, rl.roast_date, rl.best_before,
            rl.initial_kg, rl.unit_cost, rb.loss_rate, ${pc.sql}
     FROM roasted_lots rl
     JOIN roast_batches rb ON rb.batch_id = rl.batch_id
     LEFT JOIN inventory_movements m
            ON m.item_type = '熟豆' AND m.item_ref_id = rl.roasted_lot_id AND m.movement_date < ?
     ${beanId ? 'WHERE rl.roasted_bean_id = ?' : ''}
     GROUP BY rl.roasted_lot_id
     ORDER BY rl.roast_date, rl.roasted_lot_id`,
  ).bind(...pc.binds, upper, ...(beanId ? [toInt(beanId, '熟豆品項')] : [])).all();

  const { results: beans } = await db.prepare(
    `SELECT roasted_bean_id, name, roast_level, safety_stock_kg, is_active FROM roasted_beans
     ${beanId ? 'WHERE roasted_bean_id = ?' : ''} ORDER BY is_active DESC, roasted_bean_id`,
  ).bind(...(beanId ? [Number(beanId)] : [])).all();

  const zero = () => Object.fromEntries([...QTY_KEYS, ...AMT_KEYS].map((k) => [k, 0]));
  const byBean = new Map(beans.map((b) => [b.roasted_bean_id, { ...b, ...zero(), lots: [], expiring_count: 0 }]));
  for (const lot of lots) {
    tidy(lot);
    const touched = lot.opening_qty || lot.in_qty || lot.out_qty || lot.closing_qty;
    if (!touched) continue;
    const b = byBean.get(lot.roasted_bean_id);
    if (!b) continue;
    lot.status = lot.closing_qty > 0.0005 ? '有庫存' : lot.closing_qty < -0.0005 ? '負庫存' : '已售完';
    lot.expired = lot.closing_qty > 0.0005 && !!lot.best_before && lot.best_before < asOf;
    lot.expiring = lot.closing_qty > 0.0005 && !!lot.best_before && !lot.expired && lot.best_before <= soon;
    if (lot.expired || lot.expiring) b.expiring_count += 1;
    b.lots.push(lot);
    for (const k of [...QTY_KEYS, ...AMT_KEYS]) b[k] += lot[k];
  }

  const total = zero();
  const data = [];
  for (const b of byBean.values()) {
    tidy(b);
    b.avg_cost = b.closing_qty > 0 ? round(b.closing_amount / b.closing_qty, 2) : null;
    b.low_stock = b.is_active === 1 && b.safety_stock_kg > 0 && b.closing_qty < b.safety_stock_kg;
    b.negative = b.closing_qty < -0.0005 || b.lots.some((l) => l.status === '負庫存');
    if (!showEmpty && b.lots.length === 0 && !b.low_stock) continue;
    for (const k of [...QTY_KEYS, ...AMT_KEYS]) total[k] += b[k];
    data.push(b);
  }
  return json({ from, to, as_of: asOf, data, total: tidy(total) });
}

// ------------------------------------------------------------------
// GET /api/inventory/packaging?from=&to=
// ------------------------------------------------------------------
async function packaging(db, url) {
  const { from, to } = dateRange(url);
  const pc = periodCols(from);
  const upper = to ? dayAfter(to) : '9999-12-31';
  const { results } = await db.prepare(
    `SELECT p.packaging_id, p.name, p.unit, p.safety_stock, p.is_active, ${pc.sql}
     FROM packaging_items p
     LEFT JOIN inventory_movements m
            ON m.item_type = '包材' AND m.item_ref_id = p.packaging_id AND m.movement_date < ?
     GROUP BY p.packaging_id ORDER BY p.is_active DESC, p.packaging_id`,
  ).bind(...pc.binds, upper).all();
  for (const r of results) {
    tidy(r);
    r.low_stock = r.is_active === 1 && r.safety_stock > 0 && r.closing_qty < r.safety_stock;
  }
  return json({ from, to, data: results });
}

// ------------------------------------------------------------------
// GET /api/inventory/movements?item_type=&from=&to=&bean_id=&lot_id=&roasted_bean_id=&roasted_lot_id=&packaging_id=&movement_type=
// 異動明細（流水帳）。doc_no = 來源單據編號（進貨單／烘焙批次／銷貨單）
// ------------------------------------------------------------------
async function movements(db, url) {
  const { from, to } = dateRange(url);
  const sp = url.searchParams;
  const where = [];
  const binds = [];
  const itemType = sp.get('item_type');
  if (itemType) {
    if (!['生豆', '熟豆', '包材', '成品'].includes(itemType)) throw new HttpError(400, 'item_type 錯誤');
    where.push('m.item_type = ?'); binds.push(itemType);
  }
  if (from) { where.push('m.movement_date >= ?'); binds.push(from); }
  if (to) { where.push('m.movement_date < ?'); binds.push(dayAfter(to)); }
  if (sp.get('lot_id')) { where.push("m.item_type = '生豆' AND m.item_ref_id = ?"); binds.push(toInt(sp.get('lot_id'), '批號')); }
  if (sp.get('bean_id')) { where.push("m.item_type = '生豆' AND l.bean_id = ?"); binds.push(toInt(sp.get('bean_id'), '生豆品項')); }
  if (sp.get('roasted_lot_id')) { where.push("m.item_type = '熟豆' AND m.item_ref_id = ?"); binds.push(toInt(sp.get('roasted_lot_id'), '熟豆批次')); }
  if (sp.get('roasted_bean_id')) { where.push("m.item_type = '熟豆' AND rl.roasted_bean_id = ?"); binds.push(toInt(sp.get('roasted_bean_id'), '熟豆品項')); }
  if (sp.get('packaging_id')) { where.push("m.item_type = '包材' AND m.item_ref_id = ?"); binds.push(toInt(sp.get('packaging_id'), '包材')); }
  if (sp.get('movement_type')) { where.push('m.movement_type = ?'); binds.push(sp.get('movement_type')); }

  const { results } = await db.prepare(
    `SELECT m.*, l.lot_no, b.name AS bean_name, k.name AS packaging_name, k.unit AS packaging_unit,
            rlb.batch_no AS roasted_lot_no, rn.name AS roasted_bean_name,
            pu.purchase_no, COALESCE(pu.purchase_no, dr.batch_no, ds.sale_no) AS doc_no, dc.name AS customer_name
     FROM inventory_movements m
     LEFT JOIN green_bean_lots l ON m.item_type = '生豆' AND l.lot_id = m.item_ref_id
     LEFT JOIN green_beans b ON b.bean_id = l.bean_id
     LEFT JOIN packaging_items k ON m.item_type = '包材' AND k.packaging_id = m.item_ref_id
     LEFT JOIN roasted_lots rl ON m.item_type = '熟豆' AND rl.roasted_lot_id = m.item_ref_id
     LEFT JOIN roast_batches rlb ON rlb.batch_id = rl.batch_id
     LEFT JOIN roasted_beans rn ON rn.roasted_bean_id = rl.roasted_bean_id
     LEFT JOIN purchases pu ON m.ref_doc_type = 'purchases' AND pu.purchase_id = m.ref_doc_id
     LEFT JOIN roast_batches dr ON m.ref_doc_type = 'roast_batches' AND dr.batch_id = m.ref_doc_id
     LEFT JOIN sales ds ON m.ref_doc_type = 'sales' AND ds.sale_id = m.ref_doc_id
     LEFT JOIN customers dc ON dc.customer_id = ds.customer_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY m.movement_date, (m.qty < 0), m.movement_id
     LIMIT 2000`,
  ).bind(...binds).all();
  return json({ from, to, data: results });
}

export async function handleInventory(sub, request, env) {
  if (request.method !== 'GET') throw new HttpError(405, '不支援的操作');
  const url = new URL(request.url);
  if (sub === 'green-beans') return greenBeans(env.DB, url);
  if (sub === 'roasted') return roasted(env.DB, url);
  if (sub === 'packaging') return packaging(env.DB, url);
  if (sub === 'movements') return movements(env.DB, url);
  throw new HttpError(404, '找不到此查詢');
}
