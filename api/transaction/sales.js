// 銷貨單（表頭＋明細）
// 存檔規則（ARCHITECTURE.md 8.3，Phase 2 範圍）：
//   1. 產品有指定熟豆品項 → 應扣熟豆 kg = 數量 × 每包淨重 g ÷ 1000
//   2. 熟豆以先進先出（FIFO）挑選「烘焙日 ≤ 銷貨日、還有庫存」的最早批次，一筆明細可跨多個批次
//   3. 每扣一個批次寫一筆 inventory_movements（銷貨出庫，−kg），ref_item_id = 銷貨明細
//   4. 熟豆不夠扣 → 回 409（code = SHORTAGE）；前端提醒後帶 allow_shortage 重送即可存檔：
//        不足的量記在最近一個批次上（該批次庫存變負數）；完全沒有烘焙批次時該筆不扣庫存
//   5. 明細記錄出貨當下成本（cost_amount、unit_cost）供毛利計算
//   6. 收款狀態（Phase 3）：一律由收款沖帳決定（銀行收支入帳 → 沖銷售單），不能手動指定。
//      已沖帳的銷貨單仍可修改；改後金額小於已收 → 標示溢收。有沖帳的銷貨單不可刪除。
//   7. 包材耗用（Phase 4）：產品有配方 → 每包用量 × 數量扣包材庫存（包裝耗用），
//      成本 = 包材移動平均成本，記在 packaging_cost 並加進 cost_amount；包材不足比照熟豆提醒後可存
//   8. 有退貨／折讓的銷貨單不可修改或刪除（請先刪除退貨單）；有未作廢發票的銷貨單不可刪除
//   9. 列印（GET /api/sales/print?ids=）：一次取回多張銷貨單的表頭、客戶聯絡資料、明細與商店資料；
//      給客戶看的單據，所以不含成本、毛利、批次
// 修改 = 整張重寫明細與異動，FIFO 重新計算。表頭、明細、異動在同一個 D1 batch（單一交易）。

import { HttpError, json, readJson, toInt, isDate, dateRange, nowTW, round } from '../lib/http.js';
import { makeNo, seqOf, lastSeq, seqStatement } from '../lib/docno.js';
import { GRIND_SIZES } from '../master/resources.js';
import { statusStatement, docPayments, docReturns, paidExpr, returnsExpr } from '../lib/payment.js';
import { getShop } from '../system/settings.js';

export const CHANNELS = ['門市', '電話', 'LINE', '官網', '蝦皮', '批發'];
export const PAY_METHODS = ['現金', '轉帳', 'LINE Pay', '刷卡', '貨到付款', '月結'];
export const PAY_STATUS = ['未收', '部分收款', '已收清'];
const EPS = 0.0005;
const PRINT_MAX = 300;

/** 驗證輸入、FIFO 配批次並算出所有 auto 欄位 */
async function prepare(db, body, { excludeSaleId = null, keepNo = null } = {}) {
  const sale_date = body.sale_date;
  if (!isDate(sale_date)) throw new HttpError(400, '銷貨日期格式錯誤（YYYY-MM-DD）');

  let customer_id = null;
  if (body.customer_id !== undefined && body.customer_id !== null && body.customer_id !== '') {
    customer_id = toInt(body.customer_id, '客戶');
    const c = await db.prepare('SELECT customer_id FROM customers WHERE customer_id = ?').bind(customer_id).first();
    if (!c) throw new HttpError(400, '客戶不存在');
  }
  const channel = body.channel || '門市';
  if (!CHANNELS.includes(channel)) throw new HttpError(400, `通路必須是：${CHANNELS.join('／')}`);
  const payment_method = body.payment_method || '現金';
  if (!PAY_METHODS.includes(payment_method)) throw new HttpError(400, `付款方式必須是：${PAY_METHODS.join('／')}`);

  const num = (v, name) => {
    const n = v === undefined || v === null || v === '' ? 0 : Number(v);
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${name}必須是 0 以上的數字`);
    return n;
  };
  const discount = round(num(body.discount, '折扣'));
  const shipping_fee = round(num(body.shipping_fee, '運費'));
  if (body.due_date && !isDate(body.due_date)) throw new HttpError(400, '應收日期格式錯誤（YYYY-MM-DD）');
  if (!Array.isArray(body.items) || body.items.length === 0) throw new HttpError(400, '銷貨單至少要有一筆明細');

  // ---- 明細 ----
  const items = [];
  for (const [i, raw] of body.items.entries()) {
    const line = i + 1;
    const product_id = toInt(raw.product_id, `第 ${line} 筆產品`);
    const prod = await db.prepare(
      `SELECT p.product_id, p.name, p.net_weight_g, p.roasted_bean_id, n.name AS roasted_bean_name
       FROM products p LEFT JOIN roasted_beans n ON n.roasted_bean_id = p.roasted_bean_id WHERE p.product_id = ?`,
    ).bind(product_id).first();
    if (!prod) throw new HttpError(400, `第 ${line} 筆：產品不存在`);
    const qty = Number(raw.qty);
    const unit_price = Number(raw.unit_price);
    if (!Number.isInteger(qty) || qty <= 0) throw new HttpError(400, `第 ${line} 筆：數量必須是大於 0 的整數`);
    if (!Number.isFinite(unit_price) || unit_price < 0) throw new HttpError(400, `第 ${line} 筆：單價不可為負數`);
    const grind_size = (raw.grind_size || '').trim() || null;
    if (grind_size && !GRIND_SIZES.includes(grind_size)) throw new HttpError(400, `第 ${line} 筆：研磨度必須是：${GRIND_SIZES.join('／')}`);
    if (prod.roasted_bean_id && !(prod.net_weight_g > 0)) {
      throw new HttpError(400, `第 ${line} 筆：產品「${prod.name}」已指定熟豆品項但沒有每包淨重，請先到產品主檔補上`);
    }
    items.push({
      line_no: line, product_id, product_name: prod.name, grind_size, qty, unit_price,
      amount: round(qty * unit_price),
      roasted_bean_id: prod.roasted_bean_id, roasted_bean_name: prod.roasted_bean_name,
      deduct_kg: prod.roasted_bean_id ? round((qty * prod.net_weight_g) / 1000, 3) : 0,
      allocs: [], cost_amount: 0, unit_cost: 0,
      note: (raw.note || '').trim() || null,
    });
  }

  // ---- FIFO 配熟豆批次 ----
  // 各批次可用量 = 所有異動加總，但不含本單自己先前的出庫（修改時要加回來）
  const beanIds = [...new Set(items.filter((it) => it.roasted_bean_id).map((it) => it.roasted_bean_id))];
  const lotsByBean = new Map();
  for (const beanId of beanIds) {
    const { results } = await db.prepare(
      `SELECT rl.roasted_lot_id, rl.roast_date, rl.unit_cost, rb.batch_no, COALESCE(SUM(m.qty), 0) AS stock
       FROM roasted_lots rl
       JOIN roast_batches rb ON rb.batch_id = rl.batch_id
       LEFT JOIN inventory_movements m
              ON m.item_type = '熟豆' AND m.item_ref_id = rl.roasted_lot_id
             AND (m.ref_doc_type IS NOT 'sales' OR m.ref_doc_id IS NOT ?)
       WHERE rl.roasted_bean_id = ?
       GROUP BY rl.roasted_lot_id
       ORDER BY rl.roast_date, rl.roasted_lot_id`,
    ).bind(excludeSaleId ?? -1, beanId).all();
    lotsByBean.set(beanId, results);
  }

  const shortages = [];
  const take = (it, lot, kg) => {
    kg = round(kg, 3);
    lot.stock -= kg;
    const found = it.allocs.find((a) => a.roasted_lot_id === lot.roasted_lot_id);
    if (found) found.kg = round(found.kg + kg, 3);
    else it.allocs.push({ roasted_lot_id: lot.roasted_lot_id, batch_no: lot.batch_no, kg, unit_cost: lot.unit_cost });
  };
  for (const it of items) {
    if (!it.roasted_bean_id) continue;
    const lots = lotsByBean.get(it.roasted_bean_id);
    const usable = lots.filter((l) => l.roast_date <= sale_date);
    let need = it.deduct_kg;
    for (const lot of usable) {
      if (need <= EPS) break;
      if (lot.stock <= EPS) continue;
      const kg = Math.min(need, lot.stock);
      take(it, lot, kg);
      need = round(need - kg, 3);
    }
    if (need > EPS) {
      // 不足：記在「銷貨日前最近一批」；沒有的話記在最早一批；完全沒有批次 → 不扣庫存
      const fallback = usable[usable.length - 1] || lots[0] || null;
      shortages.push({
        type: '熟豆', line_no: it.line_no, product_name: it.product_name, roasted_bean_name: it.roasted_bean_name,
        need_kg: it.deduct_kg, short_kg: need, batch_no: fallback?.batch_no || null,
      });
      if (fallback) take(it, fallback, need);
    }
    for (const a of it.allocs) a.amount = round(a.kg * a.unit_cost);
    it.cost_amount = round(it.allocs.reduce((s, a) => s + a.amount, 0));
  }

  // ---- 配方：扣包材（Phase 4）----
  const productIds = [...new Set(items.map((it) => it.product_id))];
  const { results: recipeRows } = await db.prepare(
    `SELECT r.product_id, r.packaging_id, r.qty, k.name, k.unit, k.unit_cost AS ref_cost
     FROM product_recipes r JOIN packaging_items k ON k.packaging_id = r.packaging_id
     WHERE r.product_id IN (${productIds.map(() => '?').join(',')})`,
  ).bind(...productIds).all();
  const packStock = new Map(); // packaging_id → { qty, cost }（不含本單原本的耗用）
  for (const pid of new Set(recipeRows.map((r) => r.packaging_id))) {
    const st = await db.prepare(
      `SELECT COALESCE(SUM(qty), 0) AS qty, COALESCE(SUM(amount), 0) AS amount FROM inventory_movements
       WHERE item_type = '包材' AND item_ref_id = ? AND (ref_doc_type IS NOT 'sales' OR ref_doc_id IS NOT ?)`,
    ).bind(pid, excludeSaleId ?? -1).first();
    const ref = recipeRows.find((r) => r.packaging_id === pid);
    // 移動平均成本；沒有庫存時用包材主檔參考單價
    const cost = st.qty > EPS ? round(st.amount / st.qty, 4) : (ref.ref_cost || 0);
    packStock.set(pid, { qty: st.qty, cost, name: ref.name, unit: ref.unit });
  }
  for (const it of items) {
    it.packs = [];
    for (const r of recipeRows.filter((x) => x.product_id === it.product_id)) {
      const ps = packStock.get(r.packaging_id);
      const need = round(r.qty * it.qty, 3);
      if (need > ps.qty + EPS) {
        shortages.push({ type: '包材', line_no: it.line_no, product_name: it.product_name, packaging_name: ps.name, unit: ps.unit, need_qty: need, short_qty: round(need - Math.max(0, ps.qty), 3) });
      }
      ps.qty = round(ps.qty - need, 3);
      it.packs.push({ packaging_id: r.packaging_id, qty: need, unit_cost: ps.cost, amount: round(need * ps.cost) });
    }
    it.packaging_cost = round(it.packs.reduce((s, x) => s + x.amount, 0));
    it.cost_amount = round(it.cost_amount + it.packaging_cost);
    it.unit_cost = round(it.cost_amount / it.qty, 4);
  }

  if (shortages.length && body.allow_shortage !== true) {
    throw new HttpError(409, '庫存不足', { code: 'SHORTAGE', shortages });
  }

  const subtotal = round(items.reduce((s, it) => s + it.amount, 0));
  const total_amount = round(subtotal - discount + shipping_fee);
  if (discount > subtotal) throw new HttpError(400, '折扣不可大於明細小計');

  // ---- 單號（空白 → 自動產生；有填 → 檢查重複）----
  const ymd = sale_date.replaceAll('-', '');
  let sale_no = (body.sale_no || '').trim() || keepNo || null; // 修改時留空 = 沿用原單號
  let sLast = await lastSeq(db, 'S', ymd);
  if (!sale_no) sale_no = makeNo('S', ymd, ++sLast);
  else {
    const dup = await db.prepare('SELECT sale_id FROM sales WHERE sale_no = ?').bind(sale_no).first();
    if (dup && dup.sale_id !== excludeSaleId) throw new HttpError(409, `銷貨單號 ${sale_no} 已存在`);
    sLast = Math.max(sLast, seqOf(sale_no, 'S', ymd));
  }

  return {
    header: {
      sale_no, sale_date, customer_id, channel, subtotal, discount, shipping_fee, total_amount,
      cost_amount: round(items.reduce((s, it) => s + it.cost_amount, 0)),
      payment_method,
      due_date: body.due_date || null,
      note: (body.note || '').trim() || null,
      subscription_id: body.subscription_id ? Number(body.subscription_id) : null,
    },
    items, ymd, sLast, shortages,
  };
}

/** 明細、異動的 INSERT 語句（表頭已存在或在同一 batch 較前面） */
function itemStatements(db, p, user) {
  const h = p.header;
  const SID = '(SELECT sale_id FROM sales WHERE sale_no = ?)';
  const IID = `(SELECT item_id FROM sale_items WHERE sale_id = ${SID} AND line_no = ?)`;
  const mvDate = `${h.sale_date} 00:00:00`;
  const stmts = [];
  for (const it of p.items) {
    stmts.push(db.prepare(
      `INSERT INTO sale_items (sale_id, line_no, product_id, grind_size, qty, unit_price, amount, deduct_kg, unit_cost, cost_amount, packaging_cost, note)
       VALUES (${SID}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(h.sale_no, it.line_no, it.product_id, it.grind_size, it.qty, it.unit_price, it.amount, it.deduct_kg, it.unit_cost, it.cost_amount, it.packaging_cost, it.note));
    for (const k of it.packs) {
      stmts.push(db.prepare(
        `INSERT INTO inventory_movements (movement_date, item_type, item_ref_id, movement_type, qty, unit_cost, amount, ref_doc_type, ref_doc_id, ref_item_id, note, created_by)
         VALUES (?, '包材', ?, '包裝耗用', ?, ?, ?, 'sales', ${SID}, ${IID}, ?, ?)`,
      ).bind(mvDate, k.packaging_id, -k.qty, k.unit_cost, -k.amount, h.sale_no, h.sale_no, it.line_no, h.sale_no, user));
    }
    for (const a of it.allocs) {
      stmts.push(db.prepare(
        `INSERT INTO inventory_movements (movement_date, item_type, item_ref_id, movement_type, qty, unit_cost, amount, ref_doc_type, ref_doc_id, ref_item_id, note, created_by)
         VALUES (?, '熟豆', ?, '銷貨出庫', ?, ?, ?, 'sales', ${SID}, ${IID}, ?, ?)`,
      ).bind(mvDate, a.roasted_lot_id, -a.kg, a.unit_cost, -a.amount, h.sale_no, h.sale_no, it.line_no, h.sale_no, user));
    }
  }
  if (p.sLast > 0) stmts.push(seqStatement(db, 'S', p.ymd, p.sLast));
  return stmts;
}

/** 新增銷貨單（訂閱出貨也用這個）。extra：一起放進同一個 batch 的語句 */
export async function createSale(db, body, user, extra = []) {
  const p = await prepare(db, body);
  const h = p.header;
  await db.batch([
    db.prepare(
      `INSERT INTO sales (sale_no, sale_date, customer_id, channel, subtotal, discount, shipping_fee, total_amount, cost_amount, payment_method, payment_status, due_date, note, subscription_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '未收', ?, ?, ?, ?)`,
    ).bind(h.sale_no, h.sale_date, h.customer_id, h.channel, h.subtotal, h.discount, h.shipping_fee, h.total_amount, h.cost_amount, h.payment_method, h.due_date, h.note, h.subscription_id, user),
    ...itemStatements(db, p, user),
    db.prepare(`UPDATE sales SET payment_status = '已收清' WHERE sale_no = ? AND total_amount <= 0.005`).bind(h.sale_no),
    ...extra,
  ]);
  const row = await db.prepare('SELECT sale_id FROM sales WHERE sale_no = ?').bind(h.sale_no).first();
  return { data: await getSale(db, row.sale_id), shortages: p.shortages };
}

async function getSale(db, id) {
  const header = await db.prepare(
    `SELECT s.*, c.name AS customer_name FROM sales s LEFT JOIN customers c ON c.customer_id = s.customer_id WHERE s.sale_id = ?`,
  ).bind(id).first();
  if (!header) throw new HttpError(404, '找不到銷貨單');
  const { results: items } = await db.prepare(
    `SELECT si.*, p.name AS product_name, p.net_weight_g, p.roasted_bean_id, n.name AS roasted_bean_name
     FROM sale_items si
     JOIN products p ON p.product_id = si.product_id
     LEFT JOIN roasted_beans n ON n.roasted_bean_id = p.roasted_bean_id
     WHERE si.sale_id = ? ORDER BY si.line_no`,
  ).bind(id).all();
  const { results: allocs } = await db.prepare(
    `SELECT m.ref_item_id AS item_id, m.item_ref_id AS roasted_lot_id, rb.batch_no, -m.qty AS kg, m.unit_cost
     FROM inventory_movements m
     JOIN roasted_lots rl ON rl.roasted_lot_id = m.item_ref_id
     JOIN roast_batches rb ON rb.batch_id = rl.batch_id
     WHERE m.ref_doc_type = 'sales' AND m.ref_doc_id = ? AND m.item_type = '熟豆'
     ORDER BY m.movement_id`,
  ).bind(id).all();
  const { results: packs } = await db.prepare(
    `SELECT m.ref_item_id AS item_id, m.item_ref_id AS packaging_id, k.name, k.unit, -m.qty AS qty, -m.amount AS amount
     FROM inventory_movements m JOIN packaging_items k ON k.packaging_id = m.item_ref_id
     WHERE m.ref_doc_type = 'sales' AND m.ref_doc_id = ? AND m.item_type = '包材' ORDER BY m.movement_id`,
  ).bind(id).all();
  for (const it of items) {
    it.packs = packs.filter((k) => k.item_id === it.item_id);
    it.lots = allocs.filter((a) => a.item_id === it.item_id);
    // 應扣但沒扣到的量（存檔當時沒有任何烘焙批次）
    it.undeducted_kg = round(Math.max(0, it.deduct_kg - it.lots.reduce((s, a) => s + a.kg, 0)), 3);
  }
  header.items = items;
  header.gross_profit = round(header.subtotal - header.discount - header.cost_amount);
  Object.assign(header, await docPayments(db, 'sales', id), await docReturns(db, 'sales', id));
  header.net_amount = round(header.total_amount - header.returned_amount);
  header.unpaid_amount = round(Math.max(0, header.net_amount - header.paid_amount));
  header.overpaid = round(Math.max(0, header.paid_amount - header.net_amount)); // 應退客戶
  const { results: invoices } = await db.prepare('SELECT * FROM invoices WHERE sale_id = ? ORDER BY invoice_id').bind(id).all();
  header.invoices = invoices;
  return header;
}

/** 清除銷貨單的明細、異動（表頭保留） */
function clearStatements(db, id) {
  return [
    db.prepare("DELETE FROM inventory_movements WHERE ref_doc_type = 'sales' AND ref_doc_id = ?").bind(id),
    db.prepare('DELETE FROM sale_items WHERE sale_id = ?').bind(id),
  ];
}

/** 日期區間＋客戶／產品／通路／收款狀態 的共用篩選（別名 s = sales） */
function saleFilters(url) {
  const { from, to } = dateRange(url);
  const sp = url.searchParams;
  const where = [];
  const binds = [];
  if (from) { where.push('s.sale_date >= ?'); binds.push(from); }
  if (to) { where.push('s.sale_date <= ?'); binds.push(to); }
  const cid = sp.get('customer_id');
  if (cid === 'none') where.push('s.customer_id IS NULL'); // 散客
  else if (cid) { where.push('s.customer_id = ?'); binds.push(toInt(cid, '客戶')); }
  if (sp.get('channel')) { where.push('s.channel = ?'); binds.push(sp.get('channel')); }
  if (sp.get('payment_status')) { where.push('s.payment_status = ?'); binds.push(sp.get('payment_status')); }
  return { from, to, where, binds, productId: sp.get('product_id') ? toInt(sp.get('product_id'), '產品') : null };
}

export async function handleSales(id, request, env, user) {
  const db = env.DB;
  const url = new URL(request.url);
  const method = request.method;

  // ---- 預覽下一個單號 ----
  if (id === 'next-no' && method === 'GET') {
    const date = url.searchParams.get('date');
    if (!isDate(date)) throw new HttpError(400, '日期格式錯誤');
    const ymd = date.replaceAll('-', '');
    return json({ data: { sale_no: makeNo('S', ymd, (await lastSeq(db, 'S', ymd)) + 1) } });
  }

  // ---- 列印用資料：多張銷貨單（表頭＋客戶聯絡資料＋明細）＋商店資料，不含成本 ----
  if (id === 'print' && method === 'GET') {
    const ids = [...new Set((url.searchParams.get('ids') || '').split(',').filter(Boolean).map((v) => toInt(v, '銷貨單')))];
    if (!ids.length) throw new HttpError(400, '請指定要列印的銷貨單');
    if (ids.length > PRINT_MAX) throw new HttpError(400, `一次最多列印 ${PRINT_MAX} 張銷貨單，請縮小範圍`);
    const sales = [];
    const items = [];
    for (let i = 0; i < ids.length; i += 80) { // D1 每個語句最多 100 個參數
      const part = ids.slice(i, i + 80);
      const marks = part.map(() => '?').join(',');
      const [h, d] = await db.batch([
        db.prepare(
          `SELECT s.sale_id, s.sale_no, s.sale_date, s.customer_id, s.channel, s.subtotal, s.discount, s.shipping_fee, s.total_amount,
                  s.payment_method, s.payment_status, s.due_date, s.note,
                  c.name AS customer_name, c.tax_id AS customer_tax_id, c.phone AS customer_phone, c.shipping_address AS customer_address,
                  ${paidExpr('sales', 's.sale_id')} AS paid_amount,
                  ${returnsExpr('sales', 's.sale_id')} AS returned_amount,
                  (SELECT invoice_no FROM invoices i WHERE i.sale_id = s.sale_id AND i.status <> '作廢' ORDER BY i.invoice_id DESC LIMIT 1) AS invoice_no
           FROM sales s LEFT JOIN customers c ON c.customer_id = s.customer_id
           WHERE s.sale_id IN (${marks})`,
        ).bind(...part),
        db.prepare(
          `SELECT si.sale_id, si.line_no, p.name AS product_name, si.grind_size, si.qty, si.unit_price, si.amount, si.note
           FROM sale_items si JOIN products p ON p.product_id = si.product_id
           WHERE si.sale_id IN (${marks}) ORDER BY si.sale_id, si.line_no`,
        ).bind(...part),
      ]);
      sales.push(...h.results);
      items.push(...d.results);
    }
    for (const s of sales) {
      s.items = items.filter((it) => it.sale_id === s.sale_id);
      s.paid_amount = round(s.paid_amount);
      s.returned_amount = round(s.returned_amount);
      s.net_amount = round(s.total_amount - s.returned_amount);
      s.unpaid_amount = round(Math.max(0, s.net_amount - s.paid_amount));
    }
    sales.sort((a, b) => a.sale_date.localeCompare(b.sale_date) || a.sale_id - b.sale_id);
    return json({ data: sales, shop: await getShop(db) });
  }

  // ---- 銷貨明細查詢（客戶購買紀錄 = 帶 customer_id）----
  if (id === 'items' && method === 'GET') {
    const f = saleFilters(url);
    if (f.productId) { f.where.push('si.product_id = ?'); f.binds.push(f.productId); }
    const { results } = await db.prepare(
      `SELECT si.item_id, si.line_no, si.product_id, p.name AS product_name, si.grind_size, si.qty, si.unit_price, si.amount,
              si.deduct_kg, si.cost_amount,
              s.sale_id, s.sale_no, s.sale_date, s.channel, s.payment_method, s.payment_status, s.customer_id, c.name AS customer_name
       FROM sale_items si
       JOIN sales s ON s.sale_id = si.sale_id
       JOIN products p ON p.product_id = si.product_id
       LEFT JOIN customers c ON c.customer_id = s.customer_id
       ${f.where.length ? 'WHERE ' + f.where.join(' AND ') : ''}
       ORDER BY s.sale_date DESC, s.sale_id DESC, si.line_no
       LIMIT 5000`,
    ).bind(...f.binds).all();
    const byProduct = new Map();
    for (const r of results) {
      const p = byProduct.get(r.product_id) || { product_id: r.product_id, product_name: r.product_name, qty: 0, amount: 0, times: 0 };
      p.qty += r.qty; p.amount = round(p.amount + r.amount); p.times += 1;
      byProduct.set(r.product_id, p);
    }
    const summary = {
      sale_count: new Set(results.map((r) => r.sale_id)).size,
      qty: results.reduce((s, r) => s + r.qty, 0),
      amount: round(results.reduce((s, r) => s + r.amount, 0)),
      kg: round(results.reduce((s, r) => s + r.deduct_kg, 0), 3),
      last_date: results[0]?.sale_date || null,
      by_product: [...byProduct.values()].sort((a, b) => b.qty - a.qty || b.amount - a.amount),
    };
    return json({ from: f.from, to: f.to, data: results, summary });
  }

  // ---- 銷貨查詢（日期區間、客戶、產品、通路、收款狀態）----
  if (!id && method === 'GET') {
    const f = saleFilters(url);
    if (f.productId) {
      f.where.push('EXISTS (SELECT 1 FROM sale_items x WHERE x.sale_id = s.sale_id AND x.product_id = ?)');
      f.binds.push(f.productId);
    }
    const { results } = await db.prepare(
      `SELECT s.*, c.name AS customer_name,
              (SELECT COUNT(*) FROM sale_items x WHERE x.sale_id = s.sale_id) AS item_count,
              (SELECT COALESCE(SUM(x.deduct_kg), 0) FROM sale_items x WHERE x.sale_id = s.sale_id) AS roasted_kg,
              ${paidExpr('sales', 's.sale_id')} AS paid_amount,
              ${returnsExpr('sales', 's.sale_id')} AS returned_amount,
              (SELECT invoice_no FROM invoices i WHERE i.sale_id = s.sale_id AND i.status <> '作廢' ORDER BY i.invoice_id DESC LIMIT 1) AS invoice_no
       FROM sales s LEFT JOIN customers c ON c.customer_id = s.customer_id
       ${f.where.length ? 'WHERE ' + f.where.join(' AND ') : ''}
       ORDER BY s.sale_date DESC, s.sale_id DESC`,
    ).bind(...f.binds).all();
    for (const r of results) {
      r.gross_profit = round(r.subtotal - r.discount - r.cost_amount);
      r.paid_amount = round(r.paid_amount);
      r.returned_amount = round(r.returned_amount);
      r.net_amount = round(r.total_amount - r.returned_amount);
      r.unpaid_amount = round(Math.max(0, r.net_amount - r.paid_amount));
      r.overpaid = round(Math.max(0, r.paid_amount - r.net_amount));
    }
    const summary = {
      count: results.length,
      total_amount: round(results.reduce((s, r) => s + r.total_amount, 0)),
      cost_amount: round(results.reduce((s, r) => s + r.cost_amount, 0)),
      gross_profit: round(results.reduce((s, r) => s + r.gross_profit, 0)),
      unpaid_amount: round(results.reduce((s, r) => s + r.unpaid_amount, 0)),
      roasted_kg: round(results.reduce((s, r) => s + r.roasted_kg, 0), 3),
    };
    return json({ from: f.from, to: f.to, data: results, summary });
  }

  // ---- 新增 ----
  if (!id && method === 'POST') {
    return json(await createSale(db, await readJson(request), user), 201);
  }

  if (!id) throw new HttpError(405, '不支援的操作');
  const sid = toInt(id, '銷貨單');

  if (method === 'GET') return json({ data: await getSale(db, sid) });

  // ---- 修改：整張重寫明細與異動（FIFO 重新計算）----
  if (method === 'PUT') {
    const cur = await getSale(db, sid);
    if (cur.returns.length) throw new HttpError(409, `這張銷貨單已有退貨／折讓（${cur.returns.map((r) => r.return_no).join('、')}），無法修改，請先刪除退貨單`);
    const body = await readJson(request);
    if (cur.subscription_id && body.subscription_id === undefined) body.subscription_id = cur.subscription_id;
    const p = await prepare(db, body, { excludeSaleId: sid, keepNo: cur.sale_no });
    const h = p.header;
    await db.batch([
      ...clearStatements(db, sid),
      db.prepare(
        `UPDATE sales SET sale_no = ?, sale_date = ?, customer_id = ?, channel = ?, subtotal = ?, discount = ?, shipping_fee = ?, total_amount = ?,
                cost_amount = ?, payment_method = ?, due_date = ?, note = ?, updated_at = ? WHERE sale_id = ?`,
      ).bind(h.sale_no, h.sale_date, h.customer_id, h.channel, h.subtotal, h.discount, h.shipping_fee, h.total_amount, h.cost_amount, h.payment_method, h.due_date, h.note, nowTW(), sid),
      ...itemStatements(db, p, user),
      statusStatement(db, 'sales', [sid]),
    ]);
    return json({ data: await getSale(db, sid), shortages: p.shortages });
  }

  // ---- 刪除：熟豆庫存加回；有收款沖帳時不可刪 ----
  if (method === 'DELETE') {
    const cur = await getSale(db, sid);
    if (cur.payments.length) throw new HttpError(409, `這張銷貨單已有 ${cur.payments.length} 筆收款沖帳（${cur.payments.map((x) => x.txn_no).join('、')}），請先到銀行收支刪除沖帳`);
    if (cur.returns.length) throw new HttpError(409, `這張銷貨單已有退貨／折讓（${cur.returns.map((r) => r.return_no).join('、')}），請先刪除退貨單`);
    const inv = cur.invoices.filter((i) => i.status !== '作廢');
    if (inv.length) throw new HttpError(409, `這張銷貨單已開立發票 ${inv.map((i) => i.invoice_no).join('、')}，請先作廢或刪除發票`);
    await db.batch([
      ...clearStatements(db, sid),
      db.prepare('DELETE FROM sales WHERE sale_id = ?').bind(sid),
    ]);
    return json({ ok: true });
  }

  throw new HttpError(405, '不支援的操作');
}
