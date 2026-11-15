// 角色權限
//   登入由 Cloudflare Access 負責；這裡依 users.role 決定能看（GET）／能改（其他方法）哪些模組
//   users 表為空時，第一個登入的人自動成為管理者

import { HttpError, nowTW } from './http.js';

export const ROLES = ['管理者', '烘豆師', '門市', '會計'];

/** API 資源 → 模組 */
export const MODULE_OF = {
  suppliers: 'products', 'green-beans': 'products', 'roasted-beans': 'products', 'packaging-items': 'products', products: 'products', recipes: 'products',
  customers: 'customers',
  purchases: 'purchasing',
  'roast-batches': 'production', 'opening-stock': 'production', 'stock-counts': 'production',
  inventory: 'inventory',
  sales: 'sales', subscriptions: 'sales', invoices: 'sales',
  returns: 'returns',
  'bank-transactions': 'finance', expenses: 'finance', finance: 'finance', 'bank-accounts': 'finance', 'expense-categories': 'finance', reconcile: 'finance',
  reports: 'reports',
  users: 'system', 'audit-logs': 'system', backup: 'system',
};
export const MODULE_LABELS = {
  products: '主檔（產品、生豆、包材、供應商）', customers: '客戶', purchasing: '進貨', production: '烘焙／盤點／期初', inventory: '庫存查詢',
  sales: '銷貨／訂閱／發票', returns: '退貨折讓', finance: '財務', reports: '報表', system: '系統（使用者、日誌、備份）',
};
const ALL = Object.keys(MODULE_LABELS);

/** 角色 → 可看／可改的模組（可改一定可看） */
export const ROLE_PERMS = {
  管理者: { write: ALL, read: ALL },
  烘豆師: { write: ['products', 'purchasing', 'production', 'returns'], read: ['customers', 'inventory', 'sales', 'reports'] },
  門市: { write: ['customers', 'sales', 'returns'], read: ['products', 'inventory'] },
  會計: { write: ['finance', 'purchasing', 'sales', 'returns'], read: ['products', 'customers', 'production', 'inventory', 'reports'] },
};
export function permsOf(role) {
  const p = ROLE_PERMS[role] || { write: [], read: [] };
  return { write: [...p.write], read: [...new Set([...p.read, ...p.write])] };
}

export function assertCan(user, resource, method) {
  const module = MODULE_OF[resource];
  if (!module) return; // me 等不需權限
  const p = permsOf(user.role);
  const need = method === 'GET' ? 'read' : 'write';
  if (!p[need].includes(module)) {
    throw new HttpError(403, `你的角色「${user.role}」沒有${need === 'read' ? '查看' : '修改'}「${MODULE_LABELS[module]}」的權限`);
  }
}

/** 由 email 取得使用者；名單為空時自動建立第一位管理者 */
export async function loadUser(db, email) {
  let u = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!u) {
    const n = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
    if (n.n === 0) {
      await db.prepare("INSERT INTO users (email, name, role, note) VALUES (?, ?, '管理者', '第一位登入者，自動設為管理者')").bind(email, email.split('@')[0]).run();
      u = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    } else {
      throw new HttpError(403, `帳號 ${email} 不在使用者名單中，請管理者到「系統 → 使用者」新增`);
    }
  }
  if (!u.is_active) throw new HttpError(403, `帳號 ${email} 已停用`);
  // 最後登入時間：超過 10 分鐘才更新，避免每個請求都寫入
  const stale = !u.last_login_at || Date.parse(u.last_login_at.replace(' ', 'T') + '+08:00') < Date.now() - 600_000;
  if (stale) await db.prepare('UPDATE users SET last_login_at = ? WHERE user_id = ?').bind(nowTW(), u.user_id).run();
  return u;
}
