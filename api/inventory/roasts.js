// 烘焙批次（簡化版）— 只記錄：投入哪幾批生豆各幾 kg、產出多少熟豆
// 存檔規則（ARCHITECTURE.md 8.2）：
//   1. 每筆投入明細 → inventory_movements（烘焙投入，−kg）扣生豆批號庫存
//   2. 建立 roasted_lots（熟豆批次，批號 = 烘焙批次編號）→ inventory_movements（烘焙產出，+kg）
//   3. 自動計算：投入總重、失重率、投入總成本、熟豆每 kg 成本
//   4. 生豆批號庫存不足 → 禁止存檔；失重率 < 10% 或 > 25% → 回傳提醒（前端存檔前先確認）
//   5. 熟豆批次已有其他異動（銷貨出庫…）→ 鎖定，不可修改／刪除
// 表頭、明細、熟豆批次、異動全部放在同一個 D1 batch（單一交易）。

import { HttpError, json, readJson, toInt, isDate, dateRange, nowTW, round } from '../lib/http.js';
import { makeNo, seqOf, lastSeq, seqStatement } from '../lib/docno.js';

export const LOSS_MIN = 0.10;
export const LOSS_MAX = 0.25;

function addDays(date, days) {
  const t = new Date(date + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/** 驗證輸入並算出所有 auto 欄位 */
async function prepare(db, body, { excludeBatchId = null, keepNo = null } = {}) {
  const roast_date = body.roast_date;
  if (!isDate(roast_date)) throw new HttpError(400, '烘焙日期格式錯誤（YYYY-MM-DD）');
  const roasted_bean_id = toInt(body.roasted_bean_id, '熟豆品項');
  const rb = await db.prepare('SELECT roasted_bean_id, name, shelf_life_days FROM roasted_beans WHERE roasted_bean_id = ?').bind(roasted_bean_id).first();
  if (!rb) throw new HttpError(400, '熟豆品項不存在');

  const output_kg = round(Number(body.output_kg), 3);
  if (!Number.isFinite(output_kg) || output_kg <= 0) throw new HttpError(400, '產出熟豆 kg 必須大於 0');
  if (!Array.isArray(body.inputs) || body.inputs.length === 0) throw new HttpError(400, '至少要有一筆投入生豆');

  // ---- 投入明細 ----
  const inputs = [];
  const seen = new Set();
  for (const [i, raw] of body.inputs.entries()) {
    const line = i + 1;
    const lot_id = toInt(raw.lot_id, `第 ${line} 筆生豆批號`);
    if (seen.has(lot_id)) throw new HttpError(400, `第 ${line} 筆：同一個生豆批號請合併成一筆`);
    seen.add(lot_id);
    const input_kg = round(Number(raw.input_kg), 3);
    if (!Number.isFinite(input_kg) || input_kg <= 0) throw new HttpError(400, `第 ${line} 筆：投入 kg 必須大於 0`);

    // 可用量 = 該批號所有異動加總，但不含本批次自己先前的投入（修改時要加回來）
    const lot = await db.prepare(
      `SELECT l.lot_id, l.lot_no, l.unit_cost, l.received_date, b.name AS bean_name,
              COALESCE((SELECT SUM(m.qty) FROM inventory_movements m
                        WHERE m.item_type = '生豆' AND m.item_ref_id = l.lot_id
                          AND (m.ref_doc_type IS NOT 'roast_batches' OR m.ref_doc_id IS NOT ?)), 0) AS available
       FROM green_bean_lots l JOIN green_beans b ON b.bean_id = l.bean_id WHERE l.lot_id = ?`,
    ).bind(excludeBatchId ?? -1, lot_id).first();
    if (!lot) throw new HttpError(400, `第 ${line} 筆：生豆批號不存在`);
    if (lot.received_date > roast_date) {
      throw new HttpError(400, `第 ${line} 筆：批號 ${lot.lot_no} 的入庫日（${lot.received_date}）晚於烘焙日期`);
    }
    const available = round(lot.available, 3);
    if (input_kg > available + 0.0005) {
      throw new HttpError(409, `第 ${line} 筆：批號 ${lot.lot_no}（${lot.bean_name}）庫存不足，剩 ${available} kg，要投入 ${input_kg} kg`);
    }
    inputs.push({ line_no: line, lot_id, lot_no: lot.lot_no, input_kg, unit_cost: lot.unit_cost, amount: round(input_kg * lot.unit_cost) });
  }

  const input_total_kg = round(inputs.reduce((s, it) => s + it.input_kg, 0), 3);
  if (output_kg > input_total_kg + 0.0005) throw new HttpError(400, `產出熟豆（${output_kg} kg）不可大於投入生豆（${input_total_kg} kg）`);
  const input_total_cost = round(inputs.reduce((s, it) => s + it.amount, 0));
  const loss_rate = round((input_total_kg - output_kg) / input_total_kg, 4);
  const unit_cost = round(input_total_cost / output_kg, 4);

  // ---- 批次編號（空白 → 自動產生；有填 → 檢查重複）----
  const ymd = roast_date.replaceAll('-', '');
  let batch_no = (body.batch_no || '').trim() || keepNo || null; // 修改時留空 = 沿用原編號
  let rLast = await lastSeq(db, 'R', ymd);
  if (!batch_no) batch_no = makeNo('R', ymd, ++rLast);
  else {
    const dup = await db.prepare('SELECT batch_id FROM roast_batches WHERE batch_no = ?').bind(batch_no).first();
    if (dup && dup.batch_id !== excludeBatchId) throw new HttpError(409, `烘焙批次編號 ${batch_no} 已存在`);
    rLast = Math.max(rLast, seqOf(batch_no, 'R', ymd));
  }

  const warnings = [];
  if (loss_rate < LOSS_MIN || loss_rate > LOSS_MAX) {
    warnings.push(`失重率 ${round(loss_rate * 100, 1)}% 不在一般範圍（10%～25%），請確認投入與產出公斤數`);
  }

  return {
    header: {
      batch_no, roast_date, roasted_bean_id, input_total_kg, output_kg, loss_rate, input_total_cost, unit_cost,
      best_before: rb.shelf_life_days > 0 ? addDays(roast_date, rb.shelf_life_days) : null,
      note: (body.note || '').trim() || null,
    },
    inputs, ymd, rLast, warnings,
  };
}

/** 投入明細、熟豆批次、異動的 INSERT 語句（表頭已存在或在同一 batch 較前面） */
function detailStatements(db, p, user) {
  const h = p.header;
  const BID = '(SELECT batch_id FROM roast_batches WHERE batch_no = ?)';
  const mvDate = `${h.roast_date} 00:00:00`;
  const mvSql = `INSERT INTO inventory_movements (movement_date, item_type, item_ref_id, movement_type, qty, unit_cost, amount, ref_doc_type, ref_doc_id, ref_item_id, note, created_by)`;
  const stmts = [];
  for (const it of p.inputs) {
    stmts.push(db.prepare(
      `INSERT INTO roast_batch_inputs (batch_id, line_no, lot_id, input_kg, unit_cost, amount) VALUES (${BID}, ?, ?, ?, ?, ?)`,
    ).bind(h.batch_no, it.line_no, it.lot_id, it.input_kg, it.unit_cost, it.amount));
    stmts.push(db.prepare(
      `${mvSql} VALUES (?, '生豆', ?, '烘焙投入', ?, ?, ?, 'roast_batches', ${BID},
                (SELECT input_id FROM roast_batch_inputs WHERE batch_id = ${BID} AND line_no = ?), ?, ?)`,
    ).bind(mvDate, it.lot_id, -it.input_kg, it.unit_cost, -it.amount, h.batch_no, h.batch_no, it.line_no, h.batch_no, user));
  }
  stmts.push(db.prepare(
    `INSERT INTO roasted_lots (batch_id, roasted_bean_id, roast_date, best_before, initial_kg, unit_cost) VALUES (${BID}, ?, ?, ?, ?, ?)`,
  ).bind(h.batch_no, h.roasted_bean_id, h.roast_date, h.best_before, h.output_kg, h.unit_cost));
  // 產出金額 = 投入總成本（不用 kg × 單位成本，避免四捨五入差）
  stmts.push(db.prepare(
    `${mvSql} VALUES (?, '熟豆', (SELECT roasted_lot_id FROM roasted_lots WHERE batch_id = ${BID}), '烘焙產出', ?, ?, ?, 'roast_batches', ${BID}, NULL, ?, ?)`,
  ).bind(mvDate, h.batch_no, h.output_kg, h.unit_cost, h.input_total_cost, h.batch_no, h.batch_no, user));
  if (p.rLast > 0) stmts.push(seqStatement(db, 'R', p.ymd, p.rLast));
  return stmts;
}

async function getBatch(db, id) {
  const header = await db.prepare(
    `SELECT r.*, n.name AS roasted_bean_name, v.roasted_lot_id, v.best_before, v.current_kg, v.other_movement_count
     FROM roast_batches r
     JOIN roasted_beans n ON n.roasted_bean_id = r.roasted_bean_id
     LEFT JOIN v_roasted_lot_stock v ON v.batch_id = r.batch_id
     WHERE r.batch_id = ?`,
  ).bind(id).first();
  if (!header) throw new HttpError(404, '找不到烘焙批次');
  const { results: inputs } = await db.prepare(
    `SELECT i.*, l.lot_no, l.bean_id, b.name AS bean_name
     FROM roast_batch_inputs i
     JOIN green_bean_lots l ON l.lot_id = i.lot_id
     JOIN green_beans b ON b.bean_id = l.bean_id
     WHERE i.batch_id = ? ORDER BY i.line_no`,
  ).bind(id).all();
  header.inputs = inputs;
  header.locked = (header.other_movement_count || 0) > 0;
  return header;
}

async function assertEditable(db, id) {
  const b = await getBatch(db, id);
  if (b.locked) throw new HttpError(409, `烘焙批次 ${b.batch_no} 的熟豆已被使用（銷貨出庫等），無法修改或刪除`);
  return b;
}

/** 清除烘焙批次的投入明細、熟豆批次、異動（表頭保留） */
function clearStatements(db, id) {
  return [
    db.prepare("DELETE FROM inventory_movements WHERE ref_doc_type = 'roast_batches' AND ref_doc_id = ?").bind(id),
    db.prepare('DELETE FROM roasted_lots WHERE batch_id = ?').bind(id),
    db.prepare('DELETE FROM roast_batch_inputs WHERE batch_id = ?').bind(id),
  ];
}

export async function handleRoasts(id, request, env, user) {
  const db = env.DB;
  const url = new URL(request.url);
  const method = request.method;

  // ---- 預覽下一個批次編號 ----
  if (id === 'next-no' && method === 'GET') {
    const date = url.searchParams.get('date');
    if (!isDate(date)) throw new HttpError(400, '日期格式錯誤');
    const ymd = date.replaceAll('-', '');
    return json({ data: { batch_no: makeNo('R', ymd, (await lastSeq(db, 'R', ymd)) + 1) } });
  }

  // ---- 烘焙紀錄查詢（日期區間、熟豆品項、生豆品項、生豆批號）----
  if (!id && method === 'GET') {
    const { from, to } = dateRange(url);
    const sp = url.searchParams;
    const where = [];
    const binds = [];
    if (from) { where.push('r.roast_date >= ?'); binds.push(from); }
    if (to) { where.push('r.roast_date <= ?'); binds.push(to); }
    if (sp.get('roasted_bean_id')) { where.push('r.roasted_bean_id = ?'); binds.push(toInt(sp.get('roasted_bean_id'), '熟豆品項')); }
    if (sp.get('bean_id')) {
      where.push('EXISTS (SELECT 1 FROM roast_batch_inputs x JOIN green_bean_lots xl ON xl.lot_id = x.lot_id WHERE x.batch_id = r.batch_id AND xl.bean_id = ?)');
      binds.push(toInt(sp.get('bean_id'), '生豆品項'));
    }
    if (sp.get('lot_id')) {
      where.push('EXISTS (SELECT 1 FROM roast_batch_inputs x WHERE x.batch_id = r.batch_id AND x.lot_id = ?)');
      binds.push(toInt(sp.get('lot_id'), '生豆批號'));
    }
    const { results } = await db.prepare(
      `SELECT r.*, n.name AS roasted_bean_name, v.current_kg, v.best_before,
              (SELECT GROUP_CONCAT(t, '、') FROM (
                 SELECT b.name || ' ' || printf('%g', x.input_kg) || 'kg' AS t
                 FROM roast_batch_inputs x
                 JOIN green_bean_lots xl ON xl.lot_id = x.lot_id
                 JOIN green_beans b ON b.bean_id = xl.bean_id
                 WHERE x.batch_id = r.batch_id ORDER BY x.line_no)) AS inputs_text
       FROM roast_batches r
       JOIN roasted_beans n ON n.roasted_bean_id = r.roasted_bean_id
       LEFT JOIN v_roasted_lot_stock v ON v.batch_id = r.batch_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY r.roast_date DESC, r.batch_id DESC`,
    ).bind(...binds).all();
    const inKg = results.reduce((s, r) => s + r.input_total_kg, 0);
    const outKg = results.reduce((s, r) => s + r.output_kg, 0);
    const summary = {
      count: results.length,
      input_kg: round(inKg, 3),
      output_kg: round(outKg, 3),
      loss_rate: inKg > 0 ? round((inKg - outKg) / inKg, 4) : null,
      input_cost: round(results.reduce((s, r) => s + r.input_total_cost, 0)),
    };
    return json({ data: results, summary, loss_range: [LOSS_MIN, LOSS_MAX] });
  }

  const insertHeader = (h) => db.prepare(
    `INSERT INTO roast_batches (batch_no, roast_date, roasted_bean_id, input_total_kg, output_kg, loss_rate, input_total_cost, unit_cost, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(h.batch_no, h.roast_date, h.roasted_bean_id, h.input_total_kg, h.output_kg, h.loss_rate, h.input_total_cost, h.unit_cost, h.note, user);

  // ---- 新增 ----
  if (!id && method === 'POST') {
    const p = await prepare(db, await readJson(request));
    await db.batch([insertHeader(p.header), ...detailStatements(db, p, user)]);
    const row = await db.prepare('SELECT batch_id FROM roast_batches WHERE batch_no = ?').bind(p.header.batch_no).first();
    return json({ data: await getBatch(db, row.batch_id), warnings: p.warnings }, 201);
  }

  if (!id) throw new HttpError(405, '不支援的操作');
  const bid = toInt(id, '烘焙批次');

  if (method === 'GET') return json({ data: await getBatch(db, bid) });

  // ---- 修改：熟豆未被使用才可改；整批重寫明細、熟豆批次、異動 ----
  if (method === 'PUT') {
    const cur = await assertEditable(db, bid);
    const p = await prepare(db, await readJson(request), { excludeBatchId: bid, keepNo: cur.batch_no });
    const h = p.header;
    await db.batch([
      ...clearStatements(db, bid),
      db.prepare(
        `UPDATE roast_batches SET batch_no = ?, roast_date = ?, roasted_bean_id = ?, input_total_kg = ?, output_kg = ?, loss_rate = ?,
                input_total_cost = ?, unit_cost = ?, note = ?, updated_at = ? WHERE batch_id = ?`,
      ).bind(h.batch_no, h.roast_date, h.roasted_bean_id, h.input_total_kg, h.output_kg, h.loss_rate, h.input_total_cost, h.unit_cost, h.note, nowTW(), bid),
      ...detailStatements(db, p, user),
    ]);
    return json({ data: await getBatch(db, bid), warnings: p.warnings });
  }

  // ---- 刪除 ----
  if (method === 'DELETE') {
    await assertEditable(db, bid);
    await db.batch([
      ...clearStatements(db, bid),
      db.prepare('DELETE FROM roast_batches WHERE batch_id = ?').bind(bid),
    ]);
    return json({ ok: true });
  }

  throw new HttpError(405, '不支援的操作');
}
