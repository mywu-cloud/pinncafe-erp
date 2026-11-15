// 主檔匯入、全部資料備份（Phase 5）
//   GET  /api/import/{resource}  → 匯入欄位（範本用）
//   POST /api/import/{resource}  → { rows: [{ 中文欄名或欄位: 值 }], dry_run? }
//        前端讀 Excel／CSV 後送來；先全部檢查，有任何錯誤就整批不匯入並回傳每列錯誤
//        名稱（產品另可用料號）已存在 → 更新；不存在 → 新增
//        關聯欄位（供應商、熟豆品項）填名稱，系統對應到 id
//   GET  /api/backup             → 所有資料表的全部資料（前端存成多工作表 Excel）

import { HttpError, json, readJson } from '../lib/http.js';
import { resources } from '../master/resources.js';
import { clean } from '../master/crud.js';

const BOOL_LABEL = '啟用（是／否）';
/** 可匯入的主檔：欄位 → 中文欄名；fk：關聯欄位改填名稱 */
export const IMPORTS = {
  suppliers: {
    key: ['name'],
    cols: [['name', '名稱'], ['tax_id', '統一編號'], ['contact_name', '聯絡人'], ['phone', '電話'], ['email', 'Email'], ['address', '地址'],
      ['country', '國家'], ['payment_terms', '付款條件'], ['bank_info', '匯款資訊'], ['note', '備註'], ['is_active', BOOL_LABEL]],
  },
  customers: {
    key: ['name'],
    cols: [['name', '姓名／公司名'], ['customer_type', '客戶類型（零售／批發／咖啡廳／電商）'], ['price_level', '價格等級（零售價／批發價／VIP）'], ['tax_id', '統一編號'],
      ['phone', '電話'], ['email', 'Email'], ['line_id', 'LINE ID'], ['shipping_address', '收件地址'], ['payment_terms', '付款條件'], ['credit_limit', '信用額度'],
      ['birthday', '生日（YYYY-MM-DD）'], ['source', '客戶來源'], ['note', '備註'], ['is_active', BOOL_LABEL]],
  },
  'green-beans': {
    key: ['name'],
    cols: [['name', '品名'], ['country', '國家'], ['region', '產區'], ['farm', '莊園／處理廠'], ['process', '處理法（水洗／日曬／蜜處理／厭氧／其他）'], ['variety', '品種'],
      ['altitude', '海拔'], ['crop_year', '產季'], ['cupping_score', '杯測分數'], ['default_supplier_id', '常用供應商（名稱）'], ['safety_stock_kg', '安全庫存 kg'], ['note', '備註'], ['is_active', BOOL_LABEL]],
    fk: { default_supplier_id: ['suppliers', 'supplier_id'] },
  },
  'packaging-items': {
    key: ['name'],
    cols: [['name', '名稱'], ['unit', '單位'], ['unit_cost', '參考單價'], ['supplier_id', '供應商（名稱）'], ['safety_stock', '安全庫存'], ['note', '備註'], ['is_active', BOOL_LABEL]],
    fk: { supplier_id: ['suppliers', 'supplier_id'] },
  },
  products: {
    key: ['sku', 'name'],
    cols: [['sku', '料號／條碼'], ['name', '產品名稱'], ['category', '類別（單品豆／綜合豆／濾掛／禮盒／器具／其他）'], ['roast_level', '烘焙度（淺焙／中焙／中深焙／深焙）'],
      ['net_weight_g', '每包淨重 g'], ['retail_price', '零售價'], ['wholesale_price', '批發價'], ['shelf_life_days', '賞味期（天）'],
      ['roasted_bean_id', '使用熟豆品項（名稱）'], ['note', '備註'], ['is_active', BOOL_LABEL]],
    fk: { roasted_bean_id: ['roasted_beans', 'roasted_bean_id'] },
  },
};

export async function handleImport(resource, extra, request, env) {
  const db = env.DB;
  const imp = IMPORTS[resource];
  if (!imp || extra) throw new HttpError(404, '這個資料不支援匯入');
  const r = resources[resource];
  if (request.method === 'GET') {
    return json({ data: { resource, label: r.label, cols: imp.cols.map(([field, label]) => ({ field, label, required: !!r.fields[field]?.required })) } });
  }
  if (request.method !== 'POST') throw new HttpError(405, '不支援的操作');
  const body = await readJson(request);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) throw new HttpError(400, '檔案裡沒有資料列');
  if (rows.length > 2000) throw new HttpError(400, '一次最多匯入 2000 列');

  // 關聯欄位：名稱 → id
  const fkMaps = {};
  for (const [field, [table, pk]] of Object.entries(imp.fk || {})) {
    const { results } = await db.prepare(`SELECT ${pk} AS id, name FROM ${table}`).all();
    fkMaps[field] = new Map(results.map((x) => [String(x.name).trim(), x.id]));
  }
  const { results: existing } = await db.prepare(`SELECT ${r.pk} AS id, ${imp.key.join(', ')} FROM ${r.table}`).all();
  const byKey = imp.key.map((k) => new Map(existing.filter((x) => x[k]).map((x) => [String(x[k]).trim(), x.id])));

  const errors = [];
  const ops = [];
  const seen = new Set();
  rows.forEach((raw, i) => {
    const line = i + 2; // 第 1 列是標題
    const src = {};
    for (const [field, label] of imp.cols) {
      let v = raw[label] ?? raw[field];
      if (v instanceof Object && 'text' in v) v = v.text; // Excel 超連結儲存格
      if (typeof v === 'string') v = v.trim();
      src[field] = v === undefined ? undefined : v;
    }
    if (Object.values(src).every((v) => v === undefined || v === null || v === '')) return; // 空白列
    try {
      if (src.is_active !== undefined && src.is_active !== null && src.is_active !== '') {
        const s = String(src.is_active).trim();
        src.is_active = ['否', 'N', 'n', '0', 'false', '停用'].includes(s) ? 0 : 1;
      }
      for (const field of Object.keys(imp.fk || {})) {
        const name = src[field];
        if (name === undefined) continue; // 檔案沒有這一欄 → 不動
        if (name === null || name === '') { src[field] = null; continue; } // 有這一欄但空白 → 清空
        const id = fkMaps[field].get(String(name).trim());
        if (!id) throw new HttpError(400, `找不到「${name}」（${imp.cols.find((c) => c[0] === field)[1]}）`);
        src[field] = id;
      }
      // 日期儲存格可能是 Excel 日期物件 → YYYY-MM-DD
      for (const [field, f] of Object.entries(r.fields)) {
        if (f.type === 'date' && src[field] && !/^\d{4}-\d{2}-\d{2}$/.test(String(src[field]))) {
          const d = new Date(src[field]);
          if (!Number.isNaN(d.getTime())) src[field] = new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
        }
      }
      // 已存在 → 只更新檔案裡有的欄位；新增 → 套用預設值
      let id = null;
      for (const [ki, k] of imp.key.entries()) {
        if (src[k]) { id = byKey[ki].get(String(src[k]).trim()) || null; if (id) break; }
      }
      const present = Object.fromEntries(Object.entries(src).filter(([, v]) => v !== undefined));
      const data = clean(r.fields, present, { partial: !!id });
      if (!id && !data.name) throw new HttpError(400, '名稱為必填');
      const msg = r.validate?.({ ...data });
      if (msg) throw new HttpError(400, msg);
      const dupKey = String(id ? `id:${id}` : `name:${data.name}`);
      if (seen.has(dupKey)) throw new HttpError(400, '檔案中重複出現同一筆資料');
      seen.add(dupKey);
      ops.push({ id, data, line });
    } catch (e) {
      errors.push({ line, error: e.message.replace(/「(\w+)」/g, (m, f) => `「${imp.cols.find((c) => c[0] === f)?.[1] || f}」`) });
    }
  });
  if (errors.length) return json({ ok: false, errors, total: rows.length }, 400);
  const summary = { insert: ops.filter((o) => !o.id).length, update: ops.filter((o) => o.id).length };
  if (body.dry_run) return json({ ok: true, dry_run: true, ...summary });

  const stmts = ops.map((o) => {
    const cols = Object.keys(o.data);
    return o.id
      ? db.prepare(`UPDATE ${r.table} SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now','+8 hours') WHERE ${r.pk} = ?`).bind(...cols.map((c) => o.data[c]), o.id)
      : db.prepare(`INSERT INTO ${r.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...cols.map((c) => o.data[c]));
  });
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
  return json({ ok: true, ...summary });
}

export async function handleBackup(request, env) {
  if (request.method !== 'GET') throw new HttpError(405, '不支援的操作');
  const db = env.DB;
  const { results: tables } = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name",
  ).all();
  const out = {};
  for (const { name } of tables) {
    const { results } = await db.prepare(`SELECT * FROM "${name}"`).all();
    out[name] = results;
  }
  return json({ generated_at: new Date().toISOString(), tables: out });
}
