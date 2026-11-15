// 財務查詢：應收帳款、應付帳款（帳齡）、費用分析
//   截止日 as_of：只計 as_of 當天（含）之前的單據與收付款（沖帳的收支日期 ≤ as_of）
//   帳齡 = as_of − 單據日期（天），分 0–30／31–60／61–90／90 天以上；另標示已過應收／應付日

import { HttpError, json, toInt, isDate, dateRange, round, todayTW } from '../lib/http.js';
import { paidExpr, returnsExpr } from '../lib/payment.js';

const BUCKETS = [['0-30', 30], ['31-60', 60], ['61-90', 90], ['90+', Infinity]];
const days = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
const zero = () => Object.fromEntries([...BUCKETS.map(([k]) => [k, 0]), ['total', 0], ['count', 0]]);

function aging(rows, asOf, partyKey) {
  const byParty = new Map();
  const total = zero();
  for (const r of rows) {
    r.paid = round(r.paid);
    r.remaining = round(r.total - r.paid);
    r.age = days(asOf, r.doc_date);
    r.bucket = BUCKETS.find(([, max]) => r.age <= max)[0];
    r.overdue = !!r.due_date && r.due_date < asOf;
    const key = r[partyKey] ?? '';
    const p = byParty.get(key) || { party_id: r[partyKey] ?? null, party: r.party || '（未指定）', ...zero(), docs: [] };
    p[r.bucket] = round(p[r.bucket] + r.remaining); p.total = round(p.total + r.remaining); p.count += 1; p.docs.push(r);
    total[r.bucket] = round(total[r.bucket] + r.remaining); total.total = round(total.total + r.remaining); total.count += 1;
    byParty.set(key, p);
  }
  return { data: [...byParty.values()].sort((a, b) => b.total - a.total), total };
}

function asOfParam(url) {
  const asOf = url.searchParams.get('as_of') || todayTW();
  if (!isDate(asOf)) throw new HttpError(400, '截止日格式錯誤（YYYY-MM-DD）');
  return asOf;
}
// 截止日的已收付（收付款 − 退款）與退貨折讓（退貨日 ≤ 截止日）
const paidAsOf = (type, pk) => paidExpr(type, pk, { asOf: '?1' });
const retAsOf = (type, pk) => returnsExpr(type, pk).replace('WHERE r.', 'WHERE r.return_date <= ?1 AND r.');

async function receivables(db, url) {
  const asOf = asOfParam(url);
  const cid = url.searchParams.get('customer_id');
  const { results } = await db.prepare(
    `SELECT 'sales' AS doc_type, s.sale_id AS doc_id, s.sale_no AS doc_no, s.sale_date AS doc_date, s.due_date,
            s.total_amount - ${retAsOf('sales', 's.sale_id')} AS total,
            s.customer_id, COALESCE(c.name, '散客') AS party, s.channel, s.payment_method, ${paidAsOf('sales', 's.sale_id')} AS paid
     FROM sales s LEFT JOIN customers c ON c.customer_id = s.customer_id
     WHERE s.sale_date <= ?1 AND s.total_amount - ${retAsOf('sales', 's.sale_id')} - ${paidAsOf('sales', 's.sale_id')} > 0.005
     ${cid === 'none' ? 'AND s.customer_id IS NULL' : cid ? 'AND s.customer_id = ?2' : ''}
     ORDER BY s.sale_date, s.sale_id`,
  ).bind(asOf, ...(cid && cid !== 'none' ? [toInt(cid, '客戶')] : [])).all();
  const r = aging(results, asOf, 'customer_id');
  // 應退客戶：已收 > 淨額（退貨／溢收）
  const { results: refunds } = await db.prepare(
    `SELECT s.sale_id AS doc_id, s.sale_no AS doc_no, s.sale_date AS doc_date, COALESCE(c.name, '散客') AS party,
            ${paidAsOf('sales', 's.sale_id')} - (s.total_amount - ${retAsOf('sales', 's.sale_id')}) AS amount
     FROM sales s LEFT JOIN customers c ON c.customer_id = s.customer_id
     WHERE s.sale_date <= ?1 AND ${paidAsOf('sales', 's.sale_id')} - (s.total_amount - ${retAsOf('sales', 's.sale_id')}) > 0.005
     ORDER BY s.sale_date`,
  ).bind(asOf).all();
  for (const x of refunds) x.amount = round(x.amount);
  r.refunds = refunds;
  r.refund_total = round(refunds.reduce((s2, x) => s2 + x.amount, 0));
  // 客戶信用額度
  const { results: limits } = await db.prepare('SELECT customer_id, credit_limit FROM customers WHERE credit_limit > 0').all();
  const lim = new Map(limits.map((x) => [x.customer_id, x.credit_limit]));
  for (const p of r.data) { p.credit_limit = lim.get(p.party_id) ?? null; p.over_limit = p.credit_limit != null && p.total > p.credit_limit; }
  return json({ as_of: asOf, ...r });
}

async function payables(db, url) {
  const asOf = asOfParam(url);
  const sid = url.searchParams.get('supplier_id');
  const type = url.searchParams.get('type'); // purchases｜expenses｜空白 = 全部
  const rows = [];
  if (type !== 'expenses') {
    const { results } = await db.prepare(
      `SELECT 'purchases' AS doc_type, p.purchase_id AS doc_id, p.purchase_no AS doc_no, p.purchase_date AS doc_date, p.due_date,
              p.total_amount - ${retAsOf('purchases', 'p.purchase_id')} AS total,
              'S' || p.supplier_id AS party_key, s.name AS party, p.invoice_no, '進貨' AS kind, ${paidAsOf('purchases', 'p.purchase_id')} AS paid
       FROM purchases p JOIN suppliers s ON s.supplier_id = p.supplier_id
       WHERE p.purchase_date <= ?1 AND p.total_amount - ${retAsOf('purchases', 'p.purchase_id')} - ${paidAsOf('purchases', 'p.purchase_id')} > 0.005
       ${sid ? 'AND p.supplier_id = ?2' : ''}
       ORDER BY p.purchase_date, p.purchase_id`,
    ).bind(asOf, ...(sid ? [toInt(sid, '供應商')] : [])).all();
    rows.push(...results);
  }
  if (type !== 'purchases' && !sid) {
    const { results } = await db.prepare(
      `SELECT 'expenses' AS doc_type, e.expense_id AS doc_id, e.expense_no AS doc_no, e.expense_date AS doc_date, e.due_date, e.amount AS total,
              'V' || COALESCE(e.vendor, '') AS party_key, COALESCE(NULLIF(e.vendor, ''), '（費用未填廠商）') AS party, e.invoice_no,
              '費用：' || c.name AS kind, ${paidAsOf('expenses', 'e.expense_id')} AS paid
       FROM expenses e JOIN expense_categories c ON c.category_id = e.category_id
       WHERE e.expense_date <= ?1 AND e.amount - ${paidAsOf('expenses', 'e.expense_id')} > 0.005
       ORDER BY e.expense_date, e.expense_id`,
    ).bind(asOf).all();
    rows.push(...results);
  }
  return json({ as_of: asOf, ...aging(rows, asOf, 'party_key') });
}

async function expenseSummary(db, url) {
  const { from, to } = dateRange(url);
  const where = [];
  const binds = [];
  if (from) { where.push('e.expense_date >= ?'); binds.push(from); }
  if (to) { where.push('e.expense_date <= ?'); binds.push(to); }
  const { results } = await db.prepare(
    `SELECT c.category_id, c.name, substr(e.expense_date, 1, 7) AS ym,
            SUM(e.amount) AS amount, COUNT(*) AS count, SUM(CASE WHEN e.allocate_to_roast = 1 THEN e.amount ELSE 0 END) AS roast_amount
     FROM expenses e JOIN expense_categories c ON c.category_id = e.category_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     GROUP BY c.category_id, ym ORDER BY c.category_id, ym`,
  ).bind(...binds).all();
  const months = [...new Set(results.map((r) => r.ym))].sort();
  const byCat = new Map();
  for (const r of results) {
    const c = byCat.get(r.category_id) || { category_id: r.category_id, name: r.name, amount: 0, count: 0, roast_amount: 0, months: {} };
    c.amount = round(c.amount + r.amount); c.count += r.count; c.roast_amount = round(c.roast_amount + r.roast_amount);
    c.months[r.ym] = round(r.amount);
    byCat.set(r.category_id, c);
  }
  const data = [...byCat.values()].sort((a, b) => b.amount - a.amount);
  const total = round(data.reduce((s, c) => s + c.amount, 0));
  for (const c of data) c.share = total ? round(c.amount / total, 4) : 0;
  const monthTotals = Object.fromEntries(months.map((m) => [m, round(data.reduce((s, c) => s + (c.months[m] || 0), 0))]));
  return json({ from, to, months, data, total, month_totals: monthTotals, roast_amount: round(data.reduce((s, c) => s + c.roast_amount, 0)) });
}

export async function handleFinance(sub, request, env) {
  if (request.method !== 'GET') throw new HttpError(405, '不支援的操作');
  const url = new URL(request.url);
  if (sub === 'receivables') return receivables(env.DB, url);
  if (sub === 'payables') return payables(env.DB, url);
  if (sub === 'expense-summary') return expenseSummary(env.DB, url);
  throw new HttpError(404, '找不到此查詢');
}
