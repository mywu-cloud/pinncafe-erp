// 盤點／庫存調整
//   盤點：選類型（生豆批號／熟豆批次／包材）與盤點日，帳面數量 = 盤點日當天結束的庫存，
//         輸入實際數量 → 差異 > 0 盤盈（+）、< 0 盤虧（−），以單位成本寫入 inventory_movements
//   調整：試喝／樣品／報廢 → 出庫（−數量）
//   單位成本：生豆 = 批號成本、熟豆 = 熟豆批次成本、包材 = 移動平均成本（無庫存時用主檔參考單價）
//   修改 = 整張重寫明細與異動；刪除 = 異動一起刪
//   注意：盤點／調整的異動會讓相關進貨單、烘焙批次鎖定（跟其他使用一樣）

import { HttpError, json, readJson, toInt, isDate, dateRange, nowTW, round } from '../lib/http.js';
import { makeNo, seqOf, lastSeq, seqStatement } from '../lib/docno.js';

const ITEM_TYPES = ['生豆', '熟豆', '包材'];
const ADJ_REASONS = ['試喝', '樣品', '報廢'];
const EPS = 0.0005;

const dayAfter = (d) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };

/** 某類型在某日（含）結束時的庫存清單（排除某張盤點單自己的異動） */
async function sheet(db, itemType, date, excludeCountId = -1) {
  const upper = dayAfter(date);
  const mv = `LEFT JOIN inventory_movements m ON m.item_type = '${itemType}' AND m.item_ref_id = %ID% AND m.movement_date < ?
              AND (m.ref_doc_type IS NOT 'stock_counts' OR m.ref_doc_id IS NOT ?)`;
  let sql;
  if (itemType === '生豆') {
    sql = `SELECT l.lot_id AS item_ref_id, l.lot_no AS code, b.name, 'kg' AS unit, l.unit_cost, l.storage_location AS info,
                  COALESCE(SUM(m.qty), 0) AS system_qty, COALESCE(SUM(m.amount), 0) AS system_amount
           FROM green_bean_lots l JOIN green_beans b ON b.bean_id = l.bean_id ${mv.replace('%ID%', 'l.lot_id')}
           WHERE l.received_date <= ? GROUP BY l.lot_id ORDER BY b.name, l.received_date`;
  } else if (itemType === '熟豆') {
    sql = `SELECT rl.roasted_lot_id AS item_ref_id, rb.batch_no AS code, n.name, 'kg' AS unit, rl.unit_cost, rl.best_before AS info,
                  COALESCE(SUM(m.qty), 0) AS system_qty, COALESCE(SUM(m.amount), 0) AS system_amount
           FROM roasted_lots rl JOIN roast_batches rb ON rb.batch_id = rl.batch_id JOIN roasted_beans n ON n.roasted_bean_id = rl.roasted_bean_id
           ${mv.replace('%ID%', 'rl.roasted_lot_id')}
           WHERE rl.roast_date <= ? GROUP BY rl.roasted_lot_id ORDER BY n.name, rl.roast_date`;
  } else {
    sql = `SELECT k.packaging_id AS item_ref_id, '' AS code, k.name, k.unit, k.unit_cost AS ref_cost, NULL AS info,
                  COALESCE(SUM(m.qty), 0) AS system_qty, COALESCE(SUM(m.amount), 0) AS system_amount
           FROM packaging_items k ${mv.replace('%ID%', 'k.packaging_id')}
           GROUP BY k.packaging_id ORDER BY k.is_active DESC, k.name`;
  }
  const { results } = await db.prepare(sql).bind(upper, excludeCountId, ...(itemType === '包材' ? [] : [date])).all();
  for (const r of results) {
    r.system_qty = round(r.system_qty, 3);
    if (itemType === '包材') r.unit_cost = r.system_qty > EPS ? round(r.system_amount / r.system_qty, 4) : (r.ref_cost || 0);
  }
  return results;
}

async function prepare(db, body, { excludeId = null, keepNo = null } = {}) {
  const count_type = body.count_type;
  if (!['盤點', '調整'].includes(count_type)) throw new HttpError(400, '類型必須是 盤點／調整');
  const item_type = body.item_type;
  if (!ITEM_TYPES.includes(item_type)) throw new HttpError(400, `品項類型必須是：${ITEM_TYPES.join('／')}`);
  if (!isDate(body.count_date)) throw new HttpError(400, '日期格式錯誤（YYYY-MM-DD）');
  const rows = await sheet(db, item_type, body.count_date, excludeId ?? -1);
  const byId = new Map(rows.map((r) => [r.item_ref_id, r]));
  const items = [];
  for (const [i, raw] of (Array.isArray(body.items) ? body.items : []).entries()) {
    const line = i + 1;
    const ref = Number(raw.item_ref_id);
    const r = byId.get(ref);
    if (!r) throw new HttpError(400, `第 ${line} 筆：品項不存在，或在 ${body.count_date} 之後才入庫`);
    if (count_type === '盤點') {
      if (raw.actual_qty === undefined || raw.actual_qty === null || raw.actual_qty === '') continue; // 沒填 = 不盤
      const actual = round(Number(raw.actual_qty), 3);
      if (!Number.isFinite(actual) || actual < 0) throw new HttpError(400, `第 ${line} 筆：實際數量不可為負數`);
      const diff = round(actual - r.system_qty, 3);
      items.push({ item_ref_id: ref, system_qty: r.system_qty, actual_qty: actual, diff_qty: diff, reason: diff >= 0 ? '盤盈' : '盤虧', unit_cost: r.unit_cost, amount: round(diff * r.unit_cost), note: (raw.note || '').trim() || null });
    } else {
      const qty = round(Number(raw.qty), 3);
      if (!qty) continue;
      if (!Number.isFinite(qty) || qty < 0) throw new HttpError(400, `第 ${line} 筆：數量必須大於 0`);
      if (!ADJ_REASONS.includes(raw.reason)) throw new HttpError(400, `第 ${line} 筆：原因必須是：${ADJ_REASONS.join('／')}`);
      items.push({ item_ref_id: ref, system_qty: r.system_qty, actual_qty: null, diff_qty: -qty, reason: raw.reason, unit_cost: r.unit_cost, amount: round(-qty * r.unit_cost), note: (raw.note || '').trim() || null });
    }
  }
  if (!items.length) throw new HttpError(400, count_type === '盤點' ? '請至少輸入一筆實際數量' : '請至少輸入一筆調整數量');

  const ymd = body.count_date.replaceAll('-', '');
  let count_no = (body.count_no || '').trim() || keepNo || null;
  let cLast = await lastSeq(db, 'C', ymd);
  if (!count_no) count_no = makeNo('C', ymd, ++cLast);
  else {
    const dup = await db.prepare('SELECT count_id FROM stock_counts WHERE count_no = ?').bind(count_no).first();
    if (dup && dup.count_id !== excludeId) throw new HttpError(409, `單號 ${count_no} 已存在`);
    cLast = Math.max(cLast, seqOf(count_no, 'C', ymd));
  }
  return { header: { count_no, count_date: body.count_date, count_type, item_type, note: (body.note || '').trim() || null }, items, ymd, cLast };
}

function detailStatements(db, p, user) {
  const h = p.header;
  const CID = '(SELECT count_id FROM stock_counts WHERE count_no = ?)';
  const stmts = [];
  for (const it of p.items) {
    stmts.push(db.prepare(
      `INSERT INTO stock_count_items (count_id, item_ref_id, system_qty, actual_qty, diff_qty, reason, unit_cost, amount, note) VALUES (${CID}, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(h.count_no, it.item_ref_id, it.system_qty, it.actual_qty, it.diff_qty, it.reason, it.unit_cost, it.amount, it.note));
    if (Math.abs(it.diff_qty) > EPS) {
      stmts.push(db.prepare(
        `INSERT INTO inventory_movements (movement_date, item_type, item_ref_id, movement_type, qty, unit_cost, amount, ref_doc_type, ref_doc_id, ref_item_id, note, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'stock_counts', ${CID}, (SELECT MAX(item_id) FROM stock_count_items WHERE count_id = ${CID}), ?, ?)`,
      ).bind(`${h.count_date} 00:00:00`, h.item_type, it.item_ref_id, it.reason, it.diff_qty, it.unit_cost, it.amount, h.count_no, h.count_no, it.note || h.count_no, user));
    }
  }
  if (p.cLast > 0) stmts.push(seqStatement(db, 'C', p.ymd, p.cLast));
  return stmts;
}

async function getCount(db, id) {
  const c = await db.prepare('SELECT * FROM stock_counts WHERE count_id = ?').bind(id).first();
  if (!c) throw new HttpError(404, '找不到盤點／調整單');
  const nameSql = {
    生豆: `SELECT l.lot_no AS code, b.name FROM green_bean_lots l JOIN green_beans b ON b.bean_id = l.bean_id WHERE l.lot_id = ?`,
    熟豆: `SELECT rb.batch_no AS code, n.name FROM roasted_lots rl JOIN roast_batches rb ON rb.batch_id = rl.batch_id JOIN roasted_beans n ON n.roasted_bean_id = rl.roasted_bean_id WHERE rl.roasted_lot_id = ?`,
    包材: `SELECT '' AS code, name FROM packaging_items WHERE packaging_id = ?`,
  }[c.item_type];
  const { results } = await db.prepare('SELECT * FROM stock_count_items WHERE count_id = ? ORDER BY item_id').bind(id).all();
  for (const r of results) Object.assign(r, await db.prepare(nameSql).bind(r.item_ref_id).first());
  c.items = results;
  c.diff_amount = round(results.reduce((s, r) => s + r.amount, 0));
  return c;
}

export async function handleCounts(id, request, env, user) {
  const db = env.DB;
  const url = new URL(request.url);
  const method = request.method;
  const sp = url.searchParams;

  if (id === 'sheet' && method === 'GET') {
    const t = sp.get('item_type');
    if (!ITEM_TYPES.includes(t)) throw new HttpError(400, 'item_type 錯誤');
    const date = sp.get('date');
    if (!isDate(date)) throw new HttpError(400, '日期格式錯誤');
    const ex = sp.get('exclude_count_id') ? toInt(sp.get('exclude_count_id'), '盤點單') : -1;
    let rows = await sheet(db, t, date, ex);
    if (sp.get('all') !== '1') rows = rows.filter((r) => Math.abs(r.system_qty) > EPS || t === '包材');
    return json({ data: rows });
  }

  if (!id && method === 'GET') {
    const { from, to } = dateRange(url);
    const where = [];
    const binds = [];
    if (from) { where.push('c.count_date >= ?'); binds.push(from); }
    if (to) { where.push('c.count_date <= ?'); binds.push(to); }
    if (sp.get('count_type')) { where.push('c.count_type = ?'); binds.push(sp.get('count_type')); }
    if (sp.get('item_type')) { where.push('c.item_type = ?'); binds.push(sp.get('item_type')); }
    const { results } = await db.prepare(
      `SELECT c.*, COUNT(i.item_id) AS item_count,
              SUM(CASE WHEN i.diff_qty > 0 THEN i.amount ELSE 0 END) AS gain_amount,
              SUM(CASE WHEN i.diff_qty < 0 THEN -i.amount ELSE 0 END) AS loss_amount,
              GROUP_CONCAT(DISTINCT CASE WHEN i.diff_qty <> 0 THEN i.reason END) AS reasons
       FROM stock_counts c LEFT JOIN stock_count_items i ON i.count_id = c.count_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       GROUP BY c.count_id ORDER BY c.count_date DESC, c.count_id DESC`,
    ).bind(...binds).all();
    for (const r of results) { r.gain_amount = round(r.gain_amount || 0); r.loss_amount = round(r.loss_amount || 0); }
    return json({ from, to, data: results, summary: { count: results.length, gain: round(results.reduce((s, r) => s + r.gain_amount, 0)), loss: round(results.reduce((s, r) => s + r.loss_amount, 0)) } });
  }

  if (!id && method === 'POST') {
    const p = await prepare(db, await readJson(request));
    await db.batch([
      db.prepare('INSERT INTO stock_counts (count_no, count_date, count_type, item_type, note, created_by) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(p.header.count_no, p.header.count_date, p.header.count_type, p.header.item_type, p.header.note, user),
      ...detailStatements(db, p, user),
    ]);
    const row = await db.prepare('SELECT count_id FROM stock_counts WHERE count_no = ?').bind(p.header.count_no).first();
    return json({ data: await getCount(db, row.count_id) }, 201);
  }

  if (!id) throw new HttpError(405, '不支援的操作');
  const cid = toInt(id, '盤點單');
  if (method === 'GET') return json({ data: await getCount(db, cid) });
  const clear = [
    db.prepare("DELETE FROM inventory_movements WHERE ref_doc_type = 'stock_counts' AND ref_doc_id = ?").bind(cid),
    db.prepare('DELETE FROM stock_count_items WHERE count_id = ?').bind(cid),
  ];
  if (method === 'PUT') {
    const cur = await getCount(db, cid);
    const body = await readJson(request);
    body.count_type = cur.count_type; body.item_type = cur.item_type;
    const p = await prepare(db, body, { excludeId: cid, keepNo: cur.count_no });
    await db.batch([
      ...clear,
      db.prepare('UPDATE stock_counts SET count_no = ?, count_date = ?, note = ?, updated_at = ? WHERE count_id = ?').bind(p.header.count_no, p.header.count_date, p.header.note, nowTW(), cid),
      ...detailStatements(db, p, user),
    ]);
    return json({ data: await getCount(db, cid) });
  }
  if (method === 'DELETE') {
    await getCount(db, cid);
    await db.batch([...clear, db.prepare('DELETE FROM stock_counts WHERE count_id = ?').bind(cid)]);
    return json({ ok: true });
  }
  throw new HttpError(405, '不支援的操作');
}
