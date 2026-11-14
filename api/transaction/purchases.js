// 進貨單（表頭＋明細）
// 存檔規則（ARCHITECTURE.md 8.1）：
//   1. 生豆明細 → 建立 green_bean_lots（批號）
//   2. 生豆、包材明細 → 寫入 inventory_movements（進貨入庫）
//   3. 運費＋稅額只攤給生豆，依 kg 比例攤入每 kg 成本；包材維持原單價
//   4. 付款狀態預設「未付」
//   5. 進貨單內任一生豆批號已有其他異動（烘焙、樣品…）→ 鎖定，不可修改／刪除
// 表頭、明細、批號、異動全部放在同一個 D1 batch（單一交易）。

import { HttpError, json, readJson, toInt, isDate, dateRange, nowTW, round } from '../lib/http.js';

const pad2 = (n) => String(n).padStart(2, '0');

/** 取得某日某前綴目前已用到的最大流水號 */
async function lastSeq(db, prefix, ymd) {
  const table = prefix === 'P' ? 'purchases' : 'green_bean_lots';
  const col = prefix === 'P' ? 'purchase_no' : 'lot_no';
  const seq = await db.prepare('SELECT last_no FROM doc_sequences WHERE prefix = ? AND ymd = ?').bind(prefix, ymd).first();
  const { results } = await db.prepare(`SELECT ${col} AS no FROM ${table} WHERE ${col} LIKE ?`).bind(`${prefix}${ymd}-%`).all();
  let max = seq?.last_no || 0;
  for (const r of results) {
    const m = r.no.match(/-(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

const makeNo = (prefix, ymd, n) => `${prefix}${ymd}-${pad2(n)}`;
const seqOf = (no, prefix, ymd) => {
  const m = String(no).match(new RegExp(`^${prefix}${ymd}-(\\d+)$`));
  return m ? Number(m[1]) : 0;
};

/** 驗證輸入並算出所有 auto 欄位 */
async function prepare(db, body, { excludePurchaseId = null } = {}) {
  const purchase_date = body.purchase_date;
  if (!isDate(purchase_date)) throw new HttpError(400, '進貨日期格式錯誤（YYYY-MM-DD）');
  const supplier_id = toInt(body.supplier_id, '供應商');
  const sup = await db.prepare('SELECT supplier_id FROM suppliers WHERE supplier_id = ?').bind(supplier_id).first();
  if (!sup) throw new HttpError(400, '供應商不存在');

  const num = (v, name) => {
    const n = v === undefined || v === null || v === '' ? 0 : Number(v);
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${name}必須是 0 以上的數字`);
    return n;
  };
  const shipping_fee = round(num(body.shipping_fee, '運費'));
  const tax_amount = round(num(body.tax_amount, '稅額'));
  if (body.due_date && !isDate(body.due_date)) throw new HttpError(400, '應付日期格式錯誤（YYYY-MM-DD）');

  if (!Array.isArray(body.items) || body.items.length === 0) throw new HttpError(400, '進貨單至少要有一筆明細');

  const ymd = purchase_date.replaceAll('-', '');

  // ---- 明細 ----
  const items = [];
  for (const [i, raw] of body.items.entries()) {
    const line = i + 1;
    const item_type = raw.item_type;
    if (!['生豆', '包材'].includes(item_type)) throw new HttpError(400, `第 ${line} 筆：類型必須是 生豆／包材`);
    const qty = Number(raw.qty);
    const unit_price = Number(raw.unit_price);
    if (!Number.isFinite(qty) || qty <= 0) throw new HttpError(400, `第 ${line} 筆：數量必須大於 0`);
    if (!Number.isFinite(unit_price) || unit_price < 0) throw new HttpError(400, `第 ${line} 筆：單價不可為負數`);
    const it = {
      line_no: line, item_type, qty, unit_price,
      bean_id: null, packaging_id: null,
      amount: round(qty * unit_price), alloc_amount: 0,
      lot_no: null,
      storage_location: (raw.storage_location || '').trim() || null,
      note: (raw.note || '').trim() || null,
    };
    if (item_type === '生豆') {
      it.bean_id = toInt(raw.bean_id, `第 ${line} 筆生豆品項`);
      const b = await db.prepare('SELECT bean_id FROM green_beans WHERE bean_id = ?').bind(it.bean_id).first();
      if (!b) throw new HttpError(400, `第 ${line} 筆：生豆品項不存在`);
      it.lot_no = (raw.lot_no || '').trim() || null;
    } else {
      it.packaging_id = toInt(raw.packaging_id, `第 ${line} 筆包材`);
      const p = await db.prepare('SELECT packaging_id FROM packaging_items WHERE packaging_id = ?').bind(it.packaging_id).first();
      if (!p) throw new HttpError(400, `第 ${line} 筆：包材不存在`);
    }
    items.push(it);
  }

  // ---- 攤提：運費＋稅額只攤給生豆，依 kg 比例；尾差放最後一筆生豆 ----
  const beans = items.filter((it) => it.item_type === '生豆');
  const pool = round(shipping_fee + tax_amount);
  const totalKg = beans.reduce((s, it) => s + it.qty, 0);
  if (beans.length && pool > 0) {
    let used = 0;
    beans.forEach((it, idx) => {
      it.alloc_amount = idx === beans.length - 1 ? round(pool - used) : round((pool * it.qty) / totalKg);
      used = round(used + it.alloc_amount);
    });
  }
  for (const it of items) it.landed_unit_cost = round((it.amount + it.alloc_amount) / it.qty, 4);

  // ---- 單號、批號（空白 → 自動產生；有填 → 檢查重複）----
  let purchase_no = (body.purchase_no || '').trim() || null;
  let pLast = await lastSeq(db, 'P', ymd);
  if (!purchase_no) purchase_no = makeNo('P', ymd, ++pLast);
  else {
    const dup = await db.prepare('SELECT purchase_id FROM purchases WHERE purchase_no = ?').bind(purchase_no).first();
    if (dup && dup.purchase_id !== excludePurchaseId) throw new HttpError(409, `進貨單號 ${purchase_no} 已存在`);
    pLast = Math.max(pLast, seqOf(purchase_no, 'P', ymd));
  }

  let lLast = await lastSeq(db, 'L', ymd);
  const seen = new Set();
  for (const it of beans) {
    if (it.lot_no) {
      if (seen.has(it.lot_no)) throw new HttpError(400, `批號 ${it.lot_no} 在本單重複`);
      const dup = await db.prepare(
        `SELECT pi.purchase_id FROM green_bean_lots l LEFT JOIN purchase_items pi ON pi.item_id = l.purchase_item_id WHERE l.lot_no = ?`,
      ).bind(it.lot_no).first();
      if (dup && dup.purchase_id !== excludePurchaseId) throw new HttpError(409, `批號 ${it.lot_no} 已存在`);
      seen.add(it.lot_no);
      lLast = Math.max(lLast, seqOf(it.lot_no, 'L', ymd));
    }
  }
  for (const it of beans) {
    if (!it.lot_no) {
      do { it.lot_no = makeNo('L', ymd, ++lLast); } while (seen.has(it.lot_no));
      seen.add(it.lot_no);
    }
  }

  const items_amount = round(items.reduce((s, it) => s + it.amount, 0));
  return {
    header: {
      purchase_no, purchase_date, supplier_id, items_amount, shipping_fee, tax_amount,
      total_amount: round(items_amount + shipping_fee + tax_amount),
      invoice_no: (body.invoice_no || '').trim() || null,
      due_date: body.due_date || null,
      note: (body.note || '').trim() || null,
    },
    items, ymd, pLast, lLast,
    unallocated: beans.length === 0 ? pool : 0,
  };
}

/** 明細、批號、異動的 INSERT 語句（表頭已存在或在同一 batch 較前面） */
function itemStatements(db, p, user) {
  const h = p.header;
  const PID = '(SELECT purchase_id FROM purchases WHERE purchase_no = ?)';
  const IID = `(SELECT item_id FROM purchase_items WHERE purchase_id = ${PID} AND line_no = ?)`;
  const mvDate = `${h.purchase_date} 00:00:00`;
  const stmts = [];
  for (const it of p.items) {
    stmts.push(db.prepare(
      `INSERT INTO purchase_items (purchase_id, line_no, item_type, bean_id, packaging_id, qty, unit_price, amount, alloc_amount, landed_unit_cost, note)
       VALUES (${PID}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(h.purchase_no, it.line_no, it.item_type, it.bean_id, it.packaging_id, it.qty, it.unit_price, it.amount, it.alloc_amount, it.landed_unit_cost, it.note));

    const mvAmount = round(it.amount + it.alloc_amount);
    if (it.item_type === '生豆') {
      stmts.push(db.prepare(
        `INSERT INTO green_bean_lots (lot_no, bean_id, purchase_item_id, received_date, initial_kg, unit_cost, storage_location)
         VALUES (?, ?, ${IID}, ?, ?, ?, ?)`,
      ).bind(it.lot_no, it.bean_id, h.purchase_no, it.line_no, h.purchase_date, it.qty, it.landed_unit_cost, it.storage_location));
      stmts.push(db.prepare(
        `INSERT INTO inventory_movements (movement_date, item_type, item_ref_id, movement_type, qty, unit_cost, amount, ref_doc_type, ref_doc_id, ref_item_id, note, created_by)
         VALUES (?, '生豆', (SELECT lot_id FROM green_bean_lots WHERE lot_no = ?), '進貨入庫', ?, ?, ?, 'purchases', ${PID}, ${IID}, ?, ?)`,
      ).bind(mvDate, it.lot_no, it.qty, it.landed_unit_cost, mvAmount, h.purchase_no, h.purchase_no, it.line_no, it.lot_no, user));
    } else {
      stmts.push(db.prepare(
        `INSERT INTO inventory_movements (movement_date, item_type, item_ref_id, movement_type, qty, unit_cost, amount, ref_doc_type, ref_doc_id, ref_item_id, note, created_by)
         VALUES (?, '包材', ?, '進貨入庫', ?, ?, ?, 'purchases', ${PID}, ${IID}, NULL, ?)`,
      ).bind(mvDate, it.packaging_id, it.qty, it.landed_unit_cost, mvAmount, h.purchase_no, h.purchase_no, it.line_no, user));
    }
  }
  // 流水號（只增不減，刪單後不重複使用號碼）
  const seqSql = `INSERT INTO doc_sequences (prefix, ymd, last_no) VALUES (?, ?, ?)
                  ON CONFLICT(prefix, ymd) DO UPDATE SET last_no = MAX(last_no, excluded.last_no)`;
  if (p.pLast > 0) stmts.push(db.prepare(seqSql).bind('P', p.ymd, p.pLast));
  if (p.lLast > 0) stmts.push(db.prepare(seqSql).bind('L', p.ymd, p.lLast));
  return stmts;
}

async function getPurchase(db, id) {
  const header = await db.prepare(
    `SELECT p.*, s.name AS supplier_name FROM purchases p JOIN suppliers s ON s.supplier_id = p.supplier_id WHERE p.purchase_id = ?`,
  ).bind(id).first();
  if (!header) throw new HttpError(404, '找不到進貨單');
  const { results: items } = await db.prepare(
    `SELECT pi.*, b.name AS bean_name, k.name AS packaging_name, k.unit AS packaging_unit,
            l.lot_id, l.lot_no, l.storage_location, v.current_kg, v.other_movement_count
     FROM purchase_items pi
     LEFT JOIN green_beans b ON b.bean_id = pi.bean_id
     LEFT JOIN packaging_items k ON k.packaging_id = pi.packaging_id
     LEFT JOIN green_bean_lots l ON l.purchase_item_id = pi.item_id
     LEFT JOIN v_green_bean_lot_stock v ON v.lot_id = l.lot_id
     WHERE pi.purchase_id = ? ORDER BY pi.line_no`,
  ).bind(id).all();
  header.items = items;
  header.locked = items.some((it) => (it.other_movement_count || 0) > 0);
  return header;
}

async function assertEditable(db, id) {
  const p = await getPurchase(db, id);
  if (p.locked) {
    const lots = p.items.filter((it) => (it.other_movement_count || 0) > 0).map((it) => it.lot_no).join('、');
    throw new HttpError(409, `此進貨單的生豆批號（${lots}）已被使用，無法修改或刪除`);
  }
  if (p.payment_status !== '未付') throw new HttpError(409, '此進貨單已有付款紀錄，無法修改或刪除');
  return p;
}

/** 清除進貨單的明細、批號、異動（表頭保留） */
function clearStatements(db, id) {
  return [
    db.prepare("DELETE FROM inventory_movements WHERE ref_doc_type = 'purchases' AND ref_doc_id = ?").bind(id),
    db.prepare('DELETE FROM green_bean_lots WHERE purchase_item_id IN (SELECT item_id FROM purchase_items WHERE purchase_id = ?)').bind(id),
    db.prepare('DELETE FROM purchase_items WHERE purchase_id = ?').bind(id),
  ];
}

export async function handlePurchases(id, request, env, user) {
  const db = env.DB;
  const url = new URL(request.url);
  const method = request.method;

  // ---- 預覽下一個單號／批號起始號 ----
  if (id === 'next-no' && method === 'GET') {
    const date = url.searchParams.get('date');
    if (!isDate(date)) throw new HttpError(400, '日期格式錯誤');
    const ymd = date.replaceAll('-', '');
    const p = await lastSeq(db, 'P', ymd);
    const l = await lastSeq(db, 'L', ymd);
    return json({ data: { purchase_no: makeNo('P', ymd, p + 1), lot_prefix: `L${ymd}-`, next_lot_seq: l + 1 } });
  }

  // ---- 進貨查詢（日期區間、供應商、生豆品項）----
  if (!id && method === 'GET') {
    const { from, to } = dateRange(url);
    const where = [];
    const binds = [];
    if (from) { where.push('p.purchase_date >= ?'); binds.push(from); }
    if (to) { where.push('p.purchase_date <= ?'); binds.push(to); }
    const sid = url.searchParams.get('supplier_id');
    if (sid) { where.push('p.supplier_id = ?'); binds.push(toInt(sid, '供應商')); }
    const bid = url.searchParams.get('bean_id');
    if (bid) {
      where.push('EXISTS (SELECT 1 FROM purchase_items x WHERE x.purchase_id = p.purchase_id AND x.bean_id = ?)');
      binds.push(toInt(bid, '生豆品項'));
    }
    const { results } = await db.prepare(
      `SELECT p.*, s.name AS supplier_name,
              (SELECT COUNT(*) FROM purchase_items x WHERE x.purchase_id = p.purchase_id) AS item_count,
              (SELECT COALESCE(SUM(x.qty), 0) FROM purchase_items x WHERE x.purchase_id = p.purchase_id AND x.item_type = '生豆') AS bean_kg
       FROM purchases p JOIN suppliers s ON s.supplier_id = p.supplier_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY p.purchase_date DESC, p.purchase_id DESC`,
    ).bind(...binds).all();
    const summary = {
      count: results.length,
      total_amount: round(results.reduce((s, r) => s + r.total_amount, 0)),
      unpaid_amount: round(results.filter((r) => r.payment_status !== '已付清').reduce((s, r) => s + r.total_amount, 0)),
      bean_kg: round(results.reduce((s, r) => s + r.bean_kg, 0), 3),
    };
    return json({ data: results, summary });
  }

  // ---- 新增 ----
  if (!id && method === 'POST') {
    const p = await prepare(db, await readJson(request));
    const h = p.header;
    await db.batch([
      db.prepare(
        `INSERT INTO purchases (purchase_no, purchase_date, supplier_id, items_amount, shipping_fee, tax_amount, total_amount, invoice_no, payment_status, due_date, note, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '未付', ?, ?, ?)`,
      ).bind(h.purchase_no, h.purchase_date, h.supplier_id, h.items_amount, h.shipping_fee, h.tax_amount, h.total_amount, h.invoice_no, h.due_date, h.note, user),
      ...itemStatements(db, p, user),
    ]);
    const row = await db.prepare('SELECT purchase_id FROM purchases WHERE purchase_no = ?').bind(h.purchase_no).first();
    return json({ data: await getPurchase(db, row.purchase_id), unallocated: p.unallocated }, 201);
  }

  if (!id) throw new HttpError(405, '不支援的操作');
  const pid = toInt(id, '進貨單');

  if (method === 'GET') return json({ data: await getPurchase(db, pid) });

  // ---- 修改：批號未被使用才可改；整張重寫明細、批號、異動 ----
  if (method === 'PUT') {
    await assertEditable(db, pid);
    const p = await prepare(db, await readJson(request), { excludePurchaseId: pid });
    const h = p.header;
    await db.batch([
      ...clearStatements(db, pid),
      db.prepare(
        `UPDATE purchases SET purchase_no = ?, purchase_date = ?, supplier_id = ?, items_amount = ?, shipping_fee = ?, tax_amount = ?,
                total_amount = ?, invoice_no = ?, due_date = ?, note = ?, updated_at = ? WHERE purchase_id = ?`,
      ).bind(h.purchase_no, h.purchase_date, h.supplier_id, h.items_amount, h.shipping_fee, h.tax_amount, h.total_amount, h.invoice_no, h.due_date, h.note, nowTW(), pid),
      ...itemStatements(db, p, user),
    ]);
    return json({ data: await getPurchase(db, pid), unallocated: p.unallocated });
  }

  // ---- 刪除 ----
  if (method === 'DELETE') {
    await assertEditable(db, pid);
    await db.batch([
      ...clearStatements(db, pid),
      db.prepare('DELETE FROM purchases WHERE purchase_id = ?').bind(pid),
    ]);
    return json({ ok: true });
  }

  throw new HttpError(405, '不支援的操作');
}
