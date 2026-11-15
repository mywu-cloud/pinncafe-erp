// 成本／毛利報表（Phase 5）
//   GET /api/reports/processing?from=&to=          加工成本：每月「攤入烘焙」費用 ÷ 當月烘焙產出 kg = 每 kg 加工成本
//   GET /api/reports/profit?from=&to=&group=        毛利分析（group：product｜customer｜channel｜month｜roasted_bean）
//   GET /api/reports/pnl?from=&to=&period=          損益概要（period：month｜quarter｜year）
//   GET /api/reports/loss?from=&to=&by=             失重率分析（by：green｜roasted）
//   GET /api/reports/trace?lot_id=｜roasted_lot_id= 批號追溯
//
// 原則（ARCHITECTURE.md 第 16 節）：
//   * 權責基礎：銷貨依銷貨日、退貨折讓依退貨日、費用依費用日
//   * 營收 = 明細金額 × (1 − 整單折扣 ÷ 小計)；運費另列
//   * 銷貨成本 = 銷貨明細成本（熟豆＋包材）− 銷貨退回回補的成本
//   * 加工成本只在報表層攤提：熟豆出貨 kg × 該熟豆批次烘焙月份的每 kg 加工成本；已存檔的成本不改
//   * 損益概要不另加加工成本（攤入烘焙的費用已在當月費用裡，避免重複）

import { HttpError, json, toInt, dateRange, round } from '../lib/http.js';

const ym = (d) => d.slice(0, 7);
function periodKey(date, period) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  if (period === 'year') return y;
  if (period === 'quarter') return `${y} Q${Math.ceil(m / 3)}`;
  return date.slice(0, 7);
}
const between = (col, from, to, binds) => {
  const w = [];
  if (from) { w.push(`${col} >= ?`); binds.push(from); }
  if (to) { w.push(`${col} <= ?`); binds.push(to); }
  return w.length ? w.join(' AND ') : '1 = 1';
};

/** 每月加工成本率（全部月份） */
async function processingRates(db) {
  const { results: exp } = await db.prepare(
    `SELECT substr(expense_date, 1, 7) AS ym, SUM(amount) AS amount, COUNT(*) AS count FROM expenses WHERE allocate_to_roast = 1 GROUP BY ym`,
  ).all();
  const { results: out } = await db.prepare(
    `SELECT substr(roast_date, 1, 7) AS ym, SUM(output_kg) AS kg, COUNT(*) AS batches FROM roast_batches GROUP BY ym`,
  ).all();
  const months = [...new Set([...exp.map((r) => r.ym), ...out.map((r) => r.ym)])].sort();
  const map = new Map();
  for (const m of months) {
    const e = exp.find((r) => r.ym === m);
    const o = out.find((r) => r.ym === m);
    const amount = round(e?.amount || 0);
    const kg = round(o?.kg || 0, 3);
    map.set(m, { ym: m, expense: amount, expense_count: e?.count || 0, output_kg: kg, batches: o?.batches || 0, rate: kg > 0 ? round(amount / kg, 4) : null, unallocated: kg > 0 ? 0 : amount });
  }
  return map;
}

async function processing(db, url) {
  const { from, to } = dateRange(url);
  const rates = await processingRates(db);
  const data = [...rates.values()].filter((r) => (!from || r.ym >= ym(from)) && (!to || r.ym <= ym(to)));
  return json({
    from, to, data,
    total: {
      expense: round(data.reduce((s, r) => s + r.expense, 0)),
      output_kg: round(data.reduce((s, r) => s + r.output_kg, 0), 3),
      unallocated: round(data.reduce((s, r) => s + r.unallocated, 0)),
    },
  });
}

// ---------------------------------------------------------------- 毛利分析
const GROUPS = {
  product: (it) => [`p${it.product_id}`, it.product_name],
  customer: (it) => [`c${it.customer_id ?? 0}`, it.customer_name],
  channel: (it) => [it.channel, it.channel],
  roasted_bean: (it) => [`r${it.roasted_bean_id ?? 0}`, it.roasted_bean_name || '（不含熟豆）'],
  month: (it, date) => [ym(date), ym(date)],
};

const ITEM_SQL = `SELECT si.item_id, si.sale_id, si.qty, si.amount, si.cost_amount, si.packaging_cost, si.deduct_kg,
       s.sale_date, s.subtotal, s.discount, s.channel, s.customer_id, COALESCE(c.name, '散客') AS customer_name,
       p.product_id, p.name AS product_name, p.category, p.roasted_bean_id, rb.name AS roasted_bean_name
  FROM sale_items si JOIN sales s ON s.sale_id = si.sale_id JOIN products p ON p.product_id = si.product_id
  LEFT JOIN customers c ON c.customer_id = s.customer_id LEFT JOIN roasted_beans rb ON rb.roasted_bean_id = p.roasted_bean_id`;
const netRatio = (it) => (it.subtotal > 0 ? 1 - it.discount / it.subtotal : 1);

async function profitData(db, from, to) {
  const rates = await processingRates(db);
  const rateOf = (m) => rates.get(m)?.rate || 0;

  // 期間內的銷貨明細
  const b1 = [];
  const { results: items } = await db.prepare(`${ITEM_SQL} WHERE ${between('s.sale_date', from, to, b1)}`).bind(...b1).all();
  // 出貨熟豆的烘焙月份 → 加工成本
  const b2 = [];
  const { results: outs } = await db.prepare(
    `SELECT m.ref_item_id AS item_id, substr(rl.roast_date, 1, 7) AS ym, -SUM(m.qty) AS kg
     FROM inventory_movements m JOIN roasted_lots rl ON rl.roasted_lot_id = m.item_ref_id JOIN sales s ON s.sale_id = m.ref_doc_id
     WHERE m.ref_doc_type = 'sales' AND m.item_type = '熟豆' AND ${between('s.sale_date', from, to, b2)}
     GROUP BY m.ref_item_id, ym`,
  ).bind(...b2).all();
  const procOf = new Map();
  for (const o of outs) procOf.set(o.item_id, round((procOf.get(o.item_id) || 0) + o.kg * rateOf(o.ym), 4));

  // 期間內的銷貨退回／折讓（依退貨日）
  const b3 = [];
  const { results: rets } = await db.prepare(
    `SELECT r.return_id, r.return_type, r.return_date, r.total_amount, r.sale_id, ri.item_id AS return_item_id, ri.sale_item_id, ri.qty, ri.amount, ri.cost_amount
     FROM returns r LEFT JOIN return_items ri ON ri.return_id = r.return_id
     WHERE r.sale_id IS NOT NULL AND ${between('r.return_date', from, to, b3)}`,
  ).bind(...b3).all();
  const b4 = [];
  const { results: retMoves } = await db.prepare(
    `SELECT m.ref_item_id AS return_item_id, substr(rl.roast_date, 1, 7) AS ym, SUM(m.qty) AS kg
     FROM inventory_movements m JOIN roasted_lots rl ON rl.roasted_lot_id = m.item_ref_id JOIN returns r ON r.return_id = m.ref_doc_id
     WHERE m.ref_doc_type = 'returns' AND m.item_type = '熟豆' AND ${between('r.return_date', from, to, b4)}
     GROUP BY m.ref_item_id, ym`,
  ).bind(...b4).all();
  const retProc = new Map();
  for (const m of retMoves) retProc.set(m.return_item_id, round((retProc.get(m.return_item_id) || 0) + m.kg * rateOf(m.ym), 4));

  // 退貨涉及的原銷貨明細（可能不在期間內）
  const saleIds = [...new Set(rets.map((r) => r.sale_id))];
  const saleItems = new Map();
  if (saleIds.length) {
    const { results } = await db.prepare(`${ITEM_SQL} WHERE s.sale_id IN (${saleIds.map(() => '?').join(',')})`).bind(...saleIds).all();
    for (const it of results) saleItems.set(it.item_id, it);
  }

  // 統一成「事件」：每筆 = 一個明細在某天的營收／成本／加工成本變動
  const events = [];
  for (const it of items) {
    events.push({ it, date: it.sale_date, qty: it.qty, revenue: it.amount * netRatio(it), returns: 0, cost: it.cost_amount, packaging: it.packaging_cost, processing: procOf.get(it.item_id) || 0 });
  }
  for (const r of rets) {
    if (r.return_type === '銷貨退回' && r.sale_item_id) {
      const it = saleItems.get(r.sale_item_id);
      if (!it) continue;
      events.push({ it, date: r.return_date, qty: -r.qty, revenue: 0, returns: r.amount, cost: -r.cost_amount, packaging: 0, processing: -(retProc.get(r.return_item_id) || 0) });
    } else if (r.return_type === '銷貨折讓') {
      // 折讓依原單明細金額比例分攤
      const its = [...saleItems.values()].filter((x) => x.sale_id === r.sale_id);
      const base = its.reduce((s, x) => s + x.amount, 0);
      for (const x of its) events.push({ it: x, date: r.return_date, qty: 0, revenue: 0, returns: base > 0 ? (r.total_amount * x.amount) / base : 0, cost: 0, packaging: 0, processing: 0 });
    }
  }
  return { events, rates };
}

async function profit(db, url) {
  const { from, to } = dateRange(url);
  const group = url.searchParams.get('group') || 'product';
  if (!GROUPS[group]) throw new HttpError(400, 'group 必須是 product｜customer｜channel｜month｜roasted_bean');
  const { events } = await profitData(db, from, to);
  const rows = new Map();
  for (const e of events) {
    const [key, label] = GROUPS[group](e.it, e.date);
    const r = rows.get(key) || { key, label, category: group === 'product' ? e.it.category : undefined, qty: 0, revenue: 0, returns: 0, cost: 0, packaging: 0, processing: 0 };
    r.qty += e.qty; r.revenue += e.revenue; r.returns += e.returns; r.cost += e.cost; r.packaging += e.packaging; r.processing += e.processing;
    rows.set(key, r);
  }
  const finish = (r) => {
    for (const k of ['revenue', 'returns', 'cost', 'packaging', 'processing']) r[k] = round(r[k]);
    r.net_revenue = round(r.revenue - r.returns);
    r.gross = round(r.net_revenue - r.cost);
    r.margin = r.net_revenue ? round(r.gross / r.net_revenue, 4) : null;
    r.adj_gross = round(r.gross - r.processing);
    r.adj_margin = r.net_revenue ? round(r.adj_gross / r.net_revenue, 4) : null;
    return r;
  };
  const data = [...rows.values()].map(finish).sort((a, b) => (group === 'month' ? a.key.localeCompare(b.key) : b.net_revenue - a.net_revenue));
  const total = finish(data.reduce((t, r) => { for (const k of ['qty', 'revenue', 'returns', 'cost', 'packaging', 'processing']) t[k] += r[k]; return t; }, { key: 'total', label: '合計', qty: 0, revenue: 0, returns: 0, cost: 0, packaging: 0, processing: 0 }));
  return json({ from, to, group, data, total });
}

// ---------------------------------------------------------------- 損益概要
async function pnl(db, url) {
  const { from, to } = dateRange(url);
  const period = url.searchParams.get('period') || 'month';
  if (!['month', 'quarter', 'year'].includes(period)) throw new HttpError(400, 'period 必須是 month｜quarter｜year');
  const P = new Map();
  const row = (k) => {
    if (!P.has(k)) P.set(k, { period: k, sales: 0, shipping: 0, returns: 0, cogs: 0, restock_cost: 0, expenses: 0, roast_expenses: 0, inv_loss: 0, by_category: {} });
    return P.get(k);
  };
  const b1 = [];
  const { results: sales } = await db.prepare(
    `SELECT sale_date, subtotal, discount, shipping_fee, cost_amount FROM sales s WHERE ${between('s.sale_date', from, to, b1)}`,
  ).bind(...b1).all();
  for (const s of sales) { const r = row(periodKey(s.sale_date, period)); r.sales += s.subtotal - s.discount; r.shipping += s.shipping_fee; r.cogs += s.cost_amount; }
  const b2 = [];
  const { results: rets } = await db.prepare(
    `SELECT return_date, return_type, total_amount, cost_amount FROM returns r WHERE r.sale_id IS NOT NULL AND ${between('r.return_date', from, to, b2)}`,
  ).bind(...b2).all();
  for (const x of rets) { const r = row(periodKey(x.return_date, period)); r.returns += x.total_amount; r.restock_cost += x.cost_amount; }
  const b3 = [];
  const { results: exps } = await db.prepare(
    `SELECT e.expense_date, e.amount, e.allocate_to_roast, c.name FROM expenses e JOIN expense_categories c ON c.category_id = e.category_id WHERE ${between('e.expense_date', from, to, b3)}`,
  ).bind(...b3).all();
  for (const e of exps) {
    const r = row(periodKey(e.expense_date, period));
    r.expenses += e.amount;
    if (e.allocate_to_roast) r.roast_expenses += e.amount;
    r.by_category[e.name] = round((r.by_category[e.name] || 0) + e.amount);
  }
  const b4 = [];
  const { results: adj } = await db.prepare(
    `SELECT substr(movement_date, 1, 10) AS d, SUM(amount) AS amount FROM inventory_movements
     WHERE movement_type IN ('盤盈','盤虧','試喝','樣品','報廢') AND ${between('substr(movement_date, 1, 10)', from, to, b4)} GROUP BY d`,
  ).bind(...b4).all();
  for (const a of adj) row(periodKey(a.d, period)).inv_loss -= a.amount;
  const finish = (r) => {
    for (const k of ['sales', 'shipping', 'returns', 'cogs', 'restock_cost', 'expenses', 'roast_expenses', 'inv_loss']) r[k] = round(r[k]);
    r.net_sales = round(r.sales - r.returns);
    r.revenue = round(r.net_sales + r.shipping);
    r.cost = round(r.cogs - r.restock_cost);
    r.gross = round(r.revenue - r.cost);
    r.gross_margin = r.revenue ? round(r.gross / r.revenue, 4) : null;
    r.net = round(r.gross - r.expenses - r.inv_loss);
    r.net_margin = r.revenue ? round(r.net / r.revenue, 4) : null;
    return r;
  };
  const data = [...P.values()].map(finish).sort((a, b) => a.period.localeCompare(b.period));
  const total = finish(data.reduce((t, r) => {
    for (const k of ['sales', 'shipping', 'returns', 'cogs', 'restock_cost', 'expenses', 'roast_expenses', 'inv_loss']) t[k] += r[k];
    for (const [c, v] of Object.entries(r.by_category)) t.by_category[c] = round((t.by_category[c] || 0) + v);
    return t;
  }, { period: '合計', sales: 0, shipping: 0, returns: 0, cogs: 0, restock_cost: 0, expenses: 0, roast_expenses: 0, inv_loss: 0, by_category: {} }));
  return json({ from, to, period, data, total, categories: Object.keys(total.by_category).sort((a, b) => total.by_category[b] - total.by_category[a]) });
}

// ---------------------------------------------------------------- 失重率分析
async function loss(db, url) {
  const { from, to } = dateRange(url);
  const by = url.searchParams.get('by') || 'green';
  const binds = [];
  const where = between('r.roast_date', from, to, binds);
  let rows;
  if (by === 'roasted') {
    ({ results: rows } = await db.prepare(
      `SELECT r.roasted_bean_id AS id, n.name, substr(r.roast_date, 1, 7) AS ym, COUNT(*) AS batches, SUM(r.input_total_kg) AS input_kg, SUM(r.output_kg) AS output_kg,
              MIN(r.loss_rate) AS min_rate, MAX(r.loss_rate) AS max_rate
       FROM roast_batches r JOIN roasted_beans n ON n.roasted_bean_id = r.roasted_bean_id WHERE ${where}
       GROUP BY r.roasted_bean_id, ym ORDER BY n.name, ym`,
    ).bind(...binds).all());
  } else {
    // 一個批次投入多種生豆時，批次失重率套用到每一種生豆（依投入 kg 加權）
    ({ results: rows } = await db.prepare(
      `SELECT l.bean_id AS id, b.name, substr(r.roast_date, 1, 7) AS ym, COUNT(DISTINCT r.batch_id) AS batches, SUM(i.input_kg) AS input_kg,
              SUM(i.input_kg * (1 - r.loss_rate)) AS output_kg, MIN(r.loss_rate) AS min_rate, MAX(r.loss_rate) AS max_rate
       FROM roast_batch_inputs i JOIN roast_batches r ON r.batch_id = i.batch_id JOIN green_bean_lots l ON l.lot_id = i.lot_id JOIN green_beans b ON b.bean_id = l.bean_id
       WHERE ${where} GROUP BY l.bean_id, ym ORDER BY b.name, ym`,
    ).bind(...binds).all());
  }
  const items = new Map();
  for (const r of rows) {
    const it = items.get(r.id) || { id: r.id, name: r.name, batches: 0, input_kg: 0, output_kg: 0, min_rate: 1, max_rate: 0, months: {} };
    it.batches += r.batches; it.input_kg += r.input_kg; it.output_kg += r.output_kg;
    it.min_rate = Math.min(it.min_rate, r.min_rate); it.max_rate = Math.max(it.max_rate, r.max_rate);
    it.months[r.ym] = { batches: r.batches, input_kg: round(r.input_kg, 3), loss_rate: r.input_kg ? round((r.input_kg - r.output_kg) / r.input_kg, 4) : null };
    items.set(r.id, it);
  }
  const data = [...items.values()].map((it) => ({ ...it, input_kg: round(it.input_kg, 3), output_kg: round(it.output_kg, 3), loss_rate: it.input_kg ? round((it.input_kg - it.output_kg) / it.input_kg, 4) : null }));
  const months = [...new Set(rows.map((r) => r.ym))].sort();
  const tin = data.reduce((s, r) => s + r.input_kg, 0);
  const tout = data.reduce((s, r) => s + r.output_kg, 0);
  return json({ from, to, by, months, data, total: { input_kg: round(tin, 3), output_kg: round(tout, 3), loss_rate: tin ? round((tin - tout) / tin, 4) : null } });
}

// ---------------------------------------------------------------- 批號追溯
async function roastedOutflows(db, roastedLotId) {
  const { results } = await db.prepare(
    `SELECT m.movement_date, m.movement_type, m.qty, m.ref_doc_type, COALESCE(s.sale_no, r.return_no, c.count_no) AS doc_no,
            COALESCE(cu.name, cu2.name, CASE WHEN s.sale_id IS NOT NULL THEN '散客' END) AS customer_name, COALESCE(s.sale_id, r.sale_id) AS sale_id
     FROM inventory_movements m
     LEFT JOIN sales s ON m.ref_doc_type = 'sales' AND s.sale_id = m.ref_doc_id LEFT JOIN customers cu ON cu.customer_id = s.customer_id
     LEFT JOIN returns r ON m.ref_doc_type = 'returns' AND r.return_id = m.ref_doc_id
     LEFT JOIN sales s2 ON s2.sale_id = r.sale_id LEFT JOIN customers cu2 ON cu2.customer_id = s2.customer_id
     LEFT JOIN stock_counts c ON m.ref_doc_type = 'stock_counts' AND c.count_id = m.ref_doc_id
     WHERE m.item_type = '熟豆' AND m.item_ref_id = ? AND m.movement_type <> '烘焙產出' ORDER BY m.movement_date, m.movement_id`,
  ).bind(roastedLotId).all();
  return results;
}

async function trace(db, url) {
  const sp = url.searchParams;
  if (sp.get('lot_id')) {
    const lotId = toInt(sp.get('lot_id'), '生豆批號');
    const lot = await db.prepare(
      `SELECT v.*, l.purchase_item_id, p.purchase_id, p.purchase_no, p.purchase_date, s.name AS supplier_name, b.country, b.process
       FROM v_green_bean_lot_stock v JOIN green_bean_lots l ON l.lot_id = v.lot_id JOIN green_beans b ON b.bean_id = l.bean_id
       LEFT JOIN purchase_items pi ON pi.item_id = l.purchase_item_id LEFT JOIN purchases p ON p.purchase_id = pi.purchase_id
       LEFT JOIN suppliers s ON s.supplier_id = p.supplier_id WHERE v.lot_id = ?`,
    ).bind(lotId).first();
    if (!lot) throw new HttpError(404, '找不到生豆批號');
    const { results: batches } = await db.prepare(
      `SELECT r.batch_id, r.batch_no, r.roast_date, r.loss_rate, i.input_kg, r.input_total_kg, r.output_kg, n.name AS roasted_bean_name, v.roasted_lot_id, v.current_kg
       FROM roast_batch_inputs i JOIN roast_batches r ON r.batch_id = i.batch_id JOIN roasted_beans n ON n.roasted_bean_id = r.roasted_bean_id
       LEFT JOIN v_roasted_lot_stock v ON v.batch_id = r.batch_id WHERE i.lot_id = ? ORDER BY r.roast_date`,
    ).bind(lotId).all();
    for (const b of batches) {
      b.share = b.input_total_kg ? round(b.input_kg / b.input_total_kg, 4) : 0; // 這批生豆佔該烘焙批次的比例
      b.outflows = b.roasted_lot_id ? await roastedOutflows(db, b.roasted_lot_id) : [];
    }
    const { results: others } = await db.prepare(
      `SELECT movement_date, movement_type, qty, note FROM inventory_movements WHERE item_type = '生豆' AND item_ref_id = ? AND movement_type NOT IN ('烘焙投入') ORDER BY movement_date, movement_id`,
    ).bind(lotId).all();
    const customers = [...new Set(batches.flatMap((b) => b.outflows.filter((o) => o.movement_type === '銷貨出庫').map((o) => o.customer_name)))];
    return json({ type: 'green', lot, batches, movements: others, customers });
  }
  if (sp.get('roasted_lot_id')) {
    const rid = toInt(sp.get('roasted_lot_id'), '熟豆批次');
    const lot = await db.prepare(
      `SELECT v.*, r.input_total_kg, r.output_kg, r.loss_rate, r.input_total_cost FROM v_roasted_lot_stock v JOIN roast_batches r ON r.batch_id = v.batch_id WHERE v.roasted_lot_id = ?`,
    ).bind(rid).first();
    if (!lot) throw new HttpError(404, '找不到熟豆批次');
    const { results: inputs } = await db.prepare(
      `SELECT i.input_kg, i.unit_cost, l.lot_id, l.lot_no, l.received_date, b.name AS bean_name, p.purchase_no, s.name AS supplier_name
       FROM roast_batch_inputs i JOIN green_bean_lots l ON l.lot_id = i.lot_id JOIN green_beans b ON b.bean_id = l.bean_id
       LEFT JOIN purchase_items pi ON pi.item_id = l.purchase_item_id LEFT JOIN purchases p ON p.purchase_id = pi.purchase_id LEFT JOIN suppliers s ON s.supplier_id = p.supplier_id
       WHERE i.batch_id = ? ORDER BY i.line_no`,
    ).bind(lot.batch_id).all();
    const outflows = await roastedOutflows(db, rid);
    const customers = [...new Set(outflows.filter((o) => o.movement_type === '銷貨出庫').map((o) => o.customer_name))];
    return json({ type: 'roasted', lot, inputs, outflows, customers });
  }
  throw new HttpError(400, '請指定 lot_id 或 roasted_lot_id');
}

export async function handleReports(sub, request, env) {
  if (request.method !== 'GET') throw new HttpError(405, '不支援的操作');
  const url = new URL(request.url);
  if (sub === 'processing') return processing(env.DB, url);
  if (sub === 'profit') return profit(env.DB, url);
  if (sub === 'pnl') return pnl(env.DB, url);
  if (sub === 'loss') return loss(env.DB, url);
  if (sub === 'trace') return trace(env.DB, url);
  throw new HttpError(404, '找不到此報表');
}
