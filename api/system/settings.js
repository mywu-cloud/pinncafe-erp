// 商店資料（列印單據抬頭用）
//   shop_settings：key / value 設定表。資料表不存在時自動建立，所以既有資料庫不用另外跑 migration。
//   GET /api/shop → { data: { shop_name, tax_id, phone, address, contact, bank_info, sales_note } }
//   PUT /api/shop → 整份覆寫（沒帶的欄位視為清空）

import { HttpError, json, readJson, nowTW } from '../lib/http.js';

export const SHOP_FIELDS = {
  shop_name: { label: '店名／公司名稱', max: 60 },
  tax_id: { label: '統一編號', max: 8 },
  phone: { label: '電話', max: 40 },
  address: { label: '地址', max: 120 },
  contact: { label: '其他聯絡方式', max: 120 },
  bank_info: { label: '匯款資訊', max: 300 },
  sales_note: { label: '銷貨單備註', max: 500 },
};

const CREATE = `CREATE TABLE IF NOT EXISTS shop_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
)`;

/** 讀取商店資料（沒有設定的欄位回空字串） */
export async function getShop(db) {
  let rows = [];
  try {
    rows = (await db.prepare('SELECT key, value FROM shop_settings').all()).results;
  } catch (e) {
    if (!/no such table/i.test(String(e?.message || e))) throw e;
    await db.prepare(CREATE).run();
  }
  const out = Object.fromEntries(Object.keys(SHOP_FIELDS).map((k) => [k, '']));
  for (const r of rows) if (r.key in out) out[r.key] = r.value ?? '';
  return out;
}

export async function handleShop(id, request, env) {
  if (id) throw new HttpError(404, '找不到此路徑');
  const db = env.DB;
  if (request.method === 'GET') return json({ data: await getShop(db) });
  if (request.method !== 'PUT') throw new HttpError(405, '不支援的操作');

  const body = await readJson(request);
  const data = {};
  for (const [k, f] of Object.entries(SHOP_FIELDS)) {
    const v = String(body[k] ?? '').trim();
    if (v.length > f.max) throw new HttpError(400, `${f.label}最多 ${f.max} 個字`);
    data[k] = v;
  }
  if (data.tax_id && !/^\d{8}$/.test(data.tax_id)) throw new HttpError(400, '統一編號必須是 8 位數字');
  await getShop(db); // 確保資料表存在
  const now = nowTW();
  await db.batch(Object.entries(data).map(([k, v]) => db.prepare(
    `INSERT INTO shop_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(k, v, now)));
  return json({ data });
}
