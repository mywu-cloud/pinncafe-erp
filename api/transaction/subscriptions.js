// 訂閱訂單
//   到了出貨日不會自動開單：「待出貨」清單（next_ship_date ≤ 指定日、進行中、未過結束日）勾選後一次產生銷貨單，
//   每張銷貨單建立時同時把該訂閱的 next_ship_date 往後推一期（每週 +7 天、雙週 +14 天、每月 +1 個月）
//   熟豆／包材不足時回傳 shortage，前端確認後帶 allow_shortage 重送

import { HttpError, json, readJson, toInt, isDate, nowTW, round, todayTW } from '../lib/http.js';
import { createSale, CHANNELS, PAY_METHODS } from './sales.js';
import { GRIND_SIZES } from '../master/resources.js';

export const FREQUENCIES = ['每週', '雙週', '每月'];
export const SUB_STATUS = ['進行中', '暫停', '取消'];

export function nextDate(date, frequency) {
  const t = new Date(date + 'T00:00:00Z');
  if (frequency === '每週') t.setUTCDate(t.getUTCDate() + 7);
  else if (frequency === '雙週') t.setUTCDate(t.getUTCDate() + 14);
  else {
    const day = t.getUTCDate();
    t.setUTCDate(1);
    t.setUTCMonth(t.getUTCMonth() + 1);
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    t.setUTCDate(Math.min(day, last)); // 1/31 → 2/28
  }
  return t.toISOString().slice(0, 10);
}

async function prepare(db, body) {
  const customer_id = toInt(body.customer_id, '客戶');
  if (!(await db.prepare('SELECT 1 FROM customers WHERE customer_id = ?').bind(customer_id).first())) throw new HttpError(400, '客戶不存在');
  const product_id = toInt(body.product_id, '產品');
  const prod = await db.prepare('SELECT retail_price FROM products WHERE product_id = ?').bind(product_id).first();
  if (!prod) throw new HttpError(400, '產品不存在');
  const qty = Number(body.qty || 1);
  if (!Number.isInteger(qty) || qty <= 0) throw new HttpError(400, '每期數量必須是大於 0 的整數');
  const unit_price = body.unit_price === undefined || body.unit_price === '' ? prod.retail_price ?? 0 : Number(body.unit_price);
  if (!Number.isFinite(unit_price) || unit_price < 0) throw new HttpError(400, '單價不可為負數');
  const shipping_fee = round(Number(body.shipping_fee || 0));
  if (!Number.isFinite(shipping_fee) || shipping_fee < 0) throw new HttpError(400, '運費不可為負數');
  const frequency = body.frequency || '每月';
  if (!FREQUENCIES.includes(frequency)) throw new HttpError(400, `頻率必須是：${FREQUENCIES.join('／')}`);
  if (!isDate(body.start_date)) throw new HttpError(400, '開始日期格式錯誤（YYYY-MM-DD）');
  const next_ship_date = body.next_ship_date || body.start_date;
  if (!isDate(next_ship_date)) throw new HttpError(400, '下次出貨日格式錯誤（YYYY-MM-DD）');
  if (body.end_date && !isDate(body.end_date)) throw new HttpError(400, '結束日期格式錯誤（YYYY-MM-DD）');
  if (body.end_date && body.end_date < body.start_date) throw new HttpError(400, '結束日期不可早於開始日期');
  const status = body.status || '進行中';
  if (!SUB_STATUS.includes(status)) throw new HttpError(400, `狀態必須是：${SUB_STATUS.join('／')}`);
  const grind_size = (body.grind_size || '').trim() || null;
  if (grind_size && !GRIND_SIZES.includes(grind_size)) throw new HttpError(400, `研磨度必須是：${GRIND_SIZES.join('／')}`);
  const channel = body.channel || 'LINE';
  if (!CHANNELS.includes(channel)) throw new HttpError(400, `通路必須是：${CHANNELS.join('／')}`);
  const payment_method = body.payment_method || '轉帳';
  if (!PAY_METHODS.includes(payment_method)) throw new HttpError(400, `付款方式必須是：${PAY_METHODS.join('／')}`);
  return {
    customer_id, product_id, qty, grind_size, unit_price, shipping_fee, frequency, next_ship_date,
    start_date: body.start_date, end_date: body.end_date || null, status, channel, payment_method,
    note: (body.note || '').trim() || null,
  };
}
const COLS = ['customer_id', 'product_id', 'qty', 'grind_size', 'unit_price', 'shipping_fee', 'frequency', 'next_ship_date', 'start_date', 'end_date', 'status', 'channel', 'payment_method', 'note'];

const LIST_SQL = `SELECT x.*, c.name AS customer_name, p.name AS product_name, p.net_weight_g,
       (SELECT COUNT(*) FROM sales s WHERE s.subscription_id = x.subscription_id) AS shipped_count,
       (SELECT MAX(s.sale_date) FROM sales s WHERE s.subscription_id = x.subscription_id) AS last_ship_date
  FROM subscriptions x JOIN customers c ON c.customer_id = x.customer_id JOIN products p ON p.product_id = x.product_id`;

async function getSub(db, id) {
  const r = await db.prepare(`${LIST_SQL} WHERE x.subscription_id = ?`).bind(id).first();
  if (!r) throw new HttpError(404, '找不到訂閱');
  const { results } = await db.prepare('SELECT sale_id, sale_no, sale_date, total_amount, payment_status FROM sales WHERE subscription_id = ? ORDER BY sale_date DESC, sale_id DESC').bind(id).all();
  r.sales = results;
  return r;
}

export async function handleSubscriptions(id, request, env, user) {
  const db = env.DB;
  const url = new URL(request.url);
  const method = request.method;
  const sp = url.searchParams;

  // ---- 待出貨 ----
  if (id === 'due' && method === 'GET') {
    const date = sp.get('date') || todayTW();
    if (!isDate(date)) throw new HttpError(400, '日期格式錯誤');
    const { results } = await db.prepare(
      `${LIST_SQL} WHERE x.status = '進行中' AND x.next_ship_date <= ? AND (x.end_date IS NULL OR x.next_ship_date <= x.end_date)
       ORDER BY x.next_ship_date, x.subscription_id`,
    ).bind(date).all();
    for (const r of results) { r.amount = round(r.qty * r.unit_price + r.shipping_fee); r.after = nextDate(r.next_ship_date, r.frequency); }
    return json({ date, data: results, total: round(results.reduce((s, r) => s + r.amount, 0)) });
  }

  // ---- 產生銷貨單 ----
  if (id === 'generate' && method === 'POST') {
    const body = await readJson(request);
    const date = body.date || todayTW();
    if (!isDate(date)) throw new HttpError(400, '出貨日期格式錯誤');
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
    if (!ids.length) throw new HttpError(400, '請勾選要出貨的訂閱');
    const results = [];
    for (const sid of ids) {
      const s = await db.prepare('SELECT * FROM subscriptions WHERE subscription_id = ?').bind(sid).first();
      if (!s) { results.push({ subscription_id: sid, ok: false, error: '找不到訂閱' }); continue; }
      if (s.status !== '進行中') { results.push({ subscription_id: sid, ok: false, error: `訂閱狀態為「${s.status}」` }); continue; }
      const after = nextDate(s.next_ship_date, s.frequency);
      try {
        const res = await createSale(db, {
          sale_date: date, customer_id: s.customer_id, channel: s.channel, payment_method: s.payment_method,
          shipping_fee: s.shipping_fee, subscription_id: sid,
          items: [{ product_id: s.product_id, grind_size: s.grind_size, qty: s.qty, unit_price: s.unit_price }],
          note: `訂閱 #${sid}（${s.frequency}，應出貨日 ${s.next_ship_date}）`,
          allow_shortage: body.allow_shortage === true,
        }, user, [
          // 同一個 batch：避免銷貨單建好但下次出貨日沒推進（重複出貨）
          db.prepare('UPDATE subscriptions SET next_ship_date = ?, updated_at = ? WHERE subscription_id = ? AND next_ship_date = ?').bind(after, nowTW(), sid, s.next_ship_date),
        ]);
        results.push({ subscription_id: sid, ok: true, sale_id: res.data.sale_id, sale_no: res.data.sale_no, next_ship_date: after, shortages: res.shortages });
      } catch (e) {
        if (e.detail?.code === 'SHORTAGE') results.push({ subscription_id: sid, ok: false, shortage: true, shortages: e.detail.shortages });
        else results.push({ subscription_id: sid, ok: false, error: e.message });
      }
    }
    return json({ data: results });
  }

  if (!id && method === 'GET') {
    const where = [];
    const binds = [];
    if (sp.get('status')) { where.push('x.status = ?'); binds.push(sp.get('status')); }
    if (sp.get('customer_id')) { where.push('x.customer_id = ?'); binds.push(toInt(sp.get('customer_id'), '客戶')); }
    const { results } = await db.prepare(`${LIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY x.status = '取消', x.next_ship_date`).bind(...binds).all();
    for (const r of results) r.amount = round(r.qty * r.unit_price + r.shipping_fee);
    const active = results.filter((r) => r.status === '進行中');
    // 每月約當營收：每週 × 52/12、雙週 × 26/12、每月 × 1
    const perMonth = { 每週: 52 / 12, 雙週: 26 / 12, 每月: 1 };
    return json({ data: results, summary: { count: results.length, active: active.length, monthly: round(active.reduce((s, r) => s + r.amount * perMonth[r.frequency], 0)) } });
  }

  if (!id && method === 'POST') {
    const row = await prepare(db, await readJson(request));
    const res = await db.prepare(`INSERT INTO subscriptions (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})`).bind(...COLS.map((c) => row[c])).run();
    return json({ data: await getSub(db, res.meta.last_row_id) }, 201);
  }

  if (!id) throw new HttpError(405, '不支援的操作');
  const sid = toInt(id, '訂閱');
  if (method === 'GET') return json({ data: await getSub(db, sid) });
  if (method === 'PUT') {
    await getSub(db, sid);
    const row = await prepare(db, await readJson(request));
    await db.prepare(`UPDATE subscriptions SET ${COLS.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE subscription_id = ?`).bind(...COLS.map((c) => row[c]), nowTW(), sid).run();
    return json({ data: await getSub(db, sid) });
  }
  if (method === 'DELETE') {
    const cur = await getSub(db, sid);
    if (cur.sales.length) throw new HttpError(409, `這個訂閱已出貨 ${cur.sales.length} 次，無法刪除，請改為「取消」`);
    await db.prepare('DELETE FROM subscriptions WHERE subscription_id = ?').bind(sid).run();
    return json({ ok: true });
  }
  throw new HttpError(405, '不支援的操作');
}
