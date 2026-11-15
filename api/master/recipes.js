// 產品配方（只放包材）
//   GET /api/recipes            → 全部產品的配方（產品列表＋配方文字）
//   GET /api/recipes/{product}  → 單一產品配方
//   PUT /api/recipes/{product}  → 整份覆寫 { items: [{ packaging_id, qty }] }
// 銷貨存檔時依配方扣包材（見 transaction/sales.js）；修改配方不影響已存檔的銷貨單

import { HttpError, json, readJson, toInt, round } from '../lib/http.js';

async function recipeOf(db, productId) {
  const p = await db.prepare('SELECT product_id, sku, name, net_weight_g FROM products WHERE product_id = ?').bind(productId).first();
  if (!p) throw new HttpError(404, '找不到產品');
  const { results } = await db.prepare(
    `SELECT r.recipe_id, r.packaging_id, r.qty, k.name, k.unit, k.unit_cost, v.current_qty, v.current_amount
     FROM product_recipes r JOIN packaging_items k ON k.packaging_id = r.packaging_id
     LEFT JOIN v_packaging_stock v ON v.packaging_id = r.packaging_id
     WHERE r.product_id = ? ORDER BY r.recipe_id`,
  ).bind(productId).all();
  for (const r of results) {
    r.avg_cost = r.current_qty > 0 ? round(r.current_amount / r.current_qty, 4) : r.unit_cost;
    r.cost = round(r.qty * (r.avg_cost || 0), 2);
  }
  return { ...p, items: results, packaging_cost: round(results.reduce((s, r) => s + r.cost, 0)) };
}

export async function handleRecipes(id, request, env) {
  const db = env.DB;
  const method = request.method;
  if (!id && method === 'GET') {
    const { results } = await db.prepare(
      `SELECT r.product_id, GROUP_CONCAT(k.name || ' × ' || printf('%g', r.qty), '、') AS recipe_text, COUNT(*) AS lines
       FROM product_recipes r JOIN packaging_items k ON k.packaging_id = r.packaging_id GROUP BY r.product_id`,
    ).all();
    return json({ data: results });
  }
  if (!id) throw new HttpError(405, '不支援的操作');
  const pid = toInt(id, '產品');
  if (method === 'GET') return json({ data: await recipeOf(db, pid) });
  if (method === 'PUT') {
    await recipeOf(db, pid);
    const body = await readJson(request);
    const items = [];
    const seen = new Set();
    for (const [i, raw] of (Array.isArray(body.items) ? body.items : []).entries()) {
      if (!raw.packaging_id && !raw.qty) continue;
      const packaging_id = toInt(raw.packaging_id, `第 ${i + 1} 筆包材`);
      if (seen.has(packaging_id)) throw new HttpError(400, '同一個包材請合併成一筆');
      seen.add(packaging_id);
      const qty = round(Number(raw.qty), 3);
      if (!Number.isFinite(qty) || qty <= 0) throw new HttpError(400, `第 ${i + 1} 筆：用量必須大於 0`);
      const k = await db.prepare('SELECT packaging_id FROM packaging_items WHERE packaging_id = ?').bind(packaging_id).first();
      if (!k) throw new HttpError(400, `第 ${i + 1} 筆：包材不存在`);
      items.push({ packaging_id, qty });
    }
    await db.batch([
      db.prepare('DELETE FROM product_recipes WHERE product_id = ?').bind(pid),
      ...items.map((it) => db.prepare('INSERT INTO product_recipes (product_id, packaging_id, qty) VALUES (?, ?, ?)').bind(pid, it.packaging_id, it.qty)),
    ]);
    return json({ data: await recipeOf(db, pid) });
  }
  throw new HttpError(405, '不支援的操作');
}
