// 退貨／折讓（銷貨退回、銷貨折讓、進貨退出）
// 規則（ARCHITECTURE.md 8.7）：
//   1. 一張退貨單掛在一張原單上：銷貨退回／折讓 → sale_id；進貨退出 → purchase_id
//   2. 原單淨額 = 原單合計 − 退貨／折讓合計，收付款狀態依淨額重算（lib/payment.js）
//      客戶已付清的部分變成「應退客戶」→ 銀行收支登錄出帳並沖銷原銷貨單（退款）
//      供應商已付清的部分變成「供應商應退」→ 銀行收支登錄入帳並沖銷原進貨單
//   3. 銷貨退回：選原銷貨明細與退回數量（不可超過已售 − 已退）
//      restock = 是 → 熟豆依原出貨批次（從最後扣的批次往回）加回庫存（movement_type 退貨，+kg）；包材不回補
//      restock = 否 → 不回補（例：客戶已開封）
//   4. 銷貨折讓：只有金額，不動庫存
//   5. 進貨退出：選原進貨明細（生豆批號／包材）與退出數量 → 扣庫存（退貨，−數量，入庫成本）；
//      不可超過目前庫存與已進 − 已退
//   6. 金額預設 = 數量 × 原單價，可修改；退貨合計不可超過原單淨額
// 退貨單、明細、庫存異動、原單狀態在同一個 D1 batch。

import { HttpError, json, readJson, toInt, isDate, dateRange, nowTW, round } from '../lib/http.js';
import { makeNo, seqOf, lastSeq, seqStatement } from '../lib/docno.js';
import { statusStatement, docBalance } from '../lib/payment.js';

export const RETURN_TYPES = ['銷貨退回', '銷貨折讓', '進貨退出'];
const EPS = 0.0005;

async function prepare(db, body, { excludeId = null, keepNo = null } = {}) {
  const return_type = body.return_type;
  if (!RETURN_TYPES.includes(return_type)) throw new HttpError(400, `類型必須是：${RETURN_TYPES.join('／')}`);
  if (!isDate(body.return_date)) throw new HttpError(400, '日期格式錯誤（YYYY-MM-DD）');
  const ex = excludeId ?? -1;
  const isSale = return_type !== '進貨退出';
  const restock = return_type === '銷貨退回' ? (body.restock === false || body.restock === 0 || body.restock === '0' ? 0 : 1) : 0;
  const items = [];
  let sale_id = null;
  let purchase_id = null;
  let docDate;

  if (isSale) {
    sale_id = toInt(body.sale_id, '原銷貨單');
    const sale = await db.prepare('SELECT sale_id, sale_no, sale_date FROM sales WHERE sale_id = ?').bind(sale_id).first();
    if (!sale) throw new HttpError(400, '原銷貨單不存在');
    docDate = sale.sale_date;
  } else {
    purchase_id = toInt(body.purchase_id, '原進貨單');
    const pur = await db.prepare('SELECT purchase_id, purchase_no, purchase_date FROM purchases WHERE purchase_id = ?').bind(purchase_id).first();
    if (!pur) throw new HttpError(400, '原進貨單不存在');
    docDate = pur.purchase_date;
  }
  if (body.return_date < docDate) throw new HttpError(400, `退貨日期不可早於原單日期 ${docDate}`);

  if (return_type === '銷貨退回') {
    for (const [i, raw] of (Array.isArray(body.items) ? body.items : []).entries()) {
      const qty = Number(raw.qty);
      if (!qty) continue;
      const line = i + 1;
      if (!Number.isInteger(qty) || qty < 0) throw new HttpError(400, `第 ${line} 筆：退回數量必須是整數`);
      const sale_item_id = toInt(raw.sale_item_id, `第 ${line} 筆銷貨明細`);
      const si = await db.prepare(
        `SELECT si.item_id, si.qty, si.unit_price, si.deduct_kg, p.name, p.net_weight_g, p.roasted_bean_id,
                COALESCE((SELECT SUM(ri.qty) FROM return_items ri JOIN returns r ON r.return_id = ri.return_id
                          WHERE ri.sale_item_id = si.item_id AND r.return_id <> ?), 0) AS returned
         FROM sale_items si JOIN products p ON p.product_id = si.product_id
         WHERE si.item_id = ? AND si.sale_id = ?`,
      ).bind(ex, sale_item_id, sale_id).first();
      if (!si) throw new HttpError(400, `第 ${line} 筆：不是這張銷貨單的明細`);
      if (qty > si.qty - si.returned) throw new HttpError(400, `「${si.name}」已售 ${si.qty}、已退 ${si.returned}，最多只能再退 ${si.qty - si.returned}`);
      const unit_price = raw.unit_price === undefined || raw.unit_price === '' ? si.unit_price : Number(raw.unit_price);
      if (!Number.isFinite(unit_price) || unit_price < 0) throw new HttpError(400, `第 ${line} 筆：單價不可為負數`);
      const it = { line_no: items.length + 1, sale_item_id, qty, unit_price, amount: round(qty * unit_price), restock_kg: 0, cost_amount: 0, moves: [] };
      if (restock && si.roasted_bean_id && si.net_weight_g > 0) {
        // 依原出貨批次加回：從最後扣的批次往回，每批最多加回當初扣的 kg
        let need = round((qty * si.net_weight_g) / 1000, 3);
        const { results: outs } = await db.prepare(
          `SELECT m.item_ref_id AS lot_id, -m.qty AS kg, m.unit_cost FROM inventory_movements m
           WHERE m.ref_doc_type = 'sales' AND m.ref_doc_id = ? AND m.ref_item_id = ? AND m.item_type = '熟豆' ORDER BY m.movement_id DESC`,
        ).bind(sale_id, sale_item_id).all();
        for (const o of outs) {
          if (need <= EPS) break;
          const kg = round(Math.min(need, o.kg), 3);
          it.moves.push({ item_type: '熟豆', ref: o.lot_id, qty: kg, unit_cost: o.unit_cost, amount: round(kg * o.unit_cost) });
          need = round(need - kg, 3);
        }
        it.restock_kg = round(it.moves.reduce((s, m) => s + m.qty, 0), 3);
        it.cost_amount = round(it.moves.reduce((s, m) => s + m.amount, 0));
      }
      items.push(it);
    }
    if (!items.length) throw new HttpError(400, '請至少輸入一筆退回數量');
  } else if (return_type === '進貨退出') {
    for (const [i, raw] of (Array.isArray(body.items) ? body.items : []).entries()) {
      const qty = round(Number(raw.qty), 3);
      if (!qty) continue;
      const line = i + 1;
      if (!Number.isFinite(qty) || qty < 0) throw new HttpError(400, `第 ${line} 筆：退出數量不可為負數`);
      const purchase_item_id = toInt(raw.purchase_item_id, `第 ${line} 筆進貨明細`);
      const pi = await db.prepare(
        `SELECT pi.item_id, pi.item_type, pi.packaging_id, pi.qty, pi.unit_price, pi.landed_unit_cost,
                COALESCE(b.name, k.name) AS name, l.lot_id, l.lot_no,
                COALESCE((SELECT SUM(ri.qty) FROM return_items ri JOIN returns r ON r.return_id = ri.return_id
                          WHERE ri.purchase_item_id = pi.item_id AND r.return_id <> ?), 0) AS returned
         FROM purchase_items pi
         LEFT JOIN green_beans b ON b.bean_id = pi.bean_id
         LEFT JOIN packaging_items k ON k.packaging_id = pi.packaging_id
         LEFT JOIN green_bean_lots l ON l.purchase_item_id = pi.item_id
         WHERE pi.item_id = ? AND pi.purchase_id = ?`,
      ).bind(ex, purchase_item_id, purchase_id).first();
      if (!pi) throw new HttpError(400, `第 ${line} 筆：不是這張進貨單的明細`);
      if (qty > pi.qty - pi.returned + EPS) throw new HttpError(400, `「${pi.name}」已進 ${pi.qty}、已退 ${pi.returned}，最多只能再退 ${round(pi.qty - pi.returned, 3)}`);
      const isBean = pi.item_type === '生豆';
      const ref = isBean ? pi.lot_id : pi.packaging_id;
      const st = await db.prepare(
        `SELECT COALESCE(SUM(qty), 0) AS q FROM inventory_movements
         WHERE item_type = ? AND item_ref_id = ? AND (ref_doc_type IS NOT 'returns' OR ref_doc_id IS NOT ?)`,
      ).bind(isBean ? '生豆' : '包材', ref, ex).first();
      if (qty > st.q + EPS) throw new HttpError(409, `「${pi.name}」${isBean ? `批號 ${pi.lot_no} ` : ''}目前庫存只剩 ${round(st.q, 3)}，不可退出 ${qty}`);
      const unit_price = raw.unit_price === undefined || raw.unit_price === '' ? pi.unit_price : Number(raw.unit_price);
      if (!Number.isFinite(unit_price) || unit_price < 0) throw new HttpError(400, `第 ${line} 筆：單價不可為負數`);
      const cost = round(qty * pi.landed_unit_cost);
      items.push({
        line_no: items.length + 1, purchase_item_id, qty, unit_price, amount: round(qty * unit_price), restock_kg: 0, cost_amount: cost,
        moves: [{ item_type: isBean ? '生豆' : '包材', ref, qty: -qty, unit_cost: pi.landed_unit_cost, amount: -cost }],
      });
    }
    if (!items.length) throw new HttpError(400, '請至少輸入一筆退出數量');
  }

  const total_amount = return_type === '銷貨折讓' ? round(Number(body.total_amount)) : round(items.reduce((s, it) => s + it.amount, 0));
  if (!Number.isFinite(total_amount) || total_amount <= 0) throw new HttpError(400, return_type === '銷貨折讓' ? '折讓金額必須大於 0' : '退貨金額必須大於 0');
  // 退貨合計不可超過原單淨額（扣掉其他退貨單）
  const bal = await docBalance(db, isSale ? 'sales' : 'purchases', isSale ? sale_id : purchase_id);
  const others = await db.prepare(`SELECT COALESCE(SUM(total_amount), 0) AS s FROM returns WHERE return_id = ?`).bind(ex).first();
  const room = round(bal.net + others.s);
  if (total_amount > room + 0.005) throw new HttpError(400, `退貨／折讓金額 ${total_amount} 超過原單可退金額 ${room}`);

  const ymd = body.return_date.replaceAll('-', '');
  let return_no = (body.return_no || '').trim() || keepNo || null;
  let rLast = await lastSeq(db, 'RT', ymd);
  if (!return_no) return_no = makeNo('RT', ymd, ++rLast);
  else {
    const dup = await db.prepare('SELECT return_id FROM returns WHERE return_no = ?').bind(return_no).first();
    if (dup && dup.return_id !== excludeId) throw new HttpError(409, `退貨單號 ${return_no} 已存在`);
    rLast = Math.max(rLast, seqOf(return_no, 'RT', ymd));
  }
  return {
    header: {
      return_no, return_date: body.return_date, return_type, sale_id, purchase_id, restock, total_amount,
      cost_amount: round(items.reduce((s, it) => s + it.cost_amount, 0)),
      reason: (body.reason || '').trim() || null, note: (body.note || '').trim() || null,
    },
    items, ymd, rLast,
  };
}

const COLS = ['return_no', 'return_date', 'return_type', 'sale_id', 'purchase_id', 'restock', 'total_amount', 'cost_amount', 'reason', 'note'];

function detailStatements(db, p, user) {
  const h = p.header;
  const RID = '(SELECT return_id FROM returns WHERE return_no = ?)';
  const stmts = [];
  for (const it of p.items) {
    stmts.push(db.prepare(
      `INSERT INTO return_items (return_id, line_no, sale_item_id, purchase_item_id, qty, unit_price, amount, restock_kg, cost_amount)
       VALUES (${RID}, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(h.return_no, it.line_no, it.sale_item_id || null, it.purchase_item_id || null, it.qty, it.unit_price, it.amount, it.restock_kg, it.cost_amount));
    for (const m of it.moves) {
      stmts.push(db.prepare(
        `INSERT INTO inventory_movements (movement_date, item_type, item_ref_id, movement_type, qty, unit_cost, amount, ref_doc_type, ref_doc_id, ref_item_id, note, created_by)
         VALUES (?, ?, ?, '退貨', ?, ?, ?, 'returns', ${RID}, (SELECT item_id FROM return_items WHERE return_id = ${RID} AND line_no = ?), ?, ?)`,
      ).bind(`${h.return_date} 00:00:00`, m.item_type, m.ref, m.qty, m.unit_cost, m.amount, h.return_no, h.return_no, it.line_no, h.return_no, user));
    }
  }
  if (p.rLast > 0) stmts.push(seqStatement(db, 'RT', p.ymd, p.rLast));
  stmts.push(h.sale_id ? statusStatement(db, 'sales', [h.sale_id]) : statusStatement(db, 'purchases', [h.purchase_id]));
  return stmts;
}

async function getReturn(db, id) {
  const r = await db.prepare(
    `SELECT r.*, s.sale_no, s.sale_date, c.name AS customer_name, p.purchase_no, p.purchase_date, sp.name AS supplier_name
     FROM returns r
     LEFT JOIN sales s ON s.sale_id = r.sale_id LEFT JOIN customers c ON c.customer_id = s.customer_id
     LEFT JOIN purchases p ON p.purchase_id = r.purchase_id LEFT JOIN suppliers sp ON sp.supplier_id = p.supplier_id
     WHERE r.return_id = ?`,
  ).bind(id).first();
  if (!r) throw new HttpError(404, '找不到退貨單');
  const { results } = await db.prepare(
    `SELECT ri.*, COALESCE(pr.name, b.name, k.name) AS item_name, l.lot_no
     FROM return_items ri
     LEFT JOIN sale_items si ON si.item_id = ri.sale_item_id LEFT JOIN products pr ON pr.product_id = si.product_id
     LEFT JOIN purchase_items pi ON pi.item_id = ri.purchase_item_id
     LEFT JOIN green_beans b ON b.bean_id = pi.bean_id LEFT JOIN packaging_items k ON k.packaging_id = pi.packaging_id
     LEFT JOIN green_bean_lots l ON l.purchase_item_id = pi.item_id
     WHERE ri.return_id = ? ORDER BY ri.line_no`,
  ).bind(id).all();
  r.items = results;
  return r;
}

/** 開退貨單用：原單明細與可退數量 */
async function sourceLines(db, url) {
  const sp = url.searchParams;
  const ex = sp.get('exclude_return_id') ? toInt(sp.get('exclude_return_id'), '退貨單') : -1;
  if (sp.get('sale_id')) {
    const sid = toInt(sp.get('sale_id'), '銷貨單');
    const { results } = await db.prepare(
      `SELECT si.item_id AS sale_item_id, si.line_no, p.name, si.grind_size, si.qty, si.unit_price, p.net_weight_g, p.roasted_bean_id,
              COALESCE((SELECT SUM(ri.qty) FROM return_items ri WHERE ri.sale_item_id = si.item_id AND ri.return_id <> ?), 0) AS returned
       FROM sale_items si JOIN products p ON p.product_id = si.product_id WHERE si.sale_id = ? ORDER BY si.line_no`,
    ).bind(ex, sid).all();
    const bal = await docBalance(db, 'sales', sid);
    return json({ data: results.map((r) => ({ ...r, returnable: r.qty - r.returned })), balance: bal });
  }
  if (sp.get('purchase_id')) {
    const pid = toInt(sp.get('purchase_id'), '進貨單');
    const { results } = await db.prepare(
      `SELECT pi.item_id AS purchase_item_id, pi.line_no, pi.item_type, COALESCE(b.name, k.name) AS name, l.lot_no, pi.qty, pi.unit_price, pi.landed_unit_cost,
              COALESCE(k.unit, 'kg') AS unit,
              COALESCE((SELECT SUM(ri.qty) FROM return_items ri WHERE ri.purchase_item_id = pi.item_id AND ri.return_id <> ?), 0) AS returned,
              COALESCE((SELECT SUM(m.qty) FROM inventory_movements m
                        WHERE m.item_type = pi.item_type AND m.item_ref_id = CASE WHEN pi.item_type = '生豆' THEN l.lot_id ELSE pi.packaging_id END
                          AND (m.ref_doc_type IS NOT 'returns' OR m.ref_doc_id IS NOT ?)), 0) AS stock
       FROM purchase_items pi
       LEFT JOIN green_beans b ON b.bean_id = pi.bean_id LEFT JOIN packaging_items k ON k.packaging_id = pi.packaging_id
       LEFT JOIN green_bean_lots l ON l.purchase_item_id = pi.item_id
       WHERE pi.purchase_id = ? ORDER BY pi.line_no`,
    ).bind(ex, ex, pid).all();
    const bal = await docBalance(db, 'purchases', pid);
    return json({ data: results.map((r) => ({ ...r, stock: round(r.stock, 3), returnable: round(Math.min(r.qty - r.returned, Math.max(0, r.stock)), 3) })), balance: bal });
  }
  throw new HttpError(400, '請指定 sale_id 或 purchase_id');
}

export async function handleReturns(id, request, env, user) {
  const db = env.DB;
  const url = new URL(request.url);
  const method = request.method;

  if (id === 'source' && method === 'GET') return sourceLines(db, url);

  if (!id && method === 'GET') {
    const { from, to } = dateRange(url);
    const sp = url.searchParams;
    const where = [];
    const binds = [];
    if (from) { where.push('r.return_date >= ?'); binds.push(from); }
    if (to) { where.push('r.return_date <= ?'); binds.push(to); }
    if (sp.get('return_type')) { where.push('r.return_type = ?'); binds.push(sp.get('return_type')); }
    if (sp.get('customer_id')) { where.push('s.customer_id = ?'); binds.push(toInt(sp.get('customer_id'), '客戶')); }
    if (sp.get('supplier_id')) { where.push('p.supplier_id = ?'); binds.push(toInt(sp.get('supplier_id'), '供應商')); }
    if (sp.get('sale_id')) { where.push('r.sale_id = ?'); binds.push(toInt(sp.get('sale_id'), '銷貨單')); }
    if (sp.get('purchase_id')) { where.push('r.purchase_id = ?'); binds.push(toInt(sp.get('purchase_id'), '進貨單')); }
    const { results } = await db.prepare(
      `SELECT r.*, s.sale_no, COALESCE(c.name, CASE WHEN r.sale_id IS NOT NULL THEN '散客' END) AS customer_name, p.purchase_no, sp.name AS supplier_name,
              (SELECT GROUP_CONCAT(COALESCE(pr.name, b.name, k.name) || ' × ' || printf('%g', ri.qty), '、')
                 FROM return_items ri
                 LEFT JOIN sale_items si ON si.item_id = ri.sale_item_id LEFT JOIN products pr ON pr.product_id = si.product_id
                 LEFT JOIN purchase_items pi ON pi.item_id = ri.purchase_item_id
                 LEFT JOIN green_beans b ON b.bean_id = pi.bean_id LEFT JOIN packaging_items k ON k.packaging_id = pi.packaging_id
                 WHERE ri.return_id = r.return_id) AS items_text
       FROM returns r
       LEFT JOIN sales s ON s.sale_id = r.sale_id LEFT JOIN customers c ON c.customer_id = s.customer_id
       LEFT JOIN purchases p ON p.purchase_id = r.purchase_id LEFT JOIN suppliers sp ON sp.supplier_id = p.supplier_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY r.return_date DESC, r.return_id DESC`,
    ).bind(...binds).all();
    const sum = (t) => round(results.filter((r) => r.return_type === t).reduce((s2, r) => s2 + r.total_amount, 0));
    return json({ from, to, data: results, summary: { count: results.length, sales_return: sum('銷貨退回'), allowance: sum('銷貨折讓'), purchase_return: sum('進貨退出') } });
  }

  if (!id && method === 'POST') {
    const p = await prepare(db, await readJson(request));
    await db.batch([
      db.prepare(`INSERT INTO returns (${COLS.join(', ')}, created_by) VALUES (${COLS.map(() => '?').join(', ')}, ?)`).bind(...COLS.map((c) => p.header[c]), user),
      ...detailStatements(db, p, user),
    ]);
    const row = await db.prepare('SELECT return_id FROM returns WHERE return_no = ?').bind(p.header.return_no).first();
    return json({ data: await getReturn(db, row.return_id) }, 201);
  }

  if (!id) throw new HttpError(405, '不支援的操作');
  const rid = toInt(id, '退貨單');
  if (method === 'GET') return json({ data: await getReturn(db, rid) });

  const clear = (cur) => [
    db.prepare("DELETE FROM inventory_movements WHERE ref_doc_type = 'returns' AND ref_doc_id = ?").bind(rid),
    db.prepare('DELETE FROM return_items WHERE return_id = ?').bind(rid),
  ];
  if (method === 'PUT') {
    const cur = await getReturn(db, rid);
    const body = await readJson(request);
    body.return_type = cur.return_type; body.sale_id = cur.sale_id; body.purchase_id = cur.purchase_id; // 類型與原單不可改
    const p = await prepare(db, body, { excludeId: rid, keepNo: cur.return_no });
    await db.batch([
      ...clear(cur),
      db.prepare(`UPDATE returns SET ${COLS.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE return_id = ?`).bind(...COLS.map((c) => p.header[c]), nowTW(), rid),
      ...detailStatements(db, p, user),
    ]);
    return json({ data: await getReturn(db, rid) });
  }
  if (method === 'DELETE') {
    const cur = await getReturn(db, rid);
    await db.batch([
      ...clear(cur),
      db.prepare('DELETE FROM returns WHERE return_id = ?').bind(rid),
      cur.sale_id ? statusStatement(db, 'sales', [cur.sale_id]) : statusStatement(db, 'purchases', [cur.purchase_id]),
    ]);
    return json({ ok: true });
  }
  throw new HttpError(405, '不支援的操作');
}
