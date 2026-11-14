// 期初庫存 — 開帳時手上已有的生豆／包材，不經過進貨單直接入庫
//   「期初 kg」不是可填的欄位，而是起日之前所有庫存異動的加總；
//   所以開帳庫存也是寫一筆異動（movement_type = '期初'、ref_doc_type = 'opening'）。
//   * 生豆：建立一個沒有進貨單的批號（green_bean_lots.purchase_item_id 為空）＋ 一筆期初異動
//   * 包材：只寫一筆期初異動（包材沒有批號）
//   不算進貨金額、不產生應付帳款。
//   生豆期初批號被使用（烘焙投入…）後鎖定，不可修改／刪除；包材期初隨時可改。
// 路徑：/api/opening-stock（GET 列表、POST 新增）、/api/opening-stock/g{lot_id}｜p{movement_id}（PUT、DELETE）

import { HttpError, json, readJson, toInt, isDate, round } from '../lib/http.js';
import { makeNo, seqOf, lastSeq, seqStatement } from '../lib/docno.js';

const MV_SQL = `INSERT INTO inventory_movements (movement_date, item_type, item_ref_id, movement_type, qty, unit_cost, amount, ref_doc_type, ref_doc_id, ref_item_id, note, created_by)`;

function common(body) {
  const date = body.date;
  if (!isDate(date)) throw new HttpError(400, '期初日期格式錯誤（YYYY-MM-DD）');
  const qty = Number(body.qty);
  if (!Number.isFinite(qty) || qty <= 0) throw new HttpError(400, '數量必須大於 0');
  const unit_cost = body.unit_cost === undefined || body.unit_cost === null || body.unit_cost === '' ? 0 : Number(body.unit_cost);
  if (!Number.isFinite(unit_cost) || unit_cost < 0) throw new HttpError(400, '單位成本必須是 0 以上的數字');
  return { date, qty, unit_cost, amount: round(qty * unit_cost), note: (body.note || '').trim() || null };
}

// ------------------------------------------------------------------ 生豆
async function prepareBean(db, body, { excludeLotId = null, keepNo = null } = {}) {
  const c = common(body);
  c.qty = round(c.qty, 3);
  const bean_id = toInt(body.bean_id, '生豆品項');
  const b = await db.prepare('SELECT bean_id FROM green_beans WHERE bean_id = ?').bind(bean_id).first();
  if (!b) throw new HttpError(400, '生豆品項不存在');

  const ymd = c.date.replaceAll('-', '');
  let lot_no = (body.lot_no || '').trim() || keepNo || null;
  let lLast = await lastSeq(db, 'L', ymd);
  if (!lot_no) lot_no = makeNo('L', ymd, ++lLast);
  else {
    const dup = await db.prepare('SELECT lot_id FROM green_bean_lots WHERE lot_no = ?').bind(lot_no).first();
    if (dup && dup.lot_id !== excludeLotId) throw new HttpError(409, `批號 ${lot_no} 已存在`);
    lLast = Math.max(lLast, seqOf(lot_no, 'L', ymd));
  }
  return { ...c, bean_id, lot_no, ymd, lLast, storage_location: (body.storage_location || '').trim() || null };
}

function beanMovement(db, p, user) {
  return db.prepare(
    `${MV_SQL} VALUES (?, '生豆', (SELECT lot_id FROM green_bean_lots WHERE lot_no = ?), '期初', ?, ?, ?, 'opening', NULL, NULL, ?, ?)`,
  ).bind(`${p.date} 00:00:00`, p.lot_no, p.qty, p.unit_cost, p.amount, p.lot_no, user);
}

async function getOpeningLot(db, lotId) {
  const lot = await db.prepare(
    `SELECT l.*, v.bean_name, v.current_kg, v.other_movement_count
     FROM green_bean_lots l JOIN v_green_bean_lot_stock v ON v.lot_id = l.lot_id
     WHERE l.lot_id = ? AND l.purchase_item_id IS NULL`,
  ).bind(lotId).first();
  if (!lot) throw new HttpError(404, '找不到這筆生豆期初庫存');
  lot.locked = (lot.other_movement_count || 0) > 0;
  return lot;
}

async function assertLotEditable(db, lotId) {
  const lot = await getOpeningLot(db, lotId);
  if (lot.locked) throw new HttpError(409, `批號 ${lot.lot_no} 已被使用（烘焙投入等），無法修改或刪除`);
  return lot;
}

// ------------------------------------------------------------------ 包材
async function preparePack(db, body) {
  const c = common(body);
  const packaging_id = toInt(body.packaging_id, '包材');
  const k = await db.prepare('SELECT packaging_id FROM packaging_items WHERE packaging_id = ?').bind(packaging_id).first();
  if (!k) throw new HttpError(400, '包材不存在');
  return { ...c, packaging_id };
}

async function getOpeningPack(db, movementId) {
  const m = await db.prepare(
    `SELECT m.*, k.name AS packaging_name, k.unit FROM inventory_movements m
     JOIN packaging_items k ON k.packaging_id = m.item_ref_id
     WHERE m.movement_id = ? AND m.item_type = '包材' AND m.movement_type = '期初'`,
  ).bind(movementId).first();
  if (!m) throw new HttpError(404, '找不到這筆包材期初庫存');
  return m;
}

// ------------------------------------------------------------------ 路由
export async function handleOpening(id, request, env, user) {
  const db = env.DB;
  const method = request.method;

  // ---- 列表 ----
  if (!id && method === 'GET') {
    const { results: beans } = await db.prepare(
      `SELECT l.lot_id, l.lot_no, l.bean_id, v.bean_name, l.received_date, l.initial_kg, l.unit_cost, l.storage_location, l.note,
              v.current_kg, v.other_movement_count
       FROM green_bean_lots l JOIN v_green_bean_lot_stock v ON v.lot_id = l.lot_id
       WHERE l.purchase_item_id IS NULL ORDER BY l.received_date DESC, l.lot_id DESC`,
    ).all();
    for (const b of beans) { b.amount = round(b.initial_kg * b.unit_cost); b.locked = (b.other_movement_count || 0) > 0; }
    const { results: packaging } = await db.prepare(
      `SELECT m.movement_id, m.item_ref_id AS packaging_id, k.name AS packaging_name, k.unit, substr(m.movement_date, 1, 10) AS date,
              m.qty, m.unit_cost, m.amount, m.note
       FROM inventory_movements m JOIN packaging_items k ON k.packaging_id = m.item_ref_id
       WHERE m.item_type = '包材' AND m.movement_type = '期初' ORDER BY m.movement_date DESC, m.movement_id DESC`,
    ).all();
    return json({
      beans, packaging,
      summary: {
        bean_kg: round(beans.reduce((s, b) => s + b.initial_kg, 0), 3),
        bean_amount: round(beans.reduce((s, b) => s + b.amount, 0)),
        packaging_amount: round(packaging.reduce((s, p) => s + p.amount, 0)),
      },
    });
  }

  // ---- 新增 ----
  if (!id && method === 'POST') {
    const body = await readJson(request);
    if (body.item_type === '生豆') {
      const p = await prepareBean(db, body);
      await db.batch([
        db.prepare(
          `INSERT INTO green_bean_lots (lot_no, bean_id, purchase_item_id, received_date, initial_kg, unit_cost, storage_location, note)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
        ).bind(p.lot_no, p.bean_id, p.date, p.qty, p.unit_cost, p.storage_location, p.note),
        beanMovement(db, p, user),
        seqStatement(db, 'L', p.ymd, p.lLast),
      ]);
      const row = await db.prepare('SELECT lot_id FROM green_bean_lots WHERE lot_no = ?').bind(p.lot_no).first();
      return json({ data: await getOpeningLot(db, row.lot_id) }, 201);
    }
    if (body.item_type === '包材') {
      const p = await preparePack(db, body);
      const res = await db.prepare(`${MV_SQL} VALUES (?, '包材', ?, '期初', ?, ?, ?, 'opening', NULL, NULL, ?, ?)`)
        .bind(`${p.date} 00:00:00`, p.packaging_id, p.qty, p.unit_cost, p.amount, p.note, user).run();
      return json({ data: await getOpeningPack(db, res.meta.last_row_id) }, 201);
    }
    throw new HttpError(400, '類型必須是 生豆／包材');
  }

  if (!id) throw new HttpError(405, '不支援的操作');
  const kind = id[0];
  if (kind !== 'g' && kind !== 'p') throw new HttpError(404, '找不到此路徑');
  const key = toInt(id.slice(1), '編號');

  if (kind === 'g') {
    if (method === 'GET') return json({ data: await getOpeningLot(db, key) });
    if (method === 'PUT') {
      const cur = await assertLotEditable(db, key);
      const p = await prepareBean(db, await readJson(request), { excludeLotId: key, keepNo: cur.lot_no });
      await db.batch([
        db.prepare("DELETE FROM inventory_movements WHERE item_type = '生豆' AND item_ref_id = ? AND movement_type = '期初'").bind(key),
        db.prepare(
          `UPDATE green_bean_lots SET lot_no = ?, bean_id = ?, received_date = ?, initial_kg = ?, unit_cost = ?, storage_location = ?, note = ? WHERE lot_id = ?`,
        ).bind(p.lot_no, p.bean_id, p.date, p.qty, p.unit_cost, p.storage_location, p.note, key),
        beanMovement(db, p, user),
        seqStatement(db, 'L', p.ymd, p.lLast),
      ]);
      return json({ data: await getOpeningLot(db, key) });
    }
    if (method === 'DELETE') {
      await assertLotEditable(db, key);
      await db.batch([
        db.prepare("DELETE FROM inventory_movements WHERE item_type = '生豆' AND item_ref_id = ?").bind(key),
        db.prepare('DELETE FROM green_bean_lots WHERE lot_id = ?').bind(key),
      ]);
      return json({ ok: true });
    }
  } else {
    if (method === 'GET') return json({ data: await getOpeningPack(db, key) });
    if (method === 'PUT') {
      await getOpeningPack(db, key);
      const p = await preparePack(db, await readJson(request));
      await db.prepare(
        `UPDATE inventory_movements SET movement_date = ?, item_ref_id = ?, qty = ?, unit_cost = ?, amount = ?, note = ?, created_by = ? WHERE movement_id = ?`,
      ).bind(`${p.date} 00:00:00`, p.packaging_id, p.qty, p.unit_cost, p.amount, p.note, user, key).run();
      return json({ data: await getOpeningPack(db, key) });
    }
    if (method === 'DELETE') {
      await getOpeningPack(db, key);
      await db.prepare('DELETE FROM inventory_movements WHERE movement_id = ?').bind(key).run();
      return json({ ok: true });
    }
  }
  throw new HttpError(405, '不支援的操作');
}
