// 收付款狀態：一律由 payment_allocations（沖帳）加總決定，不手動修改
//   銷貨：未收／部分收款／已收清；進貨、費用：未付／部分付款／已付清
//   金額為 0 的單據直接視為已收清／已付清。已沖金額大於單據金額 = 溢收（狀態仍為已收清，另外提示）

import { round } from './http.js';

export const DOCS = {
  sales: { table: 'sales', pk: 'sale_id', no: 'sale_no', date: 'sale_date', label: '銷貨單', status: ['未收', '部分收款', '已收清'] },
  purchases: { table: 'purchases', pk: 'purchase_id', no: 'purchase_no', date: 'purchase_date', label: '進貨單', status: ['未付', '部分付款', '已付清'] },
  expenses: { table: 'expenses', pk: 'expense_id', no: 'expense_no', date: 'expense_date', label: '費用', amount: 'amount', status: ['未付', '部分付款', '已付清'] },
};
export const totalCol = (d) => d.amount || 'total_amount';

/** 重算單據收付款狀態的 UPDATE 語句（ids 省略 = 整張表） */
export function statusStatement(db, docType, ids = null) {
  const d = DOCS[docType];
  const [none, part, full] = d.status;
  const paid = `COALESCE((SELECT SUM(a.amount) FROM payment_allocations a WHERE a.doc_type = '${docType}' AND a.doc_id = ${d.table}.${d.pk}), 0)`;
  const tot = totalCol(d);
  const list = ids ? [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : null;
  if (list && !list.length) return null;
  return db.prepare(
    `UPDATE ${d.table} SET payment_status = CASE
       WHEN ${tot} <= 0.005 THEN '${full}'
       WHEN ${paid} <= 0.005 THEN '${none}'
       WHEN ${paid} + 0.005 >= ${tot} THEN '${full}'
       ELSE '${part}' END
     ${list ? `WHERE ${d.pk} IN (${list.map(() => '?').join(',')})` : ''}`,
  ).bind(...(list || []));
}

/** 單據的沖帳明細與已沖金額 */
export async function docPayments(db, docType, id) {
  const { results } = await db.prepare(
    `SELECT a.allocation_id, a.amount, t.txn_id, t.txn_no, t.txn_date, t.direction, ba.account_name
     FROM payment_allocations a
     JOIN bank_transactions t ON t.txn_id = a.txn_id
     JOIN bank_accounts ba ON ba.account_id = t.account_id
     WHERE a.doc_type = ? AND a.doc_id = ? ORDER BY t.txn_date, t.txn_id`,
  ).bind(docType, id).all();
  return { payments: results, paid_amount: round(results.reduce((s, r) => s + r.amount, 0)) };
}
