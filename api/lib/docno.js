// 單號／批號流水號：{前綴}{YYYYMMDD}-{NN}，當日流水、只增不減（刪單後號碼不重複使用）

const SOURCES = {
  P: ['purchases', 'purchase_no'],     // 進貨單
  L: ['green_bean_lots', 'lot_no'],    // 生豆批號
  R: ['roast_batches', 'batch_no'],    // 烘焙批次（= 熟豆批號）
  S: ['sales', 'sale_no'],             // 銷貨單
};

const pad2 = (n) => String(n).padStart(2, '0');

export const makeNo = (prefix, ymd, n) => `${prefix}${ymd}-${pad2(n)}`;

/** 單號符合 {prefix}{ymd}-{n} 時回傳 n，否則 0 */
export const seqOf = (no, prefix, ymd) => {
  const m = String(no).match(new RegExp(`^${prefix}${ymd}-(\\d+)$`));
  return m ? Number(m[1]) : 0;
};

/** 取得某日某前綴目前已用到的最大流水號 */
export async function lastSeq(db, prefix, ymd) {
  const [table, col] = SOURCES[prefix];
  const seq = await db.prepare('SELECT last_no FROM doc_sequences WHERE prefix = ? AND ymd = ?').bind(prefix, ymd).first();
  const { results } = await db.prepare(`SELECT ${col} AS no FROM ${table} WHERE ${col} LIKE ?`).bind(`${prefix}${ymd}-%`).all();
  let max = seq?.last_no || 0;
  for (const r of results) {
    const m = r.no.match(/-(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** 更新流水號的語句（放進存檔的 batch） */
export function seqStatement(db, prefix, ymd, lastNo) {
  return db.prepare(
    `INSERT INTO doc_sequences (prefix, ymd, last_no) VALUES (?, ?, ?)
     ON CONFLICT(prefix, ymd) DO UPDATE SET last_no = MAX(last_no, excluded.last_no)`,
  ).bind(prefix, ymd, lastNo);
}
