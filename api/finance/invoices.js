// 發票（手動登錄；實際開立仍在原本的發票平台）
//   一張銷貨單同時只能有一張未作廢的發票
//   amount 含稅，預設 = 銷貨單淨額；sales_amount = round(amount ÷ 1.05)、tax_amount = amount − sales_amount
//   發票號碼格式：2 個英文字母 ＋ 8 位數字（自動轉大寫、去掉 -）
//   三聯式必須填買方統編；統編為 8 位數字
//   作廢：POST /api/invoices/{id}/void { void_date, void_reason }；登錄錯誤可直接刪除

import { HttpError, json, readJson, toInt, isDate, dateRange, nowTW, round } from '../lib/http.js';
import { docBalance } from '../lib/payment.js';

export const INVOICE_TYPES = ['二聯', '三聯', '電子發票'];
export const TAX_RATE = 0.05;

export const splitTax = (amount) => {
  const sales_amount = Math.round(amount / (1 + TAX_RATE));
  return { sales_amount, tax_amount: round(amount - sales_amount) };
};

async function prepare(db, body, { excludeId = null } = {}) {
  const sale_id = toInt(body.sale_id, '銷貨單');
  const sale = await db.prepare(
    'SELECT s.sale_id, s.sale_no, s.customer_id, c.name AS customer_name, c.tax_id FROM sales s LEFT JOIN customers c ON c.customer_id = s.customer_id WHERE s.sale_id = ?',
  ).bind(sale_id).first();
  if (!sale) throw new HttpError(400, '銷貨單不存在');
  const invoice_no = String(body.invoice_no || '').toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z]{2}\d{8}$/.test(invoice_no)) throw new HttpError(400, '發票號碼格式應為 2 個英文字母 ＋ 8 位數字（例：AB12345678）');
  if (!isDate(body.invoice_date)) throw new HttpError(400, '發票日期格式錯誤（YYYY-MM-DD）');
  const invoice_type = body.invoice_type || '電子發票';
  if (!INVOICE_TYPES.includes(invoice_type)) throw new HttpError(400, `發票類型必須是：${INVOICE_TYPES.join('／')}`);
  const buyer_tax_id = String(body.buyer_tax_id ?? '').trim() || null;
  if (buyer_tax_id && !/^\d{8}$/.test(buyer_tax_id)) throw new HttpError(400, '買方統編必須是 8 位數字');
  if (invoice_type === '三聯' && !buyer_tax_id) throw new HttpError(400, '三聯式發票必須填買方統編');

  const dup = await db.prepare('SELECT invoice_id, sale_id FROM invoices WHERE invoice_no = ?').bind(invoice_no).first();
  if (dup && dup.invoice_id !== excludeId) throw new HttpError(409, `發票號碼 ${invoice_no} 已登錄過`);
  const active = await db.prepare("SELECT invoice_no FROM invoices WHERE sale_id = ? AND status <> '作廢' AND invoice_id <> ?").bind(sale_id, excludeId ?? -1).first();
  if (active) throw new HttpError(409, `銷貨單 ${sale.sale_no} 已有發票 ${active.invoice_no}，請先作廢再開新的`);

  let amount = body.amount === undefined || body.amount === null || body.amount === '' ? null : round(Number(body.amount));
  if (amount === null) amount = Math.max(0, (await docBalance(db, 'sales', sale_id)).net);
  if (!Number.isFinite(amount) || amount < 0) throw new HttpError(400, '發票金額不可為負數');
  return {
    sale_id, invoice_no, invoice_date: body.invoice_date, invoice_type, buyer_tax_id,
    buyer_name: String(body.buyer_name ?? '').trim() || (buyer_tax_id ? sale.customer_name : null),
    carrier: String(body.carrier ?? '').trim() || null,
    amount, ...splitTax(amount),
    note: String(body.note ?? '').trim() || null,
  };
}

const COLS = ['sale_id', 'invoice_no', 'invoice_date', 'invoice_type', 'buyer_tax_id', 'buyer_name', 'carrier', 'amount', 'sales_amount', 'tax_amount', 'note'];

async function getInvoice(db, id) {
  const r = await db.prepare(
    `SELECT i.*, s.sale_no, s.sale_date, s.total_amount AS sale_total, c.name AS customer_name
     FROM invoices i JOIN sales s ON s.sale_id = i.sale_id LEFT JOIN customers c ON c.customer_id = s.customer_id WHERE i.invoice_id = ?`,
  ).bind(id).first();
  if (!r) throw new HttpError(404, '找不到發票');
  return r;
}

/** 營業稅申報期別：1-2 月、3-4 月… */
const periodOf = (date) => {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const start = m % 2 === 0 ? m - 1 : m;
  return `${y}/${String(start).padStart(2, '0')}-${String(start + 1).padStart(2, '0')}`;
};

export async function handleInvoices(id, sub, request, env, user) {
  const db = env.DB;
  const url = new URL(request.url);
  const method = request.method;
  const sp = url.searchParams;

  // 尚未開發票的銷貨單
  if (id === 'uninvoiced' && method === 'GET') {
    const { from, to } = dateRange(url);
    const where = ["NOT EXISTS (SELECT 1 FROM invoices i WHERE i.sale_id = s.sale_id AND i.status <> '作廢')", 's.total_amount > 0'];
    const binds = [];
    if (from) { where.push('s.sale_date >= ?'); binds.push(from); }
    if (to) { where.push('s.sale_date <= ?'); binds.push(to); }
    const { results } = await db.prepare(
      `SELECT s.sale_id, s.sale_no, s.sale_date, s.total_amount, s.channel, COALESCE(c.name, '散客') AS customer_name, c.tax_id
       FROM sales s LEFT JOIN customers c ON c.customer_id = s.customer_id WHERE ${where.join(' AND ')} ORDER BY s.sale_date, s.sale_id`,
    ).bind(...binds).all();
    return json({ data: results, total: round(results.reduce((s2, r) => s2 + r.total_amount, 0)) });
  }

  if (!id && method === 'GET') {
    const { from, to } = dateRange(url);
    const where = [];
    const binds = [];
    if (from) { where.push('i.invoice_date >= ?'); binds.push(from); }
    if (to) { where.push('i.invoice_date <= ?'); binds.push(to); }
    if (sp.get('invoice_type')) { where.push('i.invoice_type = ?'); binds.push(sp.get('invoice_type')); }
    if (sp.get('status')) { where.push('i.status = ?'); binds.push(sp.get('status')); }
    const q = (sp.get('q') || '').trim();
    if (q) { where.push('(i.invoice_no LIKE ? OR i.buyer_tax_id LIKE ? OR i.buyer_name LIKE ? OR s.sale_no LIKE ?)'); binds.push(...Array(4).fill(`%${q.toUpperCase()}%`)); }
    const { results } = await db.prepare(
      `SELECT i.*, s.sale_no, COALESCE(c.name, '散客') AS customer_name
       FROM invoices i JOIN sales s ON s.sale_id = i.sale_id LEFT JOIN customers c ON c.customer_id = s.customer_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY i.invoice_date DESC, i.invoice_no DESC`,
    ).bind(...binds).all();
    const valid = results.filter((r) => r.status !== '作廢');
    const byPeriod = new Map();
    for (const r of valid) {
      const k = periodOf(r.invoice_date);
      const p = byPeriod.get(k) || { period: k, count: 0, amount: 0, sales_amount: 0, tax_amount: 0 };
      p.count += 1; p.amount = round(p.amount + r.amount); p.sales_amount = round(p.sales_amount + r.sales_amount); p.tax_amount = round(p.tax_amount + r.tax_amount);
      byPeriod.set(k, p);
    }
    return json({
      from, to, data: results,
      summary: {
        count: valid.length, void_count: results.length - valid.length,
        amount: round(valid.reduce((s2, r) => s2 + r.amount, 0)),
        sales_amount: round(valid.reduce((s2, r) => s2 + r.sales_amount, 0)),
        tax_amount: round(valid.reduce((s2, r) => s2 + r.tax_amount, 0)),
      },
      periods: [...byPeriod.values()].sort((a, b) => b.period.localeCompare(a.period)),
    });
  }

  if (!id && method === 'POST') {
    const row = await prepare(db, await readJson(request));
    const res = await db.prepare(`INSERT INTO invoices (${COLS.join(', ')}, created_by) VALUES (${COLS.map(() => '?').join(', ')}, ?)`)
      .bind(...COLS.map((c) => row[c]), user).run();
    return json({ data: await getInvoice(db, res.meta.last_row_id) }, 201);
  }

  if (!id) throw new HttpError(405, '不支援的操作');
  const iid = toInt(id, '發票');

  if (sub === 'void' && method === 'POST') {
    const cur = await getInvoice(db, iid);
    if (cur.status === '作廢') throw new HttpError(409, '這張發票已經作廢');
    const body = await readJson(request);
    if (!isDate(body.void_date)) throw new HttpError(400, '作廢日期格式錯誤（YYYY-MM-DD）');
    await db.prepare("UPDATE invoices SET status = '作廢', void_date = ?, void_reason = ?, updated_at = ? WHERE invoice_id = ?")
      .bind(body.void_date, String(body.void_reason ?? '').trim() || null, nowTW(), iid).run();
    return json({ data: await getInvoice(db, iid) });
  }
  if (sub) throw new HttpError(404, '找不到此路徑');

  if (method === 'GET') return json({ data: await getInvoice(db, iid) });
  if (method === 'PUT') {
    const cur = await getInvoice(db, iid);
    if (cur.status === '作廢') throw new HttpError(409, '已作廢的發票不能修改');
    const body = await readJson(request);
    body.sale_id = cur.sale_id;
    const row = await prepare(db, body, { excludeId: iid });
    const status = ['開立', '折讓'].includes(body.status) ? body.status : cur.status;
    await db.prepare(`UPDATE invoices SET ${COLS.map((c) => `${c} = ?`).join(', ')}, status = ?, updated_at = ? WHERE invoice_id = ?`)
      .bind(...COLS.map((c) => row[c]), status, nowTW(), iid).run();
    return json({ data: await getInvoice(db, iid) });
  }
  if (method === 'DELETE') {
    await getInvoice(db, iid);
    await db.prepare('DELETE FROM invoices WHERE invoice_id = ?').bind(iid).run();
    return json({ ok: true });
  }
  throw new HttpError(405, '不支援的操作');
}
