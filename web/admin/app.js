// 咖啡烘豆進銷存 — 後台管理（Phase 1～5）
// 純 JavaScript，無建置步驟。顏色慣例：紅 = 增加／入庫，綠 = 減少／出庫。
'use strict';

// ---------------------------------------------------------------- 工具
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 0) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }));
const kg = (n) => fmt(n, 2);
const money = (n) => fmt(n, 0);
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const monthStart = () => today().slice(0, 8) + '01';

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok) {
    const err = new Error(data?.error || `發生錯誤（${res.status}）`);
    err.status = res.status;
    err.data = data;
    err.detail = data?.detail ?? null; // 例：銷貨熟豆不足 { code: 'SHORTAGE', shortages }
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isErr ? 5000 : 2200);
}
const fail = (e) => toast(e.message || String(e), true);

function openModal(html, wide = false) {
  const box = $('#modalBox');
  box.className = 'modal-box' + (wide ? ' wide' : '');
  box.innerHTML = html;
  $('#modal').hidden = false;
  return box;
}
function closeModal() { $('#modal').hidden = true; $('#modalBox').innerHTML = ''; }

const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== '' && v !== null && v !== undefined) p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
};

// 下拉選單用的主檔快取
const cache = {};
async function lookup(resource, force = false) {
  if (!cache[resource] || force) cache[resource] = (await api('/' + resource)).data;
  return cache[resource];
}
const options = (rows, idKey, selected, { blank = '（未選擇）', label = (r) => r.name } = {}) =>
  (blank === null ? '' : `<option value="">${esc(blank)}</option>`) +
  rows.filter((r) => r.is_active || r[idKey] === selected)
    .map((r) => `<option value="${r[idKey]}" ${r[idKey] === selected ? 'selected' : ''}>${esc(label(r))}</option>`).join('');

// ---------------------------------------------------------------- 主檔定義
const ROAST = ['淺焙', '中焙', '中深焙', '深焙'];
const GRIND = ['原豆', '手沖', '義式', '法壓', '冷萃'];
const MASTERS = {
  suppliers: {
    title: '供應商', pk: 'supplier_id',
    cols: [['name', '名稱'], ['contact_name', '聯絡人'], ['phone', '電話'], ['country', '國家'], ['payment_terms', '付款條件']],
    fields: [
      ['name', '名稱', 'text', { required: true }], ['tax_id', '統一編號'], ['contact_name', '聯絡人'], ['phone', '電話'],
      ['email', 'Email'], ['country', '國家'], ['payment_terms', '付款條件（現結／月結 30 天）'],
      ['address', '地址', 'text', { full: true }], ['bank_info', '匯款備註（舊資料；帳戶請填下方「匯款帳戶」）', 'text', { full: true }], ['note', '備註', 'textarea', { full: true }],
    ],
  },
  customers: {
    title: '客戶', pk: 'customer_id',
    cols: [['name', '姓名／公司'], ['customer_type', '類型'], ['price_level', '價格等級'], ['phone', '電話'], ['payment_terms', '付款條件']],
    fields: [
      ['name', '姓名／公司名', 'text', { required: true }],
      ['customer_type', '客戶類型', 'enum', { values: ['零售', '批發', '咖啡廳', '電商'], noBlank: true }],
      ['price_level', '價格等級', 'enum', { values: ['零售價', '批發價', 'VIP'], noBlank: true }],
      ['tax_id', '統一編號'], ['phone', '電話'], ['email', 'Email'], ['line_id', 'LINE ID'],
      ['payment_terms', '付款條件（現結／月結）'], ['credit_limit', '信用額度', 'number'], ['birthday', '生日', 'date'], ['source', '客戶來源'],
      ['shipping_address', '收件地址', 'text', { full: true }], ['note', '備註', 'textarea', { full: true }],
    ],
  },
  'green-beans': {
    title: '生豆品項', pk: 'bean_id',
    cols: [['name', '品名'], ['country', '國家'], ['region', '產區'], ['process', '處理法'], ['default_supplier_name', '常用供應商'], ['safety_stock_kg', '安全庫存 kg', 'num']],
    fields: [
      ['name', '品名', 'text', { required: true, full: true }], ['country', '國家'], ['region', '產區'], ['farm', '莊園／處理廠'],
      ['process', '處理法', 'enum', { values: ['水洗', '日曬', '蜜處理', '厭氧', '其他'] }], ['variety', '品種'], ['altitude', '海拔'], ['crop_year', '產季'],
      ['cupping_score', '杯測分數', 'number'], ['default_supplier_id', '常用供應商', 'fk', { resource: 'suppliers', idKey: 'supplier_id' }],
      ['safety_stock_kg', '安全庫存量（kg）', 'number'], ['note', '備註', 'textarea', { full: true }],
    ],
  },
  'packaging-items': {
    title: '包材', pk: 'packaging_id',
    cols: [['name', '名稱'], ['unit', '單位'], ['unit_cost', '參考單價', 'num2'], ['supplier_name', '供應商'], ['safety_stock', '安全庫存', 'num']],
    fields: [
      ['name', '名稱', 'text', { required: true, full: true }], ['unit', '單位'], ['unit_cost', '參考單價', 'number'],
      ['supplier_id', '供應商', 'fk', { resource: 'suppliers', idKey: 'supplier_id' }], ['safety_stock', '安全庫存', 'number'],
      ['note', '備註', 'textarea', { full: true }],
    ],
  },
  products: {
    title: '產品', pk: 'product_id',
    cols: [['sku', '料號'], ['name', '產品名稱'], ['category', '類別'], ['roasted_bean_name', '使用熟豆'], ['net_weight_g', '淨重 g', 'num'], ['retail_price', '零售價', 'num'], ['wholesale_price', '批發價', 'num']],
    fields: [
      ['sku', '料號／條碼'], ['name', '產品名稱', 'text', { required: true }],
      ['category', '類別', 'enum', { values: ['單品豆', '綜合豆', '濾掛', '禮盒', '器具', '其他'], noBlank: true }],
      ['roasted_bean_id', '使用熟豆品項（銷貨時扣此熟豆庫存）', 'fk', { resource: 'roasted-beans', idKey: 'roasted_bean_id', blank: '不扣熟豆（器具、禮盒等）' }],
      ['net_weight_g', '每包淨重（g）', 'number'], ['roast_level', '烘焙度', 'enum', { values: ROAST }],
      ['retail_price', '零售價', 'number'], ['wholesale_price', '批發價', 'number'], ['shelf_life_days', '賞味期（天，烘焙日起算）', 'number'],
      ['note', '備註', 'textarea', { full: true }],
    ],
    hint: '同一鍋熟豆可以包成不同規格：例如「招牌綜合 250g」與「招牌綜合 1kg」都選同一個熟豆品項，銷貨時依「數量 × 每包淨重」扣熟豆庫存。',
  },
  'roasted-beans': {
    title: '熟豆品項', pk: 'roasted_bean_id',
    cols: [['name', '名稱'], ['roast_level', '烘焙度'], ['shelf_life_days', '賞味期（天）', 'num'], ['safety_stock_kg', '安全庫存 kg', 'num']],
    fields: [
      ['name', '名稱', 'text', { required: true, full: true }], ['roast_level', '烘焙度', 'enum', { values: ROAST }],
      ['shelf_life_days', '賞味期（天，烘焙日起算）', 'number'], ['safety_stock_kg', '安全庫存量（kg）', 'number'],
      ['note', '備註', 'textarea', { full: true }],
    ],
    hint: '熟豆品項 = 烘焙批次的產出（例：招牌綜合 中深焙）。建立後到「產品」主檔指定每個產品使用哪個熟豆品項。',
  },
  'bank-accounts': {
    title: '銀行帳戶', pk: 'account_id',
    cols: [['account_name', '帳戶名稱'], ['account_type', '類型'], ['bank_code', '銀行', (r) => esc(bankLabel(r))], ['account_no_masked', '帳號', (r) => esc(maskNo(r.account_no || r.account_no_masked))], ['opening_balance', '期初餘額', 'num'], ['opening_date', '期初日期']],
    fields: [
      ['account_type', '類型', 'enum', { values: ['銀行', '現金', 'LINE Pay', '信用卡收單', '電商平台'], noBlank: true }],
      ['bank_code', '銀行代號', 'bankcode'],
      ['branch_name', '分行名稱'], ['branch_code', '分行代號（4 碼，選填）'],
      ['account_no', '帳號（完整）', 'accountno'], ['account_holder', '戶名'],
      ['account_name', '帳戶名稱（顯示用）', 'text', { required: true, placeholder: '例：玉山 1234；選銀行、填帳號後自動帶入' }],
      ['bank_name', '銀行名稱', 'text', { hidden: true }],
      ['opening_balance', '期初餘額', 'number'], ['opening_date', '期初日期', 'date'],
      ['note', '備註', 'textarea', { full: true }],
    ],
    hint: '銀行帳戶依台灣慣例填「銀行代號＋帳號」，清單只顯示末四碼，打開才看得到完整帳號。現金、LINE Pay、刷卡收單也各建一個帳戶（不用填銀行代號），收款時選對帳戶，餘額才會對得上。期初日期建議填開帳日的前一天，交易日期不可早於期初日期。找不到銀行請到「主檔 → 銀行代碼」新增。',
  },
  'expense-categories': {
    title: '費用類別', pk: 'category_id',
    cols: [['name', '名稱'], ['allocate_to_roast', '預設攤入烘焙', 'yn']],
    fields: [
      ['name', '名稱', 'text', { required: true }],
      ['allocate_to_roast', '新增費用時預設「攤入烘焙成本」', 'bool'],
      ['note', '備註', 'textarea', { full: true }],
    ],
  },
};

// ---------------------------------------------------------------- 銀行代號／帳號共用
const maskNo = (no) => (no ? (String(no).length > 4 ? '＊＊＊＊' + String(no).slice(-4) : String(no)) : '');
const bankLabel = (r) => (r.bank_code ? `(${r.bank_code}) ${r.bank_name || ''}`.trim() : r.bank_name || '');
const fmtAcctNo = (no) => String(no || '').replace(/(\d{4})(?=\d)/g, '$1-'); // 每 4 碼一段，好讀
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('已複製：' + t); } catch { prompt('請手動複製', t); }
}
const bankCodeOpts = (codes, sel) => `<option value="">（請選擇）</option>` + ['本國銀行', '郵局', '外商銀行', '信用合作社', '農漁會', '其他'].map((cat) => {
  const rows = codes.filter((c) => c.category === cat && (c.is_active || c.code === sel));
  return rows.length ? `<optgroup label="${cat}">${rows.map((c) => `<option value="${c.code}" data-name="${esc(c.name)}" ${c.code === sel ? 'selected' : ''}>${c.code} ${esc(c.name)}</option>`).join('')}</optgroup>` : '';
}).join('');

// ---------------------------------------------------------------- 主檔頁
async function pageMaster(key) {
  const m = MASTERS[key];
  $('#main').innerHTML = `
    <h2>${m.title}</h2>
    <div class="toolbar">
      <label>搜尋<input id="q" placeholder="關鍵字"></label>
      <label>狀態<select id="active"><option value="1">啟用中</option><option value="">全部</option><option value="0">已停用</option></select></label>
      <button id="search">查詢</button><span class="spacer"></span>
      <button id="add" class="primary">＋ 新增${m.title}</button>
    </div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;

  const load = async () => {
    try {
      const { data } = await api(`/${key}${qs({ q: $('#q').value.trim(), active: $('#active').value })}`);
      $('#list').innerHTML = data.length ? `<table><thead><tr>${m.cols.map(([, l, t]) => `<th class="${t && typeof t !== 'function' ? 'num' : ''}">${l}</th>`).join('')}<th>狀態</th></tr></thead><tbody>
        ${data.map((r) => `<tr class="clickable ${r.is_active ? '' : 'inactive'}" data-id="${r[m.pk]}">
          ${m.cols.map(([c, , t]) => (typeof t === 'function' ? `<td>${t(r)}</td>` : `<td class="${t && t !== 'yn' ? 'num' : ''}">${t === 'yn' ? (r[c] ? '是' : '') : t === 'num2' ? esc(fmt(r[c], 2)) : t ? esc(fmt(r[c])) : esc(r[c])}</td>`)).join('')}
          <td>${r.is_active ? '<span class="tag">啟用</span>' : '<span class="tag warn">停用</span>'}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">沒有資料</div>';
      $$('#list tr.clickable').forEach((tr) => tr.onclick = () => masterForm(key, Number(tr.dataset.id), load));
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  $('#q').onkeydown = (e) => e.key === 'Enter' && load();
  $('#active').onchange = load;
  $('#add').onclick = () => masterForm(key, null, load);
  load();
}

function prefRow(p = {}) {
  const sel = (name, values) => `<select data-k="${name}"><option value=""></option>${values.map((v) => `<option ${p[name] === v ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
  const inp = (name) => `<input data-k="${name}" value="${esc(p[name])}">`;
  return `<tr>${[sel('roast_level', ROAST), inp('flavor_notes'), sel('grind_size', GRIND), inp('brew_method'), inp('favorite_products'), inp('dislikes'), inp('note')].map((h) => `<td>${h}</td>`).join('')}
    <td><button type="button" class="link" data-del>刪除</button></td></tr>`;
}

function sbaRow(codes, a = {}) {
  return `<tr data-sba="${a.sba_id || ''}">
    <td><select data-k="bank_code" style="min-width:150px">${bankCodeOpts(codes, a.bank_code)}</select></td>
    <td><input data-k="branch_name" value="${esc(a.branch_name)}" placeholder="例：中山分行" style="width:110px"></td>
    <td><span class="inline"><input data-k="account_no" inputmode="numeric" value="${esc(a.account_no)}" placeholder="只填數字" style="width:150px"><button type="button" class="link" data-copyno>複製</button></span></td>
    <td><input data-k="account_holder" value="${esc(a.account_holder)}" placeholder="戶名" style="width:120px"></td>
    <td><input type="checkbox" data-k="is_default" ${a.is_default ? 'checked' : ''}></td>
    <td><input type="checkbox" data-k="is_active" ${a.is_active ? 'checked' : ''}></td>
    <td><input data-k="note" value="${esc(a.note)}" style="width:100px"></td>
    <td>${a.used ? `<span class="hint">已付款 ${a.used} 筆</span>` : '<button type="button" class="link" data-del>刪除</button>'}</td></tr>`;
}
/** 供應商存檔後，同步匯款帳戶（新增／修改／刪除）；錯誤時告知是哪一列 */
async function saveSbas(box, supplierId, original) {
  const rows = $$('#sbas tr', box);
  const keep = new Set();
  for (const [i, tr] of rows.entries()) {
    const v = (k) => { const el = $(`[data-k=${k}]`, tr); return el.type === 'checkbox' ? (el.checked ? 1 : 0) : el.value; };
    const body = { supplier_id: supplierId, bank_code: v('bank_code'), branch_name: v('branch_name'), account_no: v('account_no'), account_holder: v('account_holder'), is_default: v('is_default'), is_active: v('is_active'), note: v('note') };
    if (!body.bank_code && !body.account_no) continue; // 空白列略過
    const sid = tr.dataset.sba;
    try {
      if (sid) { keep.add(Number(sid)); await api(`/supplier-accounts/${sid}`, { method: 'PUT', body }); }
      else await api('/supplier-accounts', { method: 'POST', body });
    } catch (e) { e.message = `匯款帳戶第 ${i + 1} 列：${e.message}`; throw e; }
  }
  for (const a of original) if (!keep.has(a.sba_id)) await api(`/supplier-accounts/${a.sba_id}`, { method: 'DELETE' });
}

async function masterForm(key, id, reload) {
  const m = MASTERS[key];
  try {
    const row = id ? (await api(`/${key}/${id}`)).data : { is_active: 1 };
    const fkData = {};
    for (const [, , type, o] of m.fields) if (type === 'fk') fkData[o.resource] = await lookup(o.resource, true);
    const needCodes = m.fields.some(([, , type]) => type === 'bankcode') || key === 'suppliers';
    const codes = needCodes ? await lookup('bank-codes', true) : [];
    const sbas = key === 'suppliers' && id ? (await api('/supplier-accounts' + qs({ supplier_id: id }))).data : [];

    const input = ([name, label, type = 'text', o = {}]) => {
      const v = row[name];
      let ctl;
      if (type === 'bool') ctl = `<select name="${name}"><option value="0" ${v ? '' : 'selected'}>否</option><option value="1" ${v ? 'selected' : ''}>是</option></select>`;
      else if (type === 'enum') ctl = `<select name="${name}">${o.noBlank ? '' : '<option value=""></option>'}${o.values.map((x) => `<option ${v === x ? 'selected' : ''}>${x}</option>`).join('')}</select>`;
      else if (type === 'fk') ctl = `<select name="${name}">${options(fkData[o.resource], o.idKey, v, o.blank ? { blank: o.blank } : {})}</select>`;
      else if (type === 'textarea') ctl = `<textarea name="${name}" rows="2">${esc(v)}</textarea>`;
      else if (type === 'bankcode') ctl = `<select name="${name}">${bankCodeOpts(codes, v)}</select>`;
      else if (type === 'accountno') ctl = `<span class="inline"><input name="${name}" inputmode="numeric" value="${esc(v)}" placeholder="只填數字"><button type="button" class="link" data-copy="${name}">複製</button></span>`;
      else if (o.hidden) return `<input type="hidden" name="${name}" value="${esc(v)}">`;
      else ctl = `<input name="${name}" type="${type === 'number' ? 'number' : type}" ${type === 'number' ? 'step="any" min="0"' : ''} value="${esc(v)}" ${o.required ? 'required' : ''} ${o.placeholder ? `placeholder="${esc(o.placeholder)}"` : ''}>`;
      return `<label class="${o.full ? 'full' : ''}">${label}${o.required ? ' *' : ''}${ctl}</label>`;
    };

    const prefs = key === 'customers' ? `
      <div class="section-title">喜好 <button type="button" id="addPref">＋ 新增一筆</button></div>
      <div class="table-wrap"><table class="items"><thead><tr><th>烘焙度</th><th>偏好風味</th><th>研磨度</th><th>沖煮器具</th><th>常買品項</th><th>不喜歡</th><th>備註</th><th></th></tr></thead>
      <tbody id="prefs">${(row.preferences || []).map(prefRow).join('')}</tbody></table></div>` : '';

    const sbaSection = key === 'suppliers' ? `
      <div class="section-title">匯款帳戶 <button type="button" id="addSba">＋ 新增帳戶</button></div>
      <div class="table-wrap"><table class="items"><thead><tr><th>銀行代號</th><th>分行</th><th>帳號</th><th>戶名</th><th>預設</th><th>啟用</th><th>備註</th><th></th></tr></thead>
      <tbody id="sbas">${sbas.map((a) => sbaRow(codes, a)).join('')}</tbody></table></div>
      <p class="hint">一家供應商可有多個帳戶；付款時會先帶出「預設」帳戶。已用於付款的帳戶不能刪除，請取消「啟用」。</p>` : '';

    const box = openModal(`
      <h2>${id ? '編輯' : '新增'}${m.title}</h2>
      <form id="f">
        <div class="form-grid">${m.fields.map(input).join('')}
          <label>狀態<select name="is_active"><option value="1" ${row.is_active ? 'selected' : ''}>啟用</option><option value="0" ${row.is_active ? '' : 'selected'}>停用</option></select></label>
        </div>${m.hint ? `<p class="hint">${m.hint}</p>` : ''}${prefs}${sbaSection}
        <div class="form-actions">
          ${id ? '<button type="button" class="danger" id="del">刪除</button>' : ''}<span class="spacer"></span>
          <button type="button" id="cancel">取消</button><button class="primary">存檔</button>
        </div>
      </form>`, key === 'customers' || key === 'suppliers');

    $('#cancel', box).onclick = closeModal;
    const f0 = $('#f', box);
    $$('[data-copy]', box).forEach((b) => b.onclick = () => { const v = f0[b.dataset.copy].value.replace(/\D/g, ''); if (v) copyText(v); });
    if (key === 'bank-accounts') {
      // 選銀行、填帳號後自動帶出銀行名稱與顯示名稱
      const autoName = () => {
        const opt = f0.bank_code.selectedOptions[0];
        f0.bank_name.value = opt?.dataset.name || f0.bank_name.value;
        const no = f0.account_no.value.replace(/\D/g, '');
        const short = (opt?.dataset.name || '').replace(/(商業|國際|儲蓄|股份有限公司|（.*?）|\(.*?\))/g, '').replace(/銀行$/, '');
        if (opt?.value && (!f0.account_name.value || f0.account_name.dataset.auto === '1')) {
          f0.account_name.value = `${short}${no ? ' ' + no.slice(-4) : ''}`;
          f0.account_name.dataset.auto = '1';
        }
      };
      f0.bank_code.onchange = autoName;
      f0.account_no.addEventListener('input', autoName);
      f0.account_name.addEventListener('input', () => { f0.account_name.dataset.auto = '0'; });
    }
    if (key === 'suppliers') {
      $('#addSba', box).onclick = () => $('#sbas', box).insertAdjacentHTML('beforeend', sbaRow(codes, { is_active: 1, is_default: $$('#sbas tr', box).length ? 0 : 1 }));
      $('#sbas', box).addEventListener('click', (e) => {
        if (e.target.matches('[data-del]')) e.target.closest('tr').remove();
        if (e.target.matches('[data-copyno]')) { const v = $('[data-k=account_no]', e.target.closest('tr')).value.replace(/\D/g, ''); if (v) copyText(v); }
        if (e.target.matches('[data-k=is_default]')) $$('#sbas [data-k=is_default]', box).forEach((x) => { if (x !== e.target) x.checked = false; });
      });
    }
    if (key === 'customers') {
      $('#addPref', box).onclick = () => $('#prefs', box).insertAdjacentHTML('beforeend', prefRow());
      $('#prefs', box).onclick = (e) => e.target.matches('[data-del]') && e.target.closest('tr').remove();
    }
    $('#f', box).onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      if (key === 'customers') {
        body.preferences = $$('#prefs tr', box).map((tr) => Object.fromEntries($$('[data-k]', tr).map((el) => [el.dataset.k, el.value])));
      }
      try {
        const res = await api(id ? `/${key}/${id}` : `/${key}`, { method: id ? 'PUT' : 'POST', body });
        if (key === 'suppliers') await saveSbas(box, res.data.supplier_id, sbas);
        delete cache[key];
        closeModal(); toast('已存檔'); reload();
      } catch (err) { fail(err); }
    };
    if (id) $('#del', box).onclick = async () => {
      if (!confirm(`確定刪除這筆${m.title}？此動作無法復原。`)) return;
      try { await api(`/${key}/${id}`, { method: 'DELETE' }); delete cache[key]; closeModal(); toast('已刪除'); reload(); } catch (err) { fail(err); }
    };
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- 進貨單
async function pagePurchases() {
  const suppliers = await lookup('suppliers', true);
  const beans = await lookup('green-beans', true);
  $('#main').innerHTML = `
    <h2>進貨單</h2>
    <div class="toolbar">
      <label>起日<input type="date" id="from" value="${monthStart()}"></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <label>供應商<select id="sup">${options(suppliers, 'supplier_id', null, { blank: '全部' })}</select></label>
      <label>生豆品項<select id="bean">${options(beans, 'bean_id', null, { blank: '全部' })}</select></label>
      <button id="search">查詢</button><span class="spacer"></span>
      <button id="add" class="primary">＋ 新增進貨單</button>
    </div>
    <div class="stats" id="stats"></div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;

  const load = async () => {
    try {
      const { data, summary } = await api('/purchases' + qs({ from: $('#from').value, to: $('#to').value, supplier_id: $('#sup').value, bean_id: $('#bean').value }));
      $('#stats').innerHTML = [['進貨單數', fmt(summary.count)], ['生豆進貨 kg', kg(summary.bean_kg)], ['金額合計', money(summary.total_amount)], ['未付款', money(summary.unpaid_amount)]]
        .map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
      $('#list').innerHTML = data.length ? `<table><thead><tr><th>進貨日期</th><th>單號</th><th>供應商</th><th class="num">明細數</th><th class="num">生豆 kg</th><th class="num">運費</th><th class="num">稅額</th><th class="num">合計</th><th class="num">未付</th><th>付款</th><th>發票</th></tr></thead><tbody>
        ${data.map((r) => `<tr class="clickable" data-id="${r.purchase_id}"><td>${esc(r.purchase_date)}</td><td>${esc(r.purchase_no)}</td><td>${esc(r.supplier_name)}</td>
          <td class="num">${r.item_count}</td><td class="num up">${r.bean_kg ? '+' + kg(r.bean_kg) : ''}</td><td class="num">${money(r.shipping_fee)}</td><td class="num">${money(r.tax_amount)}</td>
          <td class="num">${money(r.total_amount)}</td><td class="num">${r.unpaid_amount ? money(r.unpaid_amount) : ''}</td><td>${statusTag(r.payment_status)}</td><td>${esc(r.invoice_no)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">此區間沒有進貨單</div>';
      $$('#list tr.clickable').forEach((tr) => tr.onclick = () => purchaseForm(Number(tr.dataset.id), load));
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  $('#add').onclick = () => purchaseForm(null, load);
  load();
}

async function purchaseForm(id, reload) {
  try {
    const [suppliers, beans, packs] = await Promise.all([lookup('suppliers', true), lookup('green-beans', true), lookup('packaging-items', true)]);
    const p = id ? (await api(`/purchases/${id}`)).data : { purchase_date: today(), items: [{ item_type: '生豆' }], shipping_fee: 0, tax_amount: 0 };
    const locked = !!p.locked || (id && p.payment_status !== '未付');
    const dis = locked ? 'disabled' : '';

    const itemRow = (it = { item_type: '生豆' }) => `<tr>
      <td><select data-k="item_type" ${dis}><option ${it.item_type === '生豆' ? 'selected' : ''}>生豆</option><option ${it.item_type === '包材' ? 'selected' : ''}>包材</option></select></td>
      <td>
        <select data-k="bean_id" ${dis} ${it.item_type === '包材' ? 'hidden' : ''}>${options(beans, 'bean_id', it.bean_id, { blank: '選擇生豆' })}</select>
        <select data-k="packaging_id" ${dis} ${it.item_type === '包材' ? '' : 'hidden'}>${options(packs, 'packaging_id', it.packaging_id, { blank: '選擇包材', label: (r) => `${r.name}（${r.unit}）` })}</select>
      </td>
      <td><input data-k="lot_no" ${dis} value="${esc(it.lot_no)}" placeholder="自動產生" ${it.item_type === '包材' ? 'hidden' : ''}></td>
      <td><input data-k="qty" ${dis} type="number" step="any" min="0" value="${esc(it.qty)}" class="num"></td>
      <td><input data-k="unit_price" ${dis} type="number" step="any" min="0" value="${esc(it.unit_price)}" class="num"></td>
      <td class="num" data-amount></td><td class="num" data-alloc></td><td class="num" data-landed></td>
      <td><input data-k="storage_location" ${dis} value="${esc(it.storage_location)}" ${it.item_type === '包材' ? 'hidden' : ''}></td>
      <td>${locked ? '' : '<button type="button" class="link" data-del>刪除</button>'}</td></tr>`;

    const box = openModal(`
      <h2>${id ? '進貨單 ' + esc(p.purchase_no) : '新增進貨單'}</h2>
      ${locked ? `<div class="notice">此進貨單已鎖定（${p.locked ? '生豆批號已被使用（烘焙、盤點、退出…）' : '已有付款紀錄，要修改請先到銀行收支刪除付款沖帳'}），只能檢視，無法修改或刪除；退貨請按「進貨退出」。</div>` : ''}
      <form id="f">
        <div class="form-grid">
          <label>進貨日期 *<input name="purchase_date" type="date" required value="${esc(p.purchase_date)}" ${dis}></label>
          <label>進貨單號<input name="purchase_no" value="${esc(p.purchase_no)}" placeholder="自動產生" ${dis}></label>
          <label>供應商 *<select name="supplier_id" required ${dis}>${options(suppliers, 'supplier_id', p.supplier_id, { blank: '請選擇' })}</select></label>
          <label>供應商發票號碼<input name="invoice_no" value="${esc(p.invoice_no)}" ${dis}></label>
          <label>應付日期<input name="due_date" type="date" value="${esc(p.due_date)}" ${dis}></label>
          <label>付款狀態<input value="${esc(p.payment_status || '未付')}" disabled></label>
          <label class="full">備註<input name="note" value="${esc(p.note)}" ${dis}></label>
        </div>
        <div class="section-title">明細 ${locked ? '' : '<button type="button" id="addItem">＋ 新增一筆</button>'}</div>
        <div class="table-wrap"><table class="items"><thead><tr><th style="width:80px">類型</th><th style="min-width:200px">品項</th><th style="width:140px">生豆批號</th>
          <th style="width:90px">數量</th><th style="width:90px">單價</th><th class="num">小計</th><th class="num">攤提</th><th class="num">入庫成本/單位</th><th style="width:90px">存放位置</th><th></th></tr></thead>
          <tbody id="items">${p.items.map(itemRow).join('')}</tbody></table></div>
        <p class="hint">生豆數量單位為 kg。運費＋稅額只攤給生豆（依 kg 比例），包材維持原單價。批號留空會自動產生。</p>
        <div class="totals">
          <div><span>明細小計</span><span id="tItems"></span></div>
          <div><span>運費／報關費</span><input name="shipping_fee" type="number" step="any" min="0" value="${esc(p.shipping_fee)}" style="width:110px;text-align:right" ${dis}></div>
          <div><span>稅額</span><input name="tax_amount" type="number" step="any" min="0" value="${esc(p.tax_amount)}" style="width:110px;text-align:right" ${dis}></div>
          <div class="grand"><span>合計</span><span id="tTotal"></span></div>
        </div>
        ${id && p.returned_amount ? `<div class="totals"><div><span>進貨退出</span><span class="down">−${money(p.returned_amount)}</span></div><div><span>應付淨額</span><span>${money(p.net_amount)}</span></div></div>` : ''}
        ${id ? returnsBlock(p) : ''}
        ${id ? paymentsBlock(p, '付款') : ''}
        <div class="form-actions">
          ${id && !locked ? '<button type="button" class="danger" id="del">刪除</button>' : ''}<span class="spacer"></span>
          ${id ? '<button type="button" id="docReturn">進貨退出</button>' : ''}
          ${id && p.refundable > 0 ? '<button type="button" id="docRefund">登錄供應商退款</button>' : ''}
          ${id && p.unpaid_amount > 0 ? '<button type="button" id="docPay">登錄付款</button>' : ''}
          <button type="button" id="cancel">${locked ? '關閉' : '取消'}</button>${locked ? '' : '<button class="primary">存檔</button>'}
        </div>
      </form>`, true);

    const f = $('#f', box);
    if ($('#docReturn', box)) $('#docReturn', box).onclick = () => returnForm('進貨退出', { purchase_id: id }, null, reload);
    if ($('#docRefund', box)) $('#docRefund', box).onclick = () => txnForm(DIR_IN, null, reload, { category: '其他', counterparty: p.supplier_name, amount: p.refundable, description: `${p.purchase_no} 供應商退款`, allocations: [{ doc_type: 'purchases', doc_id: id, amount: p.refundable }] });
    bindReturnRows(box, reload);
    if ($('#docPay', box)) $('#docPay', box).onclick = () => txnForm(DIR_OUT, null, reload, { category: '進貨付款', supplier_id: p.supplier_id, amount: p.unpaid_amount, description: p.purchase_no, allocations: [{ doc_type: 'purchases', doc_id: id, amount: p.unpaid_amount }] });
    const readItems = () => $$('#items tr', box).map((tr) => Object.fromEntries($$('[data-k]', tr).map((el) => [el.dataset.k, el.value])));

    // 即時試算（與後端規則相同：運費＋稅只攤生豆、依 kg、尾差給最後一筆）
    const recalc = () => {
      const rows = $$('#items tr', box);
      const items = readItems().map((it) => ({ ...it, qty: Number(it.qty) || 0, unit_price: Number(it.unit_price) || 0 }));
      items.forEach((it) => { it.amount = r2(it.qty * it.unit_price); it.alloc = 0; });
      const pool = r2((Number(f.shipping_fee.value) || 0) + (Number(f.tax_amount.value) || 0));
      const beanIdx = items.map((it, i) => (it.item_type === '生豆' && it.qty > 0 ? i : -1)).filter((i) => i >= 0);
      const totalKg = beanIdx.reduce((s, i) => s + items[i].qty, 0);
      let used = 0;
      beanIdx.forEach((i, n) => {
        items[i].alloc = n === beanIdx.length - 1 ? r2(pool - used) : r2(pool * items[i].qty / totalKg);
        used = r2(used + items[i].alloc);
      });
      let sum = 0;
      items.forEach((it, i) => {
        sum += it.amount;
        $('[data-amount]', rows[i]).textContent = money(it.amount);
        $('[data-alloc]', rows[i]).textContent = it.alloc ? money(it.alloc) : '';
        $('[data-landed]', rows[i]).textContent = it.qty > 0 ? fmt((it.amount + it.alloc) / it.qty, 2) : '';
      });
      $('#tItems', box).textContent = money(sum);
      $('#tTotal', box).textContent = money(r2(sum) + pool);
    };

    $('#items', box).addEventListener('input', recalc);
    $('#items', box).addEventListener('change', (e) => {
      if (e.target.dataset.k === 'item_type') {
        const tr = e.target.closest('tr');
        const isPack = e.target.value === '包材';
        $('[data-k=bean_id]', tr).hidden = isPack;
        $('[data-k=packaging_id]', tr).hidden = !isPack;
        $('[data-k=lot_no]', tr).hidden = isPack;
        $('[data-k=storage_location]', tr).hidden = isPack;
      }
      if (e.target.dataset.k === 'packaging_id') { // 帶入包材參考單價
        const pk = packs.find((x) => x.packaging_id === Number(e.target.value));
        const price = $('[data-k=unit_price]', e.target.closest('tr'));
        if (pk?.unit_cost != null && !price.value) price.value = pk.unit_cost;
      }
      recalc();
    });
    $('#items', box).addEventListener('click', (e) => {
      if (e.target.matches('[data-del]')) { e.target.closest('tr').remove(); recalc(); }
    });
    f.shipping_fee.oninput = f.tax_amount.oninput = recalc;
    if (!locked) $('#addItem', box).onclick = () => { $('#items', box).insertAdjacentHTML('beforeend', itemRow()); recalc(); };
    $('#cancel', box).onclick = closeModal;
    recalc();

    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f));
      body.items = readItems().map((it) => it.item_type === '生豆'
        ? { item_type: '生豆', bean_id: it.bean_id, lot_no: it.lot_no, qty: it.qty, unit_price: it.unit_price, storage_location: it.storage_location }
        : { item_type: '包材', packaging_id: it.packaging_id, qty: it.qty, unit_price: it.unit_price });
      try {
        const res = await api(id ? `/purchases/${id}` : '/purchases', { method: id ? 'PUT' : 'POST', body });
        closeModal();
        toast(`已存檔 ${res.data.purchase_no}` + (res.unallocated ? `（本單沒有生豆，運費＋稅 ${money(res.unallocated)} 未攤入成本）` : ''));
        reload();
      } catch (err) { fail(err); }
    };
    if (id && !locked) $('#del', box).onclick = async () => {
      if (!confirm(`確定刪除進貨單 ${p.purchase_no}？\n會一併刪除它建立的生豆批號與庫存異動，無法復原。`)) return;
      try { await api(`/purchases/${id}`, { method: 'DELETE' }); closeModal(); toast('已刪除'); reload(); } catch (err) { fail(err); }
    };
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- 庫存查詢
const inCell = (n, f = kg) => `<td class="num up">${n ? '+' + f(n) : ''}</td>`;
const outCell = (n, f = kg) => `<td class="num down">${n ? '−' + f(n) : ''}</td>`;

async function pageStockBeans() {
  const beans = await lookup('green-beans', true);
  $('#main').innerHTML = `
    <h2>生豆庫存查詢</h2>
    <div class="toolbar">
      <label>起日<input type="date" id="from" value="${monthStart()}"></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <label>生豆品項<select id="bean">${options(beans, 'bean_id', null, { blank: '全部' })}</select></label>
      <label>顯示<select id="empty"><option value="">有庫存或異動的品項</option><option value="1">全部品項</option></select></label>
      <button id="search">查詢</button>
    </div>
    <p class="hint">庫存由庫存異動加總計算。期初 = 起日前一天的庫存；期末 = 迄日當天結束的庫存。點品項可展開批號，點批號可看異動明細。<span class="up">紅色 = 入庫</span>、<span class="down">綠色 = 出庫</span>。
      「期初」是算出來的、不能直接改；開帳時手上已有的生豆請到 <a href="#opening-stock">期初庫存</a> 登錄。</p>
    <div class="stats" id="stats"></div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;

  const load = async () => {
    try {
      const range = { from: $('#from').value, to: $('#to').value };
      const { data, total } = await api('/inventory/green-beans' + qs({ ...range, bean_id: $('#bean').value, show_empty: $('#empty').value }));
      $('#stats').innerHTML = [['期初 kg', kg(total.opening_qty), ''], ['本期入庫 kg', '+' + kg(total.in_qty), 'up'], ['本期出庫 kg', '−' + kg(total.out_qty), 'down'], ['期末 kg', kg(total.closing_qty), ''], ['期末庫存金額', money(total.closing_amount), '']]
        .map(([k, v, c]) => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`).join('');
      if (!data.length) { $('#list').innerHTML = '<div class="empty">沒有資料</div>'; return; }
      $('#list').innerHTML = `<table><thead><tr><th>品項／批號</th><th>入庫日</th><th>進貨單</th><th>位置</th><th class="num">成本/kg</th>
        <th class="num">期初 kg</th><th class="num">入庫 kg</th><th class="num">出庫 kg</th><th class="num">期末 kg</th><th class="num">期末金額</th><th>狀態</th></tr></thead><tbody>
        ${data.map((b) => `
          <tr class="clickable bean" data-bean="${b.bean_id}"><td>▸ <b>${esc(b.name)}</b>（${b.lots.length} 批）</td><td></td><td></td><td></td>
            <td class="num">${b.avg_cost == null ? '' : fmt(b.avg_cost, 2)}</td><td class="num">${kg(b.opening_qty)}</td>${inCell(b.in_qty)}${outCell(b.out_qty)}
            <td class="num"><b>${kg(b.closing_qty)}</b></td><td class="num">${money(b.closing_amount)}</td>
            <td>${b.low_stock ? `<span class="tag warn">低於安全庫存 ${fmt(b.safety_stock_kg)}kg</span>` : ''}</td></tr>
          ${b.lots.map((l) => `<tr class="sub clickable" data-parent="${b.bean_id}" data-lot="${l.lot_id}" data-lotno="${esc(l.lot_no)}" hidden>
            <td>${esc(l.lot_no)}</td><td>${esc(l.received_date)}</td><td>${l.purchase_no ? esc(l.purchase_no) : '<span class="tag">期初庫存</span>'}</td><td>${esc(l.storage_location)}</td>
            <td class="num">${fmt(l.unit_cost, 2)}</td><td class="num">${kg(l.opening_qty)}</td>${inCell(l.in_qty)}${outCell(l.out_qty)}
            <td class="num">${kg(l.closing_qty)}</td><td class="num">${money(l.closing_amount)}</td><td><span class="tag">${l.status}</span></td></tr>`).join('')}`).join('')}
        <tr class="total"><td>合計</td><td></td><td></td><td></td><td></td><td class="num">${kg(total.opening_qty)}</td>${inCell(total.in_qty)}${outCell(total.out_qty)}
          <td class="num">${kg(total.closing_qty)}</td><td class="num">${money(total.closing_amount)}</td><td></td></tr>
        </tbody></table>`;
      $$('#list tr.bean').forEach((tr) => tr.onclick = () => {
        const subs = $$(`#list tr[data-parent="${tr.dataset.bean}"]`);
        const open = subs[0]?.hidden;
        subs.forEach((s) => (s.hidden = !open));
        tr.cells[0].firstChild.textContent = open ? '▾ ' : '▸ ';
      });
      $$('#list tr.sub').forEach((tr) => tr.onclick = () => movementModal(`批號 ${tr.dataset.lotno} 異動明細`, { item_type: '生豆', lot_id: tr.dataset.lot, ...range }, 'kg'));
      if (data.length === 1) $('#list tr.bean').click();
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  load();
}

async function movementModal(title, params, unit) {
  try {
    const { data } = await api('/inventory/movements' + qs(params));
    let bal = null;
    openModal(`<h2>${esc(title)}</h2>
      <p class="hint">${esc(params.from || '最早')} ～ ${esc(params.to || '目前')}</p>
      <div class="table-wrap">${data.length ? `<table><thead><tr><th>日期</th><th>異動類型</th><th class="num">數量（${unit}）</th><th class="num">單位成本</th><th class="num">金額</th><th>來源單據</th><th>備註</th><th>操作者</th></tr></thead><tbody>
        ${data.map((m) => `<tr><td>${esc(m.movement_date.slice(0, 16))}</td><td><span class="tag ${m.qty > 0 ? 'up' : 'down'}">${esc(m.movement_type)}</span></td>
          <td class="num ${m.qty > 0 ? 'up' : 'down'}">${m.qty > 0 ? '+' : '−'}${kg(Math.abs(m.qty))}</td><td class="num">${fmt(m.unit_cost, 2)}</td>
          <td class="num ${m.qty > 0 ? 'up' : 'down'}">${m.qty > 0 ? '+' : '−'}${money(Math.abs(m.amount))}</td><td>${esc(m.doc_no)}${m.customer_name ? '（' + esc(m.customer_name) + '）' : ''}</td><td>${m.note === m.doc_no ? '' : esc(m.note)}</td><td>${esc(m.created_by)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">此區間沒有異動</div>'}</div>
      <div class="form-actions"><button id="cancel">關閉</button></div>`, true);
    $('#cancel').onclick = closeModal;
  } catch (e) { fail(e); }
}

async function pageStockPackaging() {
  $('#main').innerHTML = `
    <h2>包材庫存查詢</h2>
    <div class="toolbar">
      <label>起日<input type="date" id="from" value="${monthStart()}"></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <button id="search">查詢</button>
    </div>
    <p class="hint">點任一列可看異動明細。目前只有進貨入庫與期初；包裝耗用於 Phase 4（配方）加入。開帳時手上已有的包材請到 <a href="#opening-stock">期初庫存</a> 登錄。</p>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;
  const load = async () => {
    try {
      const range = { from: $('#from').value, to: $('#to').value };
      const { data } = await api('/inventory/packaging' + qs(range));
      $('#list').innerHTML = data.length ? `<table><thead><tr><th>包材</th><th>單位</th><th class="num">期初</th><th class="num">入庫</th><th class="num">出庫</th><th class="num">期末</th><th class="num">期末金額</th><th>狀態</th></tr></thead><tbody>
        ${data.map((r) => `<tr class="clickable ${r.is_active ? '' : 'inactive'}" data-id="${r.packaging_id}" data-name="${esc(r.name)}" data-unit="${esc(r.unit)}"><td>${esc(r.name)}</td><td>${esc(r.unit)}</td>
          <td class="num">${fmt(r.opening_qty)}</td>${inCell(r.in_qty, fmt)}${outCell(r.out_qty, fmt)}<td class="num"><b>${fmt(r.closing_qty)}</b></td><td class="num">${money(r.closing_amount)}</td>
          <td>${r.low_stock ? `<span class="tag warn">低於安全庫存 ${fmt(r.safety_stock)}</span>` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">沒有資料</div>';
      $$('#list tr.clickable').forEach((tr) => tr.onclick = () => movementModal(`${tr.dataset.name} 異動明細`, { item_type: '包材', packaging_id: tr.dataset.id, ...range }, tr.dataset.unit));
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  load();
}

// ---------------------------------------------------------------- 烘焙批次
const pct = (r) => (r === null || r === undefined ? '' : fmt(r * 100, 1) + '%');
const LOSS_MIN = 0.10, LOSS_MAX = 0.25;
const lossTag = (r) => (r < LOSS_MIN || r > LOSS_MAX ? `<span class="tag warn">${pct(r)}</span>` : pct(r));

async function pageRoasts() {
  const [rbeans, beans] = await Promise.all([lookup('roasted-beans', true), lookup('green-beans', true)]);
  $('#main').innerHTML = `
    <h2>烘焙批次</h2>
    <div class="toolbar">
      <label>起日<input type="date" id="from" value="${monthStart()}"></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <label>熟豆品項<select id="rbean">${options(rbeans, 'roasted_bean_id', null, { blank: '全部' })}</select></label>
      <label>投入生豆<select id="bean">${options(beans, 'bean_id', null, { blank: '全部' })}</select></label>
      <button id="search">查詢</button><span class="spacer"></span>
      <button id="add" class="primary">＋ 新增烘焙批次</button>
    </div>
    <div class="stats" id="stats"></div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;

  const load = async () => {
    try {
      const { data, summary } = await api('/roast-batches' + qs({ from: $('#from').value, to: $('#to').value, roasted_bean_id: $('#rbean').value, bean_id: $('#bean').value }));
      $('#stats').innerHTML = [['批次數', fmt(summary.count), ''], ['投入生豆 kg', '−' + kg(summary.input_kg), 'down'], ['產出熟豆 kg', '+' + kg(summary.output_kg), 'up'], ['平均失重率', pct(summary.loss_rate) || '—', ''], ['投入成本', money(summary.input_cost), '']]
        .map(([k, v, c]) => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`).join('');
      $('#list').innerHTML = data.length ? `<table><thead><tr><th>烘焙日期</th><th>批次編號</th><th>熟豆品項</th><th>投入生豆</th><th class="num">投入 kg</th><th class="num">產出 kg</th><th class="num">失重率</th><th class="num">熟豆成本/kg</th><th class="num">剩餘 kg</th><th>賞味期限</th></tr></thead><tbody>
        ${data.map((r) => `<tr class="clickable" data-id="${r.batch_id}"><td>${esc(r.roast_date)}</td><td>${esc(r.batch_no)}</td><td>${esc(r.roasted_bean_name)}</td><td>${esc(r.inputs_text)}</td>
          <td class="num down">−${kg(r.input_total_kg)}</td><td class="num up">+${kg(r.output_kg)}</td><td class="num">${lossTag(r.loss_rate)}</td>
          <td class="num">${fmt(r.unit_cost, 2)}</td><td class="num ${r.current_kg < 0 ? 'down' : ''}">${kg(r.current_kg)}</td><td>${esc(r.best_before)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">此區間沒有烘焙批次</div>';
      $$('#list tr.clickable').forEach((tr) => tr.onclick = () => roastForm(Number(tr.dataset.id), load));
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  $('#add').onclick = () => roastForm(null, load);
  load();
}

async function roastForm(id, reload) {
  try {
    const [rbeans, stock] = await Promise.all([lookup('roasted-beans', true), api('/inventory/green-beans')]);
    const b = id ? (await api(`/roast-batches/${id}`)).data : { roast_date: today(), inputs: [{}] };
    const locked = !!b.locked;
    const dis = locked ? 'disabled' : '';

    // 可選的生豆批號：目前有庫存的，加上本批次原本就投入的（修改時可用量要加回自己的投入）
    const own = new Map((b.inputs || []).filter((i) => i.lot_id).map((i) => [i.lot_id, i]));
    const lots = [];
    for (const bean of stock.data) {
      for (const l of bean.lots) {
        const avail = r2(l.closing_qty + (own.get(l.lot_id)?.input_kg || 0));
        if (avail > 0.0005) lots.push({ lot_id: l.lot_id, lot_no: l.lot_no, bean_name: bean.name, unit_cost: l.unit_cost, avail });
      }
    }
    for (const i of own.values()) { // 鎖定檢視時批號可能已用完，仍要顯示
      if (!lots.some((l) => l.lot_id === i.lot_id)) lots.push({ lot_id: i.lot_id, lot_no: i.lot_no, bean_name: i.bean_name, unit_cost: i.unit_cost, avail: i.input_kg });
    }
    const lotOpts = (sel) => '<option value="">選擇生豆批號</option>' + lots.map((l) =>
      `<option value="${l.lot_id}" ${l.lot_id === sel ? 'selected' : ''}>${esc(l.lot_no)}｜${esc(l.bean_name)}｜可用 ${kg(l.avail)} kg｜${fmt(l.unit_cost, 2)} 元/kg</option>`).join('');

    const inputRow = (it = {}) => `<tr>
      <td><select data-k="lot_id" ${dis}>${lotOpts(it.lot_id)}</select></td>
      <td><input data-k="input_kg" ${dis} type="number" step="any" min="0" value="${esc(it.input_kg)}" class="num"></td>
      <td class="num" data-cost></td><td class="num" data-amount></td>
      <td>${locked ? '' : '<button type="button" class="link" data-del>刪除</button>'}</td></tr>`;

    const box = openModal(`
      <h2>${id ? '烘焙批次 ' + esc(b.batch_no) : '新增烘焙批次'}</h2>
      ${locked ? '<div class="notice">此批次的熟豆已被使用（銷貨出庫），只能檢視，無法修改或刪除。</div>' : ''}
      ${!id && !lots.length ? '<div class="notice">目前沒有任何有庫存的生豆批號，請先建立進貨單。</div>' : ''}
      ${!id && !rbeans.some((r) => r.is_active) ? '<div class="notice">還沒有熟豆品項，請先到「主檔 → 熟豆品項」新增（例：招牌綜合 中深焙）。</div>' : ''}
      <form id="f">
        <div class="form-grid">
          <label>烘焙日期 *<input name="roast_date" type="date" required value="${esc(b.roast_date)}" ${dis}></label>
          <label>批次編號<input name="batch_no" value="${esc(b.batch_no)}" placeholder="自動產生" ${dis}></label>
          <label>熟豆品項 *<select name="roasted_bean_id" required ${dis}>${options(rbeans, 'roasted_bean_id', b.roasted_bean_id, { blank: '請選擇' })}</select></label>
          <label>產出熟豆 kg *<input name="output_kg" type="number" step="any" min="0" required value="${esc(b.output_kg)}" ${dis}></label>
          <label class="full">備註<input name="note" value="${esc(b.note)}" ${dis}></label>
        </div>
        <div class="section-title">投入生豆 ${locked ? '' : '<button type="button" id="addItem">＋ 新增一筆</button>'}</div>
        <div class="table-wrap"><table class="items"><thead><tr><th style="min-width:320px">生豆批號</th><th style="width:110px">投入 kg</th><th class="num">成本/kg</th><th class="num">投入成本</th><th></th></tr></thead>
          <tbody id="items">${b.inputs.map(inputRow).join('')}</tbody></table></div>
        <p class="hint">只需記錄：投入哪幾批生豆各幾公斤、產出多少熟豆。失重率與熟豆成本自動計算；失重率不在 10%～25% 時存檔前會提醒。</p>
        <div class="totals">
          <div><span>投入總重</span><span id="tIn" class="down"></span></div>
          <div><span>產出熟豆</span><span id="tOut" class="up"></span></div>
          <div><span>失重率</span><span id="tLoss"></span></div>
          <div><span>投入總成本</span><span id="tCost"></span></div>
          <div class="grand"><span>熟豆成本/kg</span><span id="tUnit"></span></div>
        </div>
        ${id ? `<p class="hint">熟豆剩餘 ${kg(b.current_kg)} kg${b.best_before ? '，賞味期限 ' + esc(b.best_before) : ''}。</p>` : ''}
        <div class="form-actions">
          ${id && !locked ? '<button type="button" class="danger" id="del">刪除</button>' : ''}<span class="spacer"></span>
          <button type="button" id="cancel">${locked ? '關閉' : '取消'}</button>${locked ? '' : '<button class="primary">存檔</button>'}
        </div>
      </form>`, true);

    const f = $('#f', box);
    const readItems = () => $$('#items tr', box).map((tr) => Object.fromEntries($$('[data-k]', tr).map((el) => [el.dataset.k, el.value])));
    const calc = () => {
      const rows = $$('#items tr', box);
      let inKg = 0, cost = 0;
      readItems().forEach((it, i) => {
        const lot = lots.find((l) => l.lot_id === Number(it.lot_id));
        const q = Number(it.input_kg) || 0;
        const amt = lot ? r2(q * lot.unit_cost) : 0;
        inKg += q; cost += amt;
        $('[data-cost]', rows[i]).textContent = lot ? fmt(lot.unit_cost, 2) : '';
        $('[data-amount]', rows[i]).textContent = lot && q ? money(amt) : '';
      });
      const out = Number(f.output_kg.value) || 0;
      const loss = inKg > 0 && out > 0 ? (inKg - out) / inKg : null;
      $('#tIn', box).textContent = '−' + kg(inKg) + ' kg';
      $('#tOut', box).textContent = '+' + kg(out) + ' kg';
      $('#tLoss', box).innerHTML = loss === null ? '—' : lossTag(loss);
      $('#tCost', box).textContent = money(cost);
      $('#tUnit', box).textContent = out > 0 ? fmt(cost / out, 2) : '—';
      return loss;
    };
    $('#items', box).addEventListener('input', calc);
    $('#items', box).addEventListener('change', calc);
    $('#items', box).addEventListener('click', (e) => {
      if (e.target.matches('[data-del]')) { e.target.closest('tr').remove(); calc(); }
    });
    f.output_kg.oninput = calc;
    if (!locked) $('#addItem', box).onclick = () => { $('#items', box).insertAdjacentHTML('beforeend', inputRow()); calc(); };
    $('#cancel', box).onclick = closeModal;
    calc();

    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f));
      body.inputs = readItems().filter((it) => it.lot_id || it.input_kg);
      const loss = calc();
      if (loss !== null && (loss < LOSS_MIN || loss > LOSS_MAX)
        && !confirm(`失重率 ${pct(loss)} 不在一般範圍（10%～25%）。\n請確認投入與產出公斤數沒有輸入錯誤。\n\n仍要存檔嗎？`)) return;
      try {
        const res = await api(id ? `/roast-batches/${id}` : '/roast-batches', { method: id ? 'PUT' : 'POST', body });
        closeModal();
        toast(`已存檔 ${res.data.batch_no}（失重率 ${pct(res.data.loss_rate)}）`);
        reload();
      } catch (err) { fail(err); }
    };
    if (id && !locked) $('#del', box).onclick = async () => {
      if (!confirm(`確定刪除烘焙批次 ${b.batch_no}？\n投入的生豆會加回庫存，產出的熟豆批次會一併刪除，無法復原。`)) return;
      try { await api(`/roast-batches/${id}`, { method: 'DELETE' }); closeModal(); toast('已刪除'); reload(); } catch (err) { fail(err); }
    };
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- 銷貨單
const CHANNELS = ['門市', '電話', 'LINE', '官網', '蝦皮', '批發'];
const PAY_METHODS = ['現金', '轉帳', 'LINE Pay', '刷卡', '貨到付款', '月結'];
const PAY_STATUS = ['未收', '部分收款', '已收清'];
const plainOpts = (values, sel, blank = null) => (blank === null ? '' : `<option value="">${blank}</option>`) + values.map((v) => `<option ${v === sel ? 'selected' : ''}>${v}</option>`).join('');
const payTag = (s, over = 0) => `<span class="tag ${s === '已收清' && !over ? '' : 'warn'}">${esc(over ? '應退 ' + money(over) : s)}</span>`;

async function pageSales() {
  const [customers, products] = await Promise.all([lookup('customers', true), lookup('products', true)]);
  $('#main').innerHTML = `
    <h2>銷貨單</h2>
    <div class="toolbar">
      <label>起日<input type="date" id="from" value="${monthStart()}"></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <label>客戶<select id="cust"><option value="">全部</option><option value="none">散客</option>${options(customers, 'customer_id', null, { blank: null })}</select></label>
      <label>產品<select id="prod">${options(products, 'product_id', null, { blank: '全部' })}</select></label>
      <label>通路<select id="chan">${plainOpts(CHANNELS, null, '全部')}</select></label>
      <label>收款<select id="pay">${plainOpts(PAY_STATUS, null, '全部')}</select></label>
      <button id="search">查詢</button><span class="spacer"></span>
      <button id="print">🖨 列印</button>
      <button id="add" class="primary">＋ 新增銷貨單</button>
    </div>
    <p class="hint">列印：勾選要印的銷貨單再按「列印」（沒勾選 = 印查詢結果全部）；可選每張一頁、同客戶合併或彙總表，紙張 A4／A5／80mm 熱感紙。</p>
    <div class="stats" id="stats"></div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;

  const load = async () => {
    try {
      const { data, summary } = await api('/sales' + qs({ from: $('#from').value, to: $('#to').value, customer_id: $('#cust').value, product_id: $('#prod').value, channel: $('#chan').value, payment_status: $('#pay').value }));
      $('#stats').innerHTML = [['銷貨單數', fmt(summary.count), ''], ['營業額', money(summary.total_amount), 'up'], ['熟豆成本', money(summary.cost_amount), ''], ['毛利', money(summary.gross_profit), ''], ['未收款', money(summary.unpaid_amount), ''], ['出貨熟豆 kg', '−' + kg(summary.roasted_kg), 'down']]
        .map(([k, v, c]) => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`).join('');
      $('#list').innerHTML = data.length ? `<table><thead><tr><th style="width:32px"><input type="checkbox" id="pickAll" title="全選"></th><th>銷貨日期</th><th>單號</th><th>客戶</th><th>通路</th><th class="num">明細數</th><th class="num">小計</th><th class="num">折扣</th><th class="num">運費</th><th class="num">合計</th><th class="num">未收</th><th class="num">毛利</th><th>付款方式</th><th>收款</th></tr></thead><tbody>
        ${data.map((r) => `<tr class="clickable" data-id="${r.sale_id}"><td data-pick><input type="checkbox" class="pick" value="${r.sale_id}"></td><td>${esc(r.sale_date)}</td><td>${esc(r.sale_no)}</td><td>${r.customer_name ? esc(r.customer_name) : '<span class="tag">散客</span>'}</td><td>${esc(r.channel)}</td>
          <td class="num">${r.item_count}</td><td class="num">${money(r.subtotal)}</td><td class="num">${r.discount ? '−' + money(r.discount) : ''}</td><td class="num">${r.shipping_fee ? money(r.shipping_fee) : ''}</td>
          <td class="num up"><b>${money(r.total_amount)}</b></td><td class="num">${r.unpaid_amount ? money(r.unpaid_amount) : ''}</td><td class="num">${money(r.gross_profit)}</td><td>${esc(r.payment_method)}</td><td>${payTag(r.payment_status, r.overpaid)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">此區間沒有銷貨單</div>';
      $$('#list tr.clickable').forEach((tr) => tr.onclick = () => saleForm(Number(tr.dataset.id), load));
      $$('#list [data-pick]').forEach((td) => td.onclick = (e) => e.stopPropagation()); // 勾選不開啟銷貨單
      if ($('#pickAll')) $('#pickAll').onchange = (e) => $$('#list .pick').forEach((c) => (c.checked = e.target.checked));
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  $('#print').onclick = () => {
    const picked = $$('#list .pick:checked').map((c) => Number(c.value));
    printSales(picked.length ? picked : $$('#list .pick').map((c) => Number(c.value)));
  };
  $('#add').onclick = () => saleForm(null, load);
  load();
}

async function saleForm(id, reload) {
  try {
    const [customers, products] = await Promise.all([lookup('customers', true), lookup('products', true)]);
    const s = id ? (await api(`/sales/${id}`)).data : { sale_date: today(), channel: '門市', payment_method: '現金', payment_status: '未收', items: [{}], discount: 0, shipping_fee: 0 };
    const prodOf = (pid) => products.find((p) => p.product_id === Number(pid));
    const priceFor = (p, cust) => (cust?.price_level === '批發價' && p.wholesale_price != null ? p.wholesale_price : p.retail_price);

    const itemRow = (it = {}) => `<tr>
      <td><select data-k="product_id">${options(products, 'product_id', it.product_id, { blank: '選擇產品' })}</select></td>
      <td><select data-k="grind_size">${plainOpts(GRIND, it.grind_size, '')}</select></td>
      <td><input data-k="qty" type="number" step="1" min="1" value="${esc(it.qty)}" class="num"></td>
      <td><input data-k="unit_price" type="number" step="any" min="0" value="${esc(it.unit_price)}" class="num"></td>
      <td class="num" data-amount></td><td class="num down" data-kg></td>
      <td data-lots>${(it.lots || []).map((l) => `${esc(l.batch_no)} ${kg(l.kg)}kg`).join('、')}${it.undeducted_kg ? ` <span class="tag warn">未扣 ${kg(it.undeducted_kg)}kg</span>` : ''}${it.packs?.length ? `<div class="hint">包材：${it.packs.map((k) => `${esc(k.name)}×${fmt(k.qty)}`).join('、')}</div>` : ''}</td>
      <td><button type="button" class="link" data-del>刪除</button></td></tr>`;

    const box = openModal(`
      <h2>${id ? '銷貨單 ' + esc(s.sale_no) : '新增銷貨單'}</h2>
      ${s.overpaid ? `<div class="notice">已收 ${money(s.paid_amount)}，比應收淨額 ${money(s.net_amount)} 多 ${money(s.overpaid)}（應退客戶），請按「登錄退款」或確認金額。</div>` : ''}
      ${s.returns?.length ? '<div class="notice">這張銷貨單已有退貨／折讓，明細不能再修改（要改請先刪除退貨單）。</div>' : ''}
      <form id="f">
        <div class="form-grid">
          <label>銷貨日期 *<input name="sale_date" type="date" required value="${esc(s.sale_date)}"></label>
          <label>銷貨單號<input name="sale_no" value="${esc(s.sale_no)}" placeholder="自動產生"></label>
          <label>客戶<select name="customer_id">${options(customers, 'customer_id', s.customer_id, { blank: '散客（不指定）', label: (c) => `${c.name}（${c.price_level}）` })}</select></label>
          <label>通路<select name="channel">${plainOpts(CHANNELS, s.channel)}</select></label>
          <label>付款方式<select name="payment_method">${plainOpts(PAY_METHODS, s.payment_method)}</select></label>
          <label>收款狀態<input value="${esc(s.payment_status)}${s.paid_amount ? `（已收 ${money(s.paid_amount)}）` : ''}" disabled></label>
          <label>應收日期<input name="due_date" type="date" value="${esc(s.due_date)}"></label>
          <label class="full">備註<input name="note" value="${esc(s.note)}"></label>
        </div>
        <div id="prefs"></div>
        <div class="section-title">明細 <button type="button" id="addItem">＋ 新增一筆</button></div>
        <div class="table-wrap"><table class="items"><thead><tr><th style="min-width:220px">產品</th><th style="width:90px">研磨</th><th style="width:80px">數量</th><th style="width:100px">單價</th>
          <th class="num">小計</th><th class="num">扣熟豆 kg</th><th>出貨熟豆批次</th><th></th></tr></thead>
          <tbody id="items">${s.items.map(itemRow).join('')}</tbody></table></div>
        <p class="hint">選產品後自動帶入單價（批發價客戶帶批發價）。有指定熟豆品項的產品，存檔時依「數量 × 每包淨重」以先進先出扣熟豆庫存；熟豆不足時會先提醒，確認後仍可存檔。</p>
        <div class="totals">
          <div><span>明細小計</span><span id="tItems"></span></div>
          <div><span>折扣</span><input name="discount" type="number" step="any" min="0" value="${esc(s.discount)}" style="width:110px;text-align:right"></div>
          <div><span>運費</span><input name="shipping_fee" type="number" step="any" min="0" value="${esc(s.shipping_fee)}" style="width:110px;text-align:right"></div>
          <div class="grand"><span>合計</span><span id="tTotal" class="up"></span></div>
          ${id ? `<div><span>熟豆成本</span><span>${money(s.cost_amount)}</span></div><div><span>毛利（不含運費）</span><span>${money(s.gross_profit)}</span></div>
                  ${s.returned_amount ? `<div><span>退貨／折讓</span><span class="down">−${money(s.returned_amount)}</span></div><div><span>應收淨額</span><span>${money(s.net_amount)}</span></div>` : ''}
                  <div><span>已收</span><span>${money(s.paid_amount)}</span></div><div><span>未收</span><span>${money(s.unpaid_amount)}</span></div>` : ''}
        </div>
        ${id ? returnsBlock(s) : ''}
        ${id ? `<div class="section-title">發票</div>${(s.invoices || []).length ? `<div class="table-wrap"><table><thead><tr><th>發票號碼</th><th>日期</th><th>類型</th><th>統編</th><th class="num">含稅</th><th>狀態</th></tr></thead><tbody>
          ${s.invoices.map((i) => `<tr class="clickable" data-inv="${i.invoice_id}"><td>${esc(i.invoice_no)}</td><td>${esc(i.invoice_date)}</td><td>${esc(i.invoice_type)}</td><td>${esc(i.buyer_tax_id)}</td><td class="num">${money(i.amount)}</td><td>${invTag(i.status)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">尚未登錄發票。</p>'}` : ''}
        ${id ? paymentsBlock(s, '收款') : '<p class="hint">收款狀態由收款沖帳決定：存檔後到「銀行收支」登錄入帳（現金、LINE Pay、刷卡也一樣）並沖銷這張單，或存檔後重新開啟這張單按「登錄收款」。</p>'}
        <div class="form-actions">
          ${id ? '<button type="button" class="danger" id="del">刪除</button>' : ''}<span class="spacer"></span>
          ${id ? '<button type="button" id="docPrint" title="列印已存檔的內容">🖨 列印</button>' : ''}
          ${id ? '<button type="button" id="docReturn">退貨／折讓</button>' : ''}
          ${id && !(s.invoices || []).some((i) => i.status !== '作廢') ? '<button type="button" id="docInvoice">登錄發票</button>' : ''}
          ${id && s.overpaid > 0 ? '<button type="button" id="docRefund">登錄退款</button>' : ''}
          ${id && s.unpaid_amount > 0 ? '<button type="button" id="docRecv">登錄收款</button>' : ''}
          <button type="button" id="cancel">取消</button><button class="primary">存檔</button>
        </div>
      </form>`, true);

    const f = $('#f', box);
    if ($('#docReturn', box)) $('#docReturn', box).onclick = () => {
      const pickBox = openModal(`<h2>${esc(s.sale_no)} 退貨／折讓</h2><p class="hint">銷貨退回：退回部分或全部品項（可選擇熟豆是否回補）；銷貨折讓：只調降金額，不動庫存。</p>
        <div class="form-actions"><button type="button" id="rt1" class="primary">銷貨退回</button><button type="button" id="rt2" class="primary">銷貨折讓</button><span class="spacer"></span><button type="button" id="cancel">取消</button></div>`);
      $('#rt1', pickBox).onclick = () => returnForm('銷貨退回', { sale_id: id }, null, reload);
      $('#rt2', pickBox).onclick = () => returnForm('銷貨折讓', { sale_id: id }, null, reload);
      $('#cancel', pickBox).onclick = closeModal;
    };
    if ($('#docPrint', box)) $('#docPrint', box).onclick = () => printSales([id], () => saleForm(id, reload));
    if ($('#docInvoice', box)) $('#docInvoice', box).onclick = () => invoiceForm(id, null, reload);
    if ($('#docRefund', box)) $('#docRefund', box).onclick = () => txnForm(DIR_OUT, null, reload, { category: '其他', counterparty: s.customer_name, amount: s.overpaid, description: `${s.sale_no} 退款`, allocations: [{ doc_type: 'sales', doc_id: id, amount: s.overpaid }] });
    $$('[data-inv]', box).forEach((tr) => tr.onclick = () => invoiceForm(id, Number(tr.dataset.inv), reload));
    bindReturnRows(box, reload);
    if ($('#docRecv', box)) $('#docRecv', box).onclick = () => txnForm(DIR_IN, null, reload, { category: '銷貨收款', customer_id: s.customer_id, amount: s.unpaid_amount, description: s.sale_no, allocations: [{ doc_type: 'sales', doc_id: id, amount: s.unpaid_amount }] });
    const custOf = () => customers.find((c) => c.customer_id === Number(f.customer_id.value));
    const readItems = () => $$('#items tr', box).map((tr) => Object.fromEntries($$('[data-k]', tr).map((el) => [el.dataset.k, el.value])));
    const recalc = () => {
      const rows = $$('#items tr', box);
      let sum = 0;
      readItems().forEach((it, i) => {
        const p = prodOf(it.product_id);
        const q = Number(it.qty) || 0;
        const amt = r2(q * (Number(it.unit_price) || 0));
        sum += amt;
        $('[data-amount]', rows[i]).textContent = q ? money(amt) : '';
        $('[data-kg]', rows[i]).textContent = p?.roasted_bean_id && p.net_weight_g && q ? '−' + kg(q * p.net_weight_g / 1000) : '';
      });
      $('#tItems', box).textContent = money(sum);
      $('#tTotal', box).textContent = money(r2(sum) - (Number(f.discount.value) || 0) + (Number(f.shipping_fee.value) || 0));
    };
    // 顯示客戶喜好（Phase 1 客戶主檔），方便出貨時確認烘焙度與研磨度
    const showPrefs = async () => {
      const el = $('#prefs', box);
      el.innerHTML = '';
      if (!f.customer_id.value) return;
      try {
        const { data } = await api(`/customers/${f.customer_id.value}`);
        const lines = (data.preferences || []).map((p) => [p.roast_level, p.grind_size, p.flavor_notes, p.brew_method, p.favorite_products && '常買：' + p.favorite_products, p.dislikes && '不喜歡：' + p.dislikes, p.note].filter(Boolean).join('／')).filter(Boolean);
        const extra = [data.payment_terms && '付款條件：' + data.payment_terms, data.note].filter(Boolean).join('　');
        if (lines.length || extra) el.innerHTML = `<p class="hint">${lines.length ? '客戶喜好：' + lines.map(esc).join('；') : ''}${lines.length && extra ? '　｜　' : ''}${esc(extra)}</p>`;
      } catch { /* 喜好只是提示，讀不到不影響開單 */ }
    };

    $('#items', box).addEventListener('input', recalc);
    $('#items', box).addEventListener('change', (e) => {
      if (e.target.dataset.k === 'product_id') { // 帶入單價
        const p = prodOf(e.target.value);
        const tr = e.target.closest('tr');
        if (p) {
          const price = priceFor(p, custOf());
          $('[data-k=unit_price]', tr).value = price ?? '';
          if (!$('[data-k=qty]', tr).value) $('[data-k=qty]', tr).value = 1;
        }
        $('[data-lots]', tr).textContent = '';
      }
      recalc();
    });
    $('#items', box).addEventListener('click', (e) => {
      if (e.target.matches('[data-del]')) { e.target.closest('tr').remove(); recalc(); }
    });
    f.discount.oninput = f.shipping_fee.oninput = recalc;
    f.customer_id.onchange = () => {
      const c = custOf();
      if (!id && c && /月結/.test(c.payment_terms || '')) f.payment_method.value = '月結';
      showPrefs();
    };
    $('#addItem', box).onclick = () => { $('#items', box).insertAdjacentHTML('beforeend', itemRow()); recalc(); };
    $('#cancel', box).onclick = closeModal;
    recalc();
    showPrefs();

    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f));
      body.items = readItems().filter((it) => it.product_id || it.qty).map((it) => ({ product_id: it.product_id, grind_size: it.grind_size, qty: it.qty, unit_price: it.unit_price }));
      const save = (extra = {}) => api(id ? `/sales/${id}` : '/sales', { method: id ? 'PUT' : 'POST', body: { ...body, ...extra } });
      try {
        let res;
        try { res = await save(); } catch (err) {
          if (err.detail?.code !== 'SHORTAGE') throw err;
          const lines = shortageLines(err.detail.shortages);
          if (!confirm(`庫存不足（熟豆只計算烘焙日在銷貨日當天或之前的批次）：\n\n${lines.join('\n')}\n\n補登烘焙批次或進貨後，重新存檔這張銷貨單就會重新扣庫存。\n仍要存檔嗎？`)) return;
          res = await save({ allow_shortage: true });
        }
        closeModal();
        toast(`已存檔 ${res.data.sale_no}（合計 ${money(res.data.total_amount)}）`);
        reload();
      } catch (err) { fail(err); }
    };
    if (id) $('#del', box).onclick = async () => {
      if (!confirm(`確定刪除銷貨單 ${s.sale_no}？\n已扣的熟豆會加回庫存，無法復原。`)) return;
      try { await api(`/sales/${id}`, { method: 'DELETE' }); closeModal(); toast('已刪除'); reload(); } catch (err) { fail(err); }
    };
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- 客戶購買紀錄
async function pageCustomerHistory() {
  const [customers, products] = await Promise.all([lookup('customers', true), lookup('products', true)]);
  $('#main').innerHTML = `
    <h2>客戶購買紀錄</h2>
    <div class="toolbar">
      <label>客戶<select id="cust"><option value="">全部客戶</option><option value="none">散客</option>${options(customers, 'customer_id', null, { blank: null })}</select></label>
      <label>起日<input type="date" id="from" value=""></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <label>產品<select id="prod">${options(products, 'product_id', null, { blank: '全部' })}</select></label>
      <button id="search">查詢</button>
    </div>
    <p class="hint">購買紀錄 = 依客戶篩選的銷貨明細。起日留空 = 從最早紀錄算起。點任一列可開啟該張銷貨單。</p>
    <div class="stats" id="stats"></div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;

  const load = async () => {
    try {
      const { data, summary } = await api('/sales/items' + qs({ from: $('#from').value, to: $('#to').value, customer_id: $('#cust').value, product_id: $('#prod').value }));
      const top = summary.by_product.slice(0, 3).map((p) => `${p.product_name} ×${fmt(p.qty)}`).join('、');
      $('#stats').innerHTML = [['購買次數', fmt(summary.sale_count)], ['累計金額', money(summary.amount)], ['累計熟豆 kg', kg(summary.kg)], ['最近購買日', summary.last_date || '—']]
        .map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join('')
        + `<div class="stat" style="grid-column: span 2"><div class="k">常買品項</div><div class="v" style="font-size:15px">${esc(top) || '—'}</div></div>`;
      $('#list').innerHTML = data.length ? `<table><thead><tr><th>銷貨日期</th><th>單號</th><th>客戶</th><th>產品</th><th>研磨</th><th class="num">數量</th><th class="num">單價</th><th class="num">小計</th><th>通路</th><th>收款</th></tr></thead><tbody>
        ${data.map((r) => `<tr class="clickable" data-id="${r.sale_id}"><td>${esc(r.sale_date)}</td><td>${esc(r.sale_no)}</td><td>${r.customer_name ? esc(r.customer_name) : '<span class="tag">散客</span>'}</td><td>${esc(r.product_name)}</td><td>${esc(r.grind_size)}</td>
          <td class="num">${fmt(r.qty)}</td><td class="num">${money(r.unit_price)}</td><td class="num">${money(r.amount)}</td><td>${esc(r.channel)}</td><td>${payTag(r.payment_status)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">沒有購買紀錄</div>';
      $$('#list tr.clickable').forEach((tr) => tr.onclick = () => saleForm(Number(tr.dataset.id), load));
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  $('#cust').onchange = load;
  load();
}

// ---------------------------------------------------------------- 熟豆庫存查詢
async function pageStockRoasted() {
  const rbeans = await lookup('roasted-beans', true);
  $('#main').innerHTML = `
    <h2>熟豆庫存查詢</h2>
    <div class="toolbar">
      <label>起日<input type="date" id="from" value="${monthStart()}"></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <label>熟豆品項<select id="bean">${options(rbeans, 'roasted_bean_id', null, { blank: '全部' })}</select></label>
      <label>顯示<select id="empty"><option value="">有庫存或異動的品項</option><option value="1">全部品項</option></select></label>
      <button id="search">查詢</button>
    </div>
    <p class="hint">熟豆批次 = 烘焙批次。期初 = 起日前一天的庫存；期末 = 迄日當天結束的庫存。點品項可展開批次，點批次可看異動明細。<span class="up">紅色 = 入庫</span>、<span class="down">綠色 = 出庫</span>。</p>
    <div class="stats" id="stats"></div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;

  const load = async () => {
    try {
      const range = { from: $('#from').value, to: $('#to').value };
      const { data, total } = await api('/inventory/roasted' + qs({ ...range, roasted_bean_id: $('#bean').value, show_empty: $('#empty').value }));
      $('#stats').innerHTML = [['期初 kg', kg(total.opening_qty), ''], ['本期烘焙產出 kg', '+' + kg(total.in_qty), 'up'], ['本期出庫 kg', '−' + kg(total.out_qty), 'down'], ['期末 kg', kg(total.closing_qty), ''], ['期末庫存金額', money(total.closing_amount), '']]
        .map(([k, v, c]) => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`).join('');
      if (!data.length) { $('#list').innerHTML = '<div class="empty">沒有資料</div>'; return; }
      const lotTag = (l) => (l.status === '負庫存' ? '<span class="tag warn">負庫存（待補登烘焙）</span>'
        : l.expired ? '<span class="tag warn">已過賞味期</span>' : l.expiring ? '<span class="tag warn">7 天內到期</span>' : `<span class="tag">${l.status}</span>`);
      $('#list').innerHTML = `<table><thead><tr><th>熟豆品項／批次</th><th>烘焙日</th><th>賞味期限</th><th class="num">失重率</th><th class="num">成本/kg</th>
        <th class="num">期初 kg</th><th class="num">入庫 kg</th><th class="num">出庫 kg</th><th class="num">期末 kg</th><th class="num">期末金額</th><th>狀態</th></tr></thead><tbody>
        ${data.map((b) => `
          <tr class="clickable bean" data-bean="${b.roasted_bean_id}"><td>▸ <b>${esc(b.name)}</b>（${b.lots.length} 批）</td><td></td><td></td><td></td>
            <td class="num">${b.avg_cost == null ? '' : fmt(b.avg_cost, 2)}</td><td class="num">${kg(b.opening_qty)}</td>${inCell(b.in_qty)}${outCell(b.out_qty)}
            <td class="num"><b>${kg(b.closing_qty)}</b></td><td class="num">${money(b.closing_amount)}</td>
            <td>${[b.negative ? '<span class="tag warn">有負庫存</span>' : '', b.low_stock ? `<span class="tag warn">低於安全庫存 ${fmt(b.safety_stock_kg)}kg</span>` : '', b.expiring_count ? `<span class="tag warn">${b.expiring_count} 批將到期</span>` : ''].join(' ')}</td></tr>
          ${b.lots.map((l) => `<tr class="sub clickable" data-parent="${b.roasted_bean_id}" data-lot="${l.roasted_lot_id}" data-lotno="${esc(l.batch_no)}" hidden>
            <td>${esc(l.batch_no)}</td><td>${esc(l.roast_date)}</td><td>${esc(l.best_before)}</td><td class="num">${pct(l.loss_rate)}</td>
            <td class="num">${fmt(l.unit_cost, 2)}</td><td class="num">${kg(l.opening_qty)}</td>${inCell(l.in_qty)}${outCell(l.out_qty)}
            <td class="num">${kg(l.closing_qty)}</td><td class="num">${money(l.closing_amount)}</td><td>${lotTag(l)}</td></tr>`).join('')}`).join('')}
        <tr class="total"><td>合計</td><td></td><td></td><td></td><td></td><td class="num">${kg(total.opening_qty)}</td>${inCell(total.in_qty)}${outCell(total.out_qty)}
          <td class="num">${kg(total.closing_qty)}</td><td class="num">${money(total.closing_amount)}</td><td></td></tr>
        </tbody></table>`;
      $$('#list tr.bean').forEach((tr) => tr.onclick = () => {
        const subs = $$(`#list tr[data-parent="${tr.dataset.bean}"]`);
        const open = subs[0]?.hidden;
        subs.forEach((x) => (x.hidden = !open));
        tr.cells[0].firstChild.textContent = open ? '▾ ' : '▸ ';
      });
      $$('#list tr.sub').forEach((tr) => tr.onclick = () => movementModal(`熟豆批次 ${tr.dataset.lotno} 異動明細`, { item_type: '熟豆', roasted_lot_id: tr.dataset.lot, ...range }, 'kg'));
      if (data.length === 1) $('#list tr.bean').click();
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  load();
}

// ---------------------------------------------------------------- 期初庫存
async function pageOpening() {
  $('#main').innerHTML = `
    <h2>期初庫存</h2>
    <div class="toolbar">
      <span class="spacer"></span>
      <button id="addBean" class="primary">＋ 新增生豆期初</button>
      <button id="addPack" class="primary">＋ 新增包材期初</button>
    </div>
    <p class="hint">開始使用系統時手上已有的生豆、包材在這裡登錄，不經過進貨單（不算進貨金額、不產生應付帳款）。
      庫存查詢的「期初」是起日之前所有異動的加總，所以<b>期初日期請填開帳日的前一天</b>（例如 11/1 開始記帳就填 10/31），查詢 11/1 之後的區間時這些數量就會出現在「期初」欄。
      生豆期初批號被烘焙使用後會鎖定。點任一列可修改。</p>
    <div class="stats" id="stats"></div>
    <div class="section-title">生豆</div>
    <div class="card"><div class="table-wrap" id="beans"></div></div>
    <div class="section-title">包材</div>
    <div class="card"><div class="table-wrap" id="packs"></div></div>`;

  const load = async () => {
    try {
      const { beans, packaging, summary } = await api('/opening-stock');
      $('#stats').innerHTML = [['生豆期初 kg', '+' + kg(summary.bean_kg)], ['生豆期初金額', money(summary.bean_amount)], ['包材期初金額', money(summary.packaging_amount)]]
        .map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
      $('#beans').innerHTML = beans.length ? `<table><thead><tr><th>期初日期</th><th>批號</th><th>生豆品項</th><th class="num">期初 kg</th><th class="num">成本/kg</th><th class="num">金額</th><th class="num">目前剩餘 kg</th><th>位置</th><th>備註</th><th>狀態</th></tr></thead><tbody>
        ${beans.map((b) => `<tr class="clickable" data-id="${b.lot_id}"><td>${esc(b.received_date)}</td><td>${esc(b.lot_no)}</td><td>${esc(b.bean_name)}</td>
          <td class="num up">+${kg(b.initial_kg)}</td><td class="num">${fmt(b.unit_cost, 2)}</td><td class="num">${money(b.amount)}</td><td class="num">${kg(b.current_kg)}</td>
          <td>${esc(b.storage_location)}</td><td>${esc(b.note)}</td><td>${b.locked ? '<span class="tag warn">已使用，鎖定</span>' : '<span class="tag">可修改</span>'}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">還沒有生豆期初庫存</div>';
      $('#packs').innerHTML = packaging.length ? `<table><thead><tr><th>期初日期</th><th>包材</th><th class="num">期初數量</th><th>單位</th><th class="num">單價</th><th class="num">金額</th><th>備註</th></tr></thead><tbody>
        ${packaging.map((p) => `<tr class="clickable" data-id="${p.movement_id}"><td>${esc(p.date)}</td><td>${esc(p.packaging_name)}</td>
          <td class="num up">+${fmt(p.qty)}</td><td>${esc(p.unit)}</td><td class="num">${fmt(p.unit_cost, 2)}</td><td class="num">${money(p.amount)}</td><td>${esc(p.note)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">還沒有包材期初庫存</div>';
      $$('#beans tr.clickable').forEach((tr) => tr.onclick = () => openingForm('生豆', beans.find((b) => b.lot_id === Number(tr.dataset.id)), load));
      $$('#packs tr.clickable').forEach((tr) => tr.onclick = () => openingForm('包材', packaging.find((p) => p.movement_id === Number(tr.dataset.id)), load));
    } catch (e) { fail(e); }
  };
  $('#addBean').onclick = () => openingForm('生豆', null, load);
  $('#addPack').onclick = () => openingForm('包材', null, load);
  load();
}

async function openingForm(type, row, reload) {
  try {
    const isBean = type === '生豆';
    const master = await lookup(isBean ? 'green-beans' : 'packaging-items', true);
    const id = row ? (isBean ? 'g' + row.lot_id : 'p' + row.movement_id) : null;
    const locked = !!row?.locked;
    const dis = locked ? 'disabled' : '';
    const r = row || {};
    const box = openModal(`
      <h2>${row ? '修改' : '新增'}${type}期初庫存</h2>
      ${locked ? '<div class="notice">此批號已被使用（烘焙投入等），只能檢視，無法修改或刪除。</div>' : ''}
      <form id="f">
        <div class="form-grid">
          <label>期初日期 *<input name="date" type="date" required value="${esc(isBean ? r.received_date : r.date) || today()}" ${dis}></label>
          ${isBean
            ? `<label>生豆品項 *<select name="bean_id" required ${dis}>${options(master, 'bean_id', r.bean_id, { blank: '請選擇' })}</select></label>
               <label>批號<input name="lot_no" value="${esc(r.lot_no)}" placeholder="自動產生" ${dis}></label>`
            : `<label>包材 *<select name="packaging_id" required ${dis}>${options(master, 'packaging_id', r.packaging_id, { blank: '請選擇', label: (k) => `${k.name}（${k.unit}）` })}</select></label>`}
          <label>${isBean ? '數量（kg）' : '數量'} *<input name="qty" type="number" step="any" min="0" required value="${esc(isBean ? r.initial_kg : r.qty)}" ${dis}></label>
          <label>${isBean ? '每 kg 成本' : '單價'}<input name="unit_cost" type="number" step="any" min="0" value="${esc(r.unit_cost)}" ${dis}></label>
          <label>金額<input id="amt" disabled></label>
          ${isBean ? `<label>存放位置<input name="storage_location" value="${esc(r.storage_location)}" ${dis}></label>` : ''}
          <label class="full">備註<input name="note" value="${esc(r.note)}" ${dis}></label>
        </div>
        <p class="hint">期初日期請填開帳日的前一天。${isBean ? '每 kg 成本會帶入之後的烘焙成本，請填當初的進貨成本（含運費、稅）。' : ''}</p>
        <div class="form-actions">
          ${row && !locked ? '<button type="button" class="danger" id="del">刪除</button>' : ''}<span class="spacer"></span>
          <button type="button" id="cancel">${locked ? '關閉' : '取消'}</button>${locked ? '' : '<button class="primary">存檔</button>'}
        </div>
      </form>`);
    const f = $('#f', box);
    const calc = () => { $('#amt', box).value = money(r2((Number(f.qty.value) || 0) * (Number(f.unit_cost.value) || 0))); };
    f.qty.oninput = f.unit_cost.oninput = calc;
    if (!isBean) f.packaging_id.onchange = () => { // 帶入包材參考單價
      const k = master.find((x) => x.packaging_id === Number(f.packaging_id.value));
      if (k?.unit_cost != null && !f.unit_cost.value) { f.unit_cost.value = k.unit_cost; calc(); }
    };
    calc();
    $('#cancel', box).onclick = closeModal;
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = { ...Object.fromEntries(new FormData(f)), item_type: type };
      try {
        await api(id ? `/opening-stock/${id}` : '/opening-stock', { method: id ? 'PUT' : 'POST', body });
        closeModal(); toast('已存檔'); reload();
      } catch (err) { fail(err); }
    };
    if (row && !locked) $('#del', box).onclick = async () => {
      if (!confirm(`確定刪除這筆${type}期初庫存？無法復原。`)) return;
      try { await api(`/opening-stock/${id}`, { method: 'DELETE' }); closeModal(); toast('已刪除'); reload(); } catch (err) { fail(err); }
    };
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- 財務共用
const DIR_IN = '入帳', DIR_OUT = '出帳';
const TXN_CATS = { [DIR_IN]: ['銷貨收款', '利息', '其他'], [DIR_OUT]: ['進貨付款', '費用', '手續費', '其他'] };
const ALL_CATS = ['銷貨收款', '進貨付款', '費用', '轉帳', '手續費', '利息', '其他'];
const statusTag = (s) => `<span class="tag ${['已收清', '已付清'].includes(s) ? '' : 'warn'}">${esc(s)}</span>`;
const inAmt = (n) => `<td class="num up">${n ? '+' + money(n) : ''}</td>`;
const outAmt = (n) => `<td class="num down">${n ? '−' + money(n) : ''}</td>`;
const statCards = (rows) => rows.map(([k, v, c = '']) => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`).join('');
/** 單據的收付款紀錄（銷貨單、進貨單、費用表單共用） */
const paymentsBlock = (d, word) => (d.payments?.length
  ? `<div class="section-title">${word}紀錄</div><div class="table-wrap"><table><thead><tr><th>日期</th><th>收支編號</th><th>帳戶</th><th class="num">沖銷金額</th></tr></thead><tbody>
      ${d.payments.map((p) => `<tr><td>${esc(p.txn_date)}</td><td>${esc(p.txn_no)}</td><td>${esc(p.account_name)}</td><td class="num">${money(p.amount)}</td></tr>`).join('')}</tbody></table></div>`
  : `<p class="hint">還沒有${word}紀錄。${word}請到 <a href="#bank">銀行收支</a> 登錄${word === '收款' ? '入帳' : '出帳'}並沖銷這張單。</p>`);

// ---------------------------------------------------------------- 銀行收支
async function pageBank() {
  const accounts = await lookup('bank-accounts', true);
  $('#main').innerHTML = `
    <h2>銀行收支</h2>
    <div class="acct-strip" id="accts"></div>
    <div class="toolbar">
      <label>帳戶<select id="acc">${options(accounts, 'account_id', null, { blank: '全部帳戶', label: (a) => a.account_name })}</select></label>
      <label>起日<input type="date" id="from" value="${monthStart()}"></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <label>類別<select id="cat">${plainOpts(ALL_CATS, null, '全部')}</select></label>
      <label>沖帳<select id="alloc"><option value="">全部</option><option value="open">尚未沖完的收付款</option></select></label>
      <button id="search">查詢</button><span class="spacer"></span>
      <button id="addIn" class="primary">＋ 入帳</button><button id="addOut" class="primary">＋ 出帳</button><button id="addTr">⇄ 帳戶互轉</button>
    </div>
    <p class="hint">收款、付款都在這裡登錄，再勾選要沖銷的單據：<span class="up">入帳</span>沖銷貨單、<span class="down">出帳</span>沖進貨單或費用，單據的收付款狀態會自動更新。
      現金、LINE Pay、刷卡收單請各建一個帳戶（主檔 → 銀行帳戶）；把現金存進銀行用「帳戶互轉」。選單一帳戶時會顯示每筆之後的餘額。</p>
    <div class="stats" id="stats"></div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;
  if (!accounts.length) $('#list').innerHTML = '<div class="empty">還沒有任何帳戶，請先到「主檔 → 銀行帳戶」新增（例：台銀公司戶、門市現金、LINE Pay）。</div>';

  const loadAccts = async () => {
    const { data, total } = await api('/bank-transactions/balances');
    $('#accts').innerHTML = data.filter((a) => a.is_active).map((a) => `<div class="acct" data-id="${a.account_id}"><div class="k">${esc(a.account_name)}</div><div class="v ${a.balance < 0 ? 'down' : ''}">${money(a.balance)}</div></div>`).join('')
      + (data.length ? `<div class="acct total"><div class="k">合計餘額</div><div class="v">${money(total)}</div></div>` : '');
    $$('#accts .acct[data-id]').forEach((el) => el.onclick = () => { $('#acc').value = el.dataset.id; load(); });
  };
  const load = async () => {
    try {
      loadAccts();
      const acc = $('#acc').value;
      const { data, summary } = await api('/bank-transactions' + qs({ account_id: acc, from: $('#from').value, to: $('#to').value, category: $('#cat').value, alloc: $('#alloc').value }));
      $('#stats').innerHTML = statCards([
        ...(acc ? [['期初餘額', money(summary.opening_balance)]] : []),
        ['本期入帳', '+' + money(summary.in_amount), 'up'], ['本期出帳', '−' + money(summary.out_amount), 'down'],
        ...(acc ? [['期末餘額', money(summary.closing_balance)]] : [['筆數', fmt(summary.count)]]),
      ]);
      const showBal = acc && summary.running_balance;
      $('#list').innerHTML = data.length ? `<table><thead><tr><th>日期</th><th>編號</th><th>帳戶</th><th>類別</th><th>對象</th><th>摘要</th><th class="num">入帳</th><th class="num">出帳</th>${showBal ? '<th class="num">餘額</th>' : ''}<th>沖銷單據</th><th>對帳</th></tr></thead><tbody>
        ${data.map((r) => `<tr class="clickable" data-id="${r.txn_id}"><td>${esc(r.txn_date)}</td><td>${esc(r.txn_no)}</td><td>${esc(r.account_name)}</td><td>${esc(r.category)}</td>
          <td>${r.category === '轉帳' ? (r.direction === DIR_OUT ? '→ ' : '← ') + esc(r.transfer_account_name) : esc(r.counterparty)}</td><td>${esc(r.description)}</td>
          ${r.direction === DIR_IN ? inAmt(r.amount) + '<td></td>' : '<td></td>' + outAmt(r.amount)}${showBal ? `<td class="num">${money(r.balance)}</td>` : ''}
          <td>${esc(r.doc_nos)}${['銷貨收款', '進貨付款', '費用'].includes(r.category) && r.unallocated > 0.005 ? ` <span class="tag warn">未沖 ${money(r.unallocated)}</span>` : ''}</td><td>${r.reconciled ? '✓' : ''}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">此區間沒有收支</div>';
      $$('#list tr.clickable').forEach((tr) => tr.onclick = () => txnForm(null, Number(tr.dataset.id), load));
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  $('#acc').onchange = load;
  $('#addIn').onclick = () => txnForm(DIR_IN, null, load);
  $('#addOut').onclick = () => txnForm(DIR_OUT, null, load);
  $('#addTr').onclick = () => transferForm(null, load);
  load();
}

async function txnForm(direction, id, reload, preset = {}) {
  try {
    const t = id ? (await api(`/bank-transactions/${id}`)).data : { txn_date: today(), direction, category: TXN_CATS[direction][0], allocations: [], ...preset };
    if (t.transfer_txn_id) return transferForm(t, reload);
    direction = t.direction;
    const isIn = direction === DIR_IN;
    const [accounts, parties] = await Promise.all([lookup('bank-accounts', true), lookup(isIn ? 'customers' : 'suppliers', true)]);
    const partyKey = isIn ? 'customer_id' : 'supplier_id';
    const word = isIn ? '收款' : '付款';

    const box = openModal(`
      <h2>${id ? `${esc(t.txn_no)}（${direction}）` : `新增${direction}`}</h2>
      ${t.reconciled ? '<div class="notice">這筆已對帳，不能改帳戶、日期、金額或刪除（沖帳、摘要仍可改）；要改請先到「銀行對帳」取消對帳。</div>' : ''}
      <form id="f">
        <div class="form-grid">
          <label>帳戶 *<select name="account_id" required>${options(accounts, 'account_id', t.account_id, { blank: '請選擇', label: (a) => a.account_name })}</select></label>
          <label>交易日期 *<input name="txn_date" type="date" required value="${esc(t.txn_date)}"></label>
          <label>金額 *<input name="amount" type="number" step="any" min="0" required value="${esc(t.amount)}" class="${isIn ? 'up' : 'down'}"></label>
          <label>類別<select name="category">${plainOpts(TXN_CATS[direction], t.category)}</select></label>
          <label>${isIn ? '客戶' : '供應商'}<select name="${partyKey}">${options(parties, partyKey, t[partyKey], { blank: isIn ? '（不指定／散客）' : '（不指定）' })}</select></label>
          <label>交易對象（自由填寫）<input name="counterparty" value="${esc(t.counterparty)}" placeholder="選了${isIn ? '客戶' : '供應商'}可留空"></label>
          <label>銀行交易序號<input name="bank_ref_no" value="${esc(t.bank_ref_no)}"></label>
          ${isIn ? '' : `<label>匯費（另記一筆手續費）<input name="fee" type="number" step="any" min="0" value="${esc(t.fee_amount ?? '')}" placeholder="0" ${t.fee_reconciled ? 'title="匯費已對帳"' : ''}></label>
          <label class="full">收款帳戶<span class="inline"><select name="payee_account_id" style="flex:1"><option value="">（先選供應商）</option></select><button type="button" class="link" id="copyPayee">複製帳號</button></span></label>
          <div class="full hint" id="payeeInfo">${t.payee_info ? '本筆紀錄：' + esc(t.payee_info) : ''}</div>`}
          ${t.fee_parent_no ? `<div class="full hint">這筆是 ${esc(t.fee_parent_no)} 的匯費，修改付款時會一起更新。</div>` : ''}
          <label class="full">摘要<input name="description" value="${esc(t.description)}"></label>
        </div>
        <div class="section-title">沖銷${isIn ? '銷貨單' : '進貨單／費用'} <span class="hint" id="docHint"></span></div>
        <div class="table-wrap" id="docs"></div>
        <div class="totals">
          <div><span>${word}金額</span><span id="tAmt"></span></div>
          <div><span>本次沖銷</span><span id="tAlloc"></span></div>
          <div class="grand"><span>未沖金額</span><span id="tLeft"></span></div>
        </div>
        <p class="hint">可只沖一部分；未沖的金額之後可以再編輯這筆${direction}補沖。${isIn ? 'LINE Pay／刷卡撥款若已扣手續費，請登錄撥款前的全額入帳，再另記一筆「手續費」出帳。' : ''}</p>
        <div class="form-actions">
          ${id ? '<button type="button" class="danger" id="del">刪除</button>' : ''}<span class="spacer"></span>
          <button type="button" id="cancel">取消</button><button class="primary">存檔</button>
        </div>
      </form>`, true);
    const f = $('#f', box);
    const mine = new Map((t.allocations || []).map((a) => [`${a.doc_type}:${a.doc_id}`, a.amount]));
    let docs = [];

    const calc = () => {
      const amt = Number(f.amount.value) || 0;
      const alloc = $$('#docs [data-alloc]', box).reduce((s, el) => s + (Number(el.value) || 0), 0);
      $('#tAmt', box).textContent = money(amt);
      $('#tAlloc', box).textContent = money(alloc);
      const left = r2(amt - alloc);
      $('#tLeft', box).innerHTML = left < -0.005 ? `<span class="down">超過 ${money(-left)}</span>` : money(left);
    };
    const loadDocs = async () => {
      const keep = new Map($$('#docs [data-alloc]', box).map((el) => [el.dataset.key, el.value]));
      const pid = f[partyKey].value;
      const res = await api('/bank-transactions/open-docs' + qs({ direction, [partyKey]: pid, exclude_txn_id: id }));
      docs = res.data;
      $('#docHint', box).textContent = pid ? '' : `（未選${isIn ? '客戶' : '供應商'}，列出全部未${isIn ? '收清' : '付清'}單據）`;
      $('#docs', box).innerHTML = docs.length ? `<table class="items"><thead><tr><th>單據</th><th>日期</th><th>${isIn ? '客戶' : '對象'}</th><th>${isIn ? '付款方式' : '說明'}</th><th class="num">金額</th><th class="num">其他已沖</th><th class="num">未沖餘額</th><th style="width:130px">本次沖銷</th><th></th></tr></thead><tbody>
        ${docs.map((d) => {
          const key = `${d.doc_type}:${d.doc_id}`;
          const v = keep.has(key) ? keep.get(key) : (mine.get(key) ?? '');
          return `<tr><td>${esc(d.label)} ${esc(d.doc_no)}</td><td>${esc(d.doc_date)}${d.due_date && d.due_date < today() ? ' <span class="tag warn">逾期</span>' : ''}</td><td>${esc(d.party)}</td><td>${esc(d.info)}</td>
            <td class="num">${money(d.total)}</td><td class="num">${d.paid ? money(d.paid) : ''}</td><td class="num"><b>${money(d.remaining)}</b></td>
            <td><input data-alloc data-key="${key}" data-type="${d.doc_type}" data-id="${d.doc_id}" data-max="${d.remaining}" type="number" step="any" min="0" value="${esc(v)}" class="num"></td>
            <td><button type="button" class="link" data-full>全額</button></td></tr>`;
        }).join('')}</tbody></table>` : `<div class="empty">沒有未${isIn ? '收清' : '付清'}的單據</div>`;
      calc();
    };
    $('#docs', box).addEventListener('input', calc);
    $('#docs', box).addEventListener('click', (e) => {
      if (!e.target.matches('[data-full]')) return;
      const inp = $('[data-alloc]', e.target.closest('tr'));
      const others = $$('#docs [data-alloc]', box).filter((el) => el !== inp).reduce((s, el) => s + (Number(el.value) || 0), 0);
      const amt = Number(f.amount.value) || 0;
      const max = Number(inp.dataset.max);
      inp.value = amt ? Math.max(0, Math.min(max, r2(amt - others))) : max;
      if (!amt) f.amount.value = r2(others + max);
      calc();
    });
    f.amount.oninput = calc;
    // 付款：依供應商帶出匯款帳戶（預設帳戶先選好）
    let payees = [];
    const loadPayees = async (keepSel) => {
      if (isIn) return;
      const sid = f.supplier_id.value;
      payees = sid ? (await api('/supplier-accounts' + qs({ supplier_id: sid }))).data.filter((a) => a.is_active || a.sba_id === t.payee_account_id) : [];
      const sel = keepSel ?? (payees.find((a) => a.is_default) || payees[0])?.sba_id ?? '';
      f.payee_account_id.innerHTML = `<option value="">${sid ? (payees.length ? '（不指定）' : '（這家供應商還沒有匯款帳戶，可到主檔新增）') : '（先選供應商）'}</option>`
        + payees.map((a) => `<option value="${a.sba_id}" ${a.sba_id === Number(sel) ? 'selected' : ''}>${esc(a.label)}${a.is_default ? '（預設）' : ''}</option>`).join('');
      showPayee();
    };
    const showPayee = () => {
      if (isIn) return;
      const a = payees.find((x) => x.sba_id === Number(f.payee_account_id.value));
      $('#payeeInfo', box).innerHTML = a ? `匯款：<b>${esc(a.bank_code)} ${esc(a.bank_name || '')}</b>　${esc(a.branch_name || '')}　戶名 <b>${esc(a.account_holder || '—')}</b>　帳號 <b>${esc(fmtAcctNo(a.account_no))}</b>`
        : (t.payee_info ? '本筆紀錄：' + esc(t.payee_info) : '');
    };
    if (!isIn) {
      f.payee_account_id.onchange = showPayee;
      $('#copyPayee', box).onclick = () => { const a = payees.find((x) => x.sba_id === Number(f.payee_account_id.value)); if (a) copyText(a.account_no); else toast('請先選收款帳戶', true); };
    }
    f[partyKey].onchange = () => { loadDocs(); loadPayees(); };
    $('#cancel', box).onclick = closeModal;
    await Promise.all([loadDocs(), loadPayees(t.payee_account_id ?? (id ? '' : undefined))]);

    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = { ...Object.fromEntries(new FormData(f)), direction };
      body.allocations = $$('#docs [data-alloc]', box).filter((el) => Number(el.value) > 0)
        .map((el) => ({ doc_type: el.dataset.type, doc_id: el.dataset.id, amount: el.value }));
      try {
        const res = await api(id ? `/bank-transactions/${id}` : '/bank-transactions', { method: id ? 'PUT' : 'POST', body });
        closeModal();
        toast(`已存檔 ${res.data.txn_no}` + (res.data.unallocated > 0.005 && ['銷貨收款', '進貨付款', '費用'].includes(res.data.category) ? `（尚有 ${money(res.data.unallocated)} 未沖）` : ''));
        reload?.();
      } catch (err) { fail(err); }
    };
    if (id) $('#del', box).onclick = async () => {
      if (!confirm(`確定刪除 ${t.txn_no}？\n它沖銷的單據會改回未${isIn ? '收' : '付'}，無法復原。`)) return;
      try { await api(`/bank-transactions/${id}`, { method: 'DELETE' }); closeModal(); toast('已刪除'); reload?.(); } catch (err) { fail(err); }
    };
  } catch (e) { fail(e); }
}

async function transferForm(t, reload) {
  try {
    const accounts = await lookup('bank-accounts', true);
    const isOut = t?.direction === DIR_OUT;
    const fromId = t ? (isOut ? t.account_id : t.transfer_account_id) : null;
    const toId = t ? (isOut ? t.transfer_account_id : t.account_id) : null;
    const box = openModal(`
      <h2>${t ? '帳戶互轉 ' + esc(t.txn_no) : '帳戶互轉'}</h2>
      <form id="f">
        <div class="form-grid">
          <label>轉出帳戶 *<select name="account_id" required>${options(accounts, 'account_id', fromId, { blank: '請選擇', label: (a) => a.account_name })}</select></label>
          <label>轉入帳戶 *<select name="to_account_id" required>${options(accounts, 'account_id', toId, { blank: '請選擇', label: (a) => a.account_name })}</select></label>
          <label>日期 *<input name="txn_date" type="date" required value="${esc(t?.txn_date || today())}"></label>
          <label>金額 *<input name="amount" type="number" step="any" min="0" required value="${esc(t?.amount)}"></label>
          <label class="full">摘要<input name="description" value="${esc(t?.description)}" placeholder="例：現金存入銀行、LINE Pay 撥款"></label>
        </div>
        <p class="hint">會產生兩筆：轉出帳戶一筆<span class="down">出帳</span>、轉入帳戶一筆<span class="up">入帳</span>，修改或刪除時兩筆一起處理。</p>
        <div class="form-actions">
          ${t ? '<button type="button" class="danger" id="del">刪除</button>' : ''}<span class="spacer"></span>
          <button type="button" id="cancel">取消</button><button class="primary">存檔</button>
        </div>
      </form>`);
    const f = $('#f', box);
    $('#cancel', box).onclick = closeModal;
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = { ...Object.fromEntries(new FormData(f)), category: '轉帳' };
      try {
        await api(t ? `/bank-transactions/${t.txn_id}` : '/bank-transactions', { method: t ? 'PUT' : 'POST', body });
        closeModal(); toast('已存檔'); reload?.();
      } catch (err) { fail(err); }
    };
    if (t) $('#del', box).onclick = async () => {
      if (!confirm('確定刪除這筆帳戶互轉？轉出、轉入兩筆會一起刪除。')) return;
      try { await api(`/bank-transactions/${t.txn_id}`, { method: 'DELETE' }); closeModal(); toast('已刪除'); reload?.(); } catch (err) { fail(err); }
    };
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- 費用支出
async function pageExpenses() {
  const cats = await lookup('expense-categories', true);
  $('#main').innerHTML = `
    <h2>費用支出</h2>
    <div class="toolbar">
      <label>起日<input type="date" id="from" value="${monthStart()}"></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <label>類別<select id="cat">${options(cats, 'category_id', null, { blank: '全部' })}</select></label>
      <label>付款<select id="pay">${plainOpts(['未付', '部分付款', '已付清'], null, '全部')}</select></label>
      <label>搜尋<input id="q" placeholder="廠商、發票、備註"></label>
      <button id="search">查詢</button><span class="spacer"></span>
      <button id="add" class="primary">＋ 新增費用</button>
    </div>
    <p class="hint">這裡只記費用、不動帳戶。付款請到 <a href="#bank">銀行收支</a> 登錄出帳並沖銷這筆費用。「攤入烘焙」目前只做標記，成本攤提在 Phase 5。</p>
    <div class="stats" id="stats"></div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;
  const load = async () => {
    try {
      const { data, summary } = await api('/expenses' + qs({ from: $('#from').value, to: $('#to').value, category_id: $('#cat').value, payment_status: $('#pay').value, q: $('#q').value.trim() }));
      $('#stats').innerHTML = statCards([['筆數', fmt(summary.count)], ['費用合計', money(summary.amount), 'down'], ['未付款', money(summary.unpaid_amount)], ['標記攤入烘焙', money(summary.roast_amount)]]);
      $('#list').innerHTML = data.length ? `<table><thead><tr><th>日期</th><th>編號</th><th>類別</th><th>廠商</th><th>發票</th><th class="num">金額</th><th class="num">未付</th><th>付款</th><th>攤入烘焙</th><th>備註</th></tr></thead><tbody>
        ${data.map((r) => `<tr class="clickable" data-id="${r.expense_id}"><td>${esc(r.expense_date)}</td><td>${esc(r.expense_no)}</td><td>${esc(r.category_name)}</td><td>${esc(r.vendor)}</td><td>${esc(r.invoice_no)}</td>
          <td class="num down">${money(r.amount)}</td><td class="num">${r.unpaid_amount ? money(r.unpaid_amount) : ''}</td><td>${statusTag(r.payment_status)}</td><td>${r.allocate_to_roast ? '✓' : ''}</td><td>${esc(r.note)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">此區間沒有費用</div>';
      $$('#list tr.clickable').forEach((tr) => tr.onclick = () => expenseForm(Number(tr.dataset.id), load));
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  $('#q').onkeydown = (e) => e.key === 'Enter' && load();
  $('#add').onclick = () => expenseForm(null, load);
  load();
}

async function expenseForm(id, reload) {
  try {
    const cats = await lookup('expense-categories', true);
    const e0 = id ? (await api(`/expenses/${id}`)).data : { expense_date: today() };
    const box = openModal(`
      <h2>${id ? '費用 ' + esc(e0.expense_no) : '新增費用'}</h2>
      ${e0.overpaid ? `<div class="notice">已付 ${money(e0.paid_amount)}，比費用金額多 ${money(e0.overpaid)}（溢付），請確認金額或到銀行收支調整沖帳。</div>` : ''}
      <form id="f">
        <div class="form-grid">
          <label>費用日期 *<input name="expense_date" type="date" required value="${esc(e0.expense_date)}"></label>
          <label>編號<input name="expense_no" value="${esc(e0.expense_no)}" placeholder="自動產生"></label>
          <label>類別 *<select name="category_id" required>${options(cats, 'category_id', e0.category_id, { blank: '請選擇' })}</select></label>
          <label>金額 *<input name="amount" type="number" step="any" min="0" required value="${esc(e0.amount)}"></label>
          <label>廠商<input name="vendor" value="${esc(e0.vendor)}"></label>
          <label>發票號碼<input name="invoice_no" value="${esc(e0.invoice_no)}"></label>
          <label>應付日期<input name="due_date" type="date" value="${esc(e0.due_date)}"></label>
          <label>攤入烘焙成本<select name="allocate_to_roast"><option value="0" ${e0.allocate_to_roast ? '' : 'selected'}>否</option><option value="1" ${e0.allocate_to_roast ? 'selected' : ''}>是</option></select></label>
          <label>付款狀態<input value="${esc(e0.payment_status || '未付')}" disabled></label>
          <label class="full">備註<input name="note" value="${esc(e0.note)}"></label>
        </div>
        ${id ? paymentsBlock(e0, '付款') : '<p class="hint">存檔後到 <a href="#bank">銀行收支</a> 登錄出帳並沖銷這筆費用。</p>'}
        <div class="form-actions">
          ${id ? '<button type="button" class="danger" id="del">刪除</button>' : ''}<span class="spacer"></span>
          ${id && e0.payment_status !== '已付清' ? '<button type="button" id="docPay">登錄付款</button>' : ''}
          <button type="button" id="cancel">取消</button><button class="primary">存檔</button>
        </div>
      </form>`);
    const f = $('#f', box);
    if (!id) f.category_id.onchange = () => { // 帶入類別預設的「攤入烘焙」
      const c = cats.find((x) => x.category_id === Number(f.category_id.value));
      if (c) f.allocate_to_roast.value = c.allocate_to_roast ? '1' : '0';
    };
    $('#cancel', box).onclick = closeModal;
    if ($('#docPay', box)) $('#docPay', box).onclick = () => txnForm(DIR_OUT, null, reload, { category: '費用', counterparty: e0.vendor, amount: r2(e0.amount - e0.paid_amount), description: `${e0.expense_no} ${e0.category_name}`, allocations: [{ doc_type: 'expenses', doc_id: id, amount: r2(e0.amount - e0.paid_amount) }] });
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const res = await api(id ? `/expenses/${id}` : '/expenses', { method: id ? 'PUT' : 'POST', body: Object.fromEntries(new FormData(f)) });
        delete cache['expense-categories'];
        closeModal(); toast(`已存檔 ${res.data.expense_no}`); reload();
      } catch (err) { fail(err); }
    };
    if (id) $('#del', box).onclick = async () => {
      if (!confirm(`確定刪除費用 ${e0.expense_no}？無法復原。`)) return;
      try { await api(`/expenses/${id}`, { method: 'DELETE' }); closeModal(); toast('已刪除'); reload(); } catch (err) { fail(err); }
    };
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- 應收／應付帳款
const BUCKET_LABELS = [['0-30', '0–30 天'], ['31-60', '31–60 天'], ['61-90', '61–90 天'], ['90+', '90 天以上']];
function agingTable(data, total, onDoc, { creditCol = false } = {}) {
  if (!data.length) return '<div class="empty">沒有未結清的單據</div>';
  return `<table><thead><tr><th>對象／單據</th><th>單據日</th><th>應${creditCol ? '收' : '付'}日</th>${BUCKET_LABELS.map(([, l]) => `<th class="num">${l}</th>`).join('')}<th class="num">未結合計</th>${creditCol ? '<th>信用額度</th>' : ''}</tr></thead><tbody>
    ${data.map((p, i) => `
      <tr class="clickable bean" data-p="${i}"><td>▸ <b>${esc(p.party)}</b>（${p.count} 張）</td><td></td><td></td>
        ${BUCKET_LABELS.map(([k]) => `<td class="num">${p[k] ? money(p[k]) : ''}</td>`).join('')}<td class="num"><b>${money(p.total)}</b></td>
        ${creditCol ? `<td>${p.credit_limit ? (p.over_limit ? `<span class="tag warn">超過額度 ${money(p.credit_limit)}</span>` : money(p.credit_limit)) : ''}</td>` : ''}</tr>
      ${p.docs.map((d) => `<tr class="sub clickable" data-parent="${i}" data-type="${d.doc_type}" data-id="${d.doc_id}" hidden>
        <td>${esc(d.kind || '銷貨')} ${esc(d.doc_no)}${d.paid ? `（已沖 ${money(d.paid)}）` : ''}</td><td>${esc(d.doc_date)}</td><td>${esc(d.due_date)}${d.overdue ? ' <span class="tag warn">逾期</span>' : ''}</td>
        ${BUCKET_LABELS.map(([k]) => `<td class="num">${d.bucket === k ? money(d.remaining) : ''}</td>`).join('')}<td class="num">${money(d.remaining)}</td>${creditCol ? '<td></td>' : ''}</tr>`).join('')}`).join('')}
    <tr class="total"><td>合計</td><td></td><td></td>${BUCKET_LABELS.map(([k]) => `<td class="num">${money(total[k])}</td>`).join('')}<td class="num">${money(total.total)}</td>${creditCol ? '<td></td>' : ''}</tr>
    </tbody></table>`;
}
function bindAging(onDoc) {
  $$('#list tr.bean').forEach((tr) => tr.onclick = () => {
    const subs = $$(`#list tr[data-parent="${tr.dataset.p}"]`);
    const open = subs[0]?.hidden;
    subs.forEach((s) => (s.hidden = !open));
    tr.cells[0].firstChild.textContent = open ? '▾ ' : '▸ ';
  });
  $$('#list tr.sub').forEach((tr) => tr.onclick = () => onDoc(tr.dataset.type, Number(tr.dataset.id)));
  if ($$('#list tr.bean').length === 1) $('#list tr.bean').click();
}

async function pageReceivables() {
  const customers = await lookup('customers', true);
  $('#main').innerHTML = `
    <h2>應收帳款</h2>
    <div class="toolbar">
      <label>截止日<input type="date" id="asof" value="${today()}"></label>
      <label>客戶<select id="cust"><option value="">全部</option><option value="none">散客</option>${options(customers, 'customer_id', null, { blank: null })}</select></label>
      <button id="search">查詢</button><span class="spacer"></span><button id="recv" class="primary">＋ 登錄收款</button>
    </div>
    <p class="hint">截止日當天（含）之前的銷貨單，扣掉截止日之前的收款沖帳後還沒收清的部分。帳齡從銷貨日起算。點客戶展開單據，點單據開啟銷貨單。</p>
    <div class="stats" id="stats"></div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;
  const load = async () => {
    try {
      const { data, total } = await api('/finance/receivables' + qs({ as_of: $('#asof').value, customer_id: $('#cust').value }));
      $('#stats').innerHTML = statCards([['應收合計', money(total.total), 'up'], ...BUCKET_LABELS.map(([k, l]) => [l, money(total[k]), k === '90+' && total[k] ? 'down' : ''])]);
      $('#list').innerHTML = agingTable(data, total, null, { creditCol: true });
      bindAging((type, id) => saleForm(id, load));
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  $('#cust').onchange = load;
  $('#recv').onclick = () => txnForm(DIR_IN, null, load, { customer_id: Number($('#cust').value) || null });
  load();
}

async function pagePayables() {
  const suppliers = await lookup('suppliers', true);
  $('#main').innerHTML = `
    <h2>應付帳款</h2>
    <div class="toolbar">
      <label>截止日<input type="date" id="asof" value="${today()}"></label>
      <label>類型<select id="type"><option value="">進貨＋費用</option><option value="purchases">只看進貨單</option><option value="expenses">只看費用</option></select></label>
      <label>供應商<select id="sup">${options(suppliers, 'supplier_id', null, { blank: '全部' })}</select></label>
      <button id="search">查詢</button><span class="spacer"></span><button id="pay" class="primary">＋ 登錄付款</button>
    </div>
    <p class="hint">截止日當天（含）之前的進貨單與費用，扣掉截止日之前的付款沖帳後還沒付清的部分（選供應商時只看進貨單）。點對象展開單據，點單據開啟原單。</p>
    <div class="stats" id="stats"></div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;
  const load = async () => {
    try {
      const { data, total } = await api('/finance/payables' + qs({ as_of: $('#asof').value, type: $('#type').value, supplier_id: $('#sup').value }));
      $('#stats').innerHTML = statCards([['應付合計', money(total.total), 'down'], ...BUCKET_LABELS.map(([k, l]) => [l, money(total[k])])]);
      $('#list').innerHTML = agingTable(data, total);
      bindAging((type, id) => (type === 'purchases' ? purchaseForm(id, load) : expenseForm(id, load)));
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  $('#sup').onchange = load;
  $('#type').onchange = load;
  $('#pay').onclick = () => txnForm(DIR_OUT, null, load, { supplier_id: Number($('#sup').value) || null });
  load();
}

// ---------------------------------------------------------------- 費用分析
async function pageExpenseSummary() {
  $('#main').innerHTML = `
    <h2>費用分析</h2>
    <div class="toolbar">
      <label>起日<input type="date" id="from" value="${today().slice(0, 4)}-01-01"></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <button id="search">查詢</button>
    </div>
    <div class="stats" id="stats"></div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;
  const load = async () => {
    try {
      const { data, months, total, month_totals: mt, roast_amount } = await api('/finance/expense-summary' + qs({ from: $('#from').value, to: $('#to').value }));
      $('#stats').innerHTML = statCards([['費用合計', money(total), 'down'], ['標記攤入烘焙', money(roast_amount)], ['類別數', fmt(data.length)]]);
      $('#list').innerHTML = data.length ? `<table><thead><tr><th>類別</th><th class="num">筆數</th><th class="num">合計</th><th class="num">佔比</th><th style="min-width:120px"></th>${months.map((m) => `<th class="num">${m}</th>`).join('')}</tr></thead><tbody>
        ${data.map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${c.count}</td><td class="num"><b>${money(c.amount)}</b></td><td class="num">${pct(c.share)}</td>
          <td><div class="bar"><span style="width:${(c.share * 100).toFixed(1)}%"></span></div></td>${months.map((m) => `<td class="num">${c.months[m] ? money(c.months[m]) : ''}</td>`).join('')}</tr>`).join('')}
        <tr class="total"><td>合計</td><td></td><td class="num">${money(total)}</td><td class="num">100%</td><td></td>${months.map((m) => `<td class="num">${money(mt[m])}</td>`).join('')}</tr>
        </tbody></table>` : '<div class="empty">此區間沒有費用</div>';
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  load();
}

// ---------------------------------------------------------------- Phase 4 共用
const RET_TYPES = ['銷貨退回', '銷貨折讓', '進貨退出'];
const daysAgo = (n) => new Date(Date.now() + 8 * 3600e3 - n * 86400e3).toISOString().slice(0, 10);
const shortageLines = (list) => list.map((x) => (x.type === '包材'
  ? `・${x.product_name}：包材「${x.packaging_name}」需要 ${fmt(x.need_qty)} ${x.unit || ''}，不足 ${fmt(x.short_qty)}（包材庫存會變負數）`
  : `・${x.product_name}：熟豆需要 ${kg(x.need_kg)} kg，不足 ${kg(x.short_kg)} kg` + (x.batch_no ? `（會記在批次 ${x.batch_no}，該批庫存變負數）` : '（還沒有任何烘焙批次，這筆不會扣庫存）')));
/** 原單上的退貨／折讓清單 */
const returnsBlock = (d) => (d.returns?.length
  ? `<div class="section-title">退貨／折讓</div><div class="table-wrap"><table><thead><tr><th>日期</th><th>單號</th><th>類型</th><th>原因</th><th class="num">金額</th></tr></thead><tbody>
      ${d.returns.map((r) => `<tr class="clickable" data-return="${r.return_id}"><td>${esc(r.return_date)}</td><td>${esc(r.return_no)}</td><td>${esc(r.return_type)}${r.return_type === '銷貨退回' && !r.restock ? '（不回補）' : ''}</td><td>${esc(r.reason)}</td><td class="num down">−${money(r.total_amount)}</td></tr>`).join('')}
      </tbody></table></div>` : '');
const bindReturnRows = (box, reload) => $$('[data-return]', box).forEach((tr) => tr.onclick = () => returnForm(null, null, Number(tr.dataset.return), reload));

// ---------------------------------------------------------------- 退貨／折讓
async function pageReturns() {
  $('#main').innerHTML = `
    <h2>退貨／折讓</h2>
    <div class="toolbar">
      <label>起日<input type="date" id="from" value="${monthStart()}"></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <label>類型<select id="type">${plainOpts(RET_TYPES, null, '全部')}</select></label>
      <button id="search">查詢</button><span class="spacer"></span>
      <button id="add" class="primary">＋ 新增退貨／折讓</button>
    </div>
    <p class="hint">退貨單掛在原銷貨單／進貨單上，原單應收（付）會扣掉退貨金額。客戶已付清的部分會變成「應退客戶」，請到銀行收支登錄出帳退款並沖銷原銷貨單；供應商已付清的部分則登錄入帳沖銷原進貨單。也可以直接在銷貨單、進貨單上按「退貨／折讓」。</p>
    <div class="stats" id="stats"></div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;
  const load = async () => {
    try {
      const { data, summary } = await api('/returns' + qs({ from: $('#from').value, to: $('#to').value, return_type: $('#type').value }));
      $('#stats').innerHTML = statCards([['筆數', fmt(summary.count)], ['銷貨退回', money(summary.sales_return), 'down'], ['銷貨折讓', money(summary.allowance), 'down'], ['進貨退出', money(summary.purchase_return)]]);
      $('#list').innerHTML = data.length ? `<table><thead><tr><th>日期</th><th>單號</th><th>類型</th><th>原單</th><th>客戶／供應商</th><th>品項</th><th>原因</th><th class="num">金額</th><th>庫存</th></tr></thead><tbody>
        ${data.map((r) => `<tr class="clickable" data-id="${r.return_id}"><td>${esc(r.return_date)}</td><td>${esc(r.return_no)}</td><td>${esc(r.return_type)}</td><td>${esc(r.sale_no || r.purchase_no)}</td>
          <td>${esc(r.customer_name || r.supplier_name)}</td><td>${esc(r.items_text)}</td><td>${esc(r.reason)}</td><td class="num">${money(r.total_amount)}</td>
          <td>${r.return_type === '銷貨退回' ? (r.restock ? '<span class="up">回補</span>' : '不回補') : r.return_type === '進貨退出' ? '<span class="down">扣庫存</span>' : ''}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">此區間沒有退貨／折讓</div>';
      $$('#list tr.clickable').forEach((tr) => tr.onclick = () => returnForm(null, null, Number(tr.dataset.id), load));
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  $('#add').onclick = () => returnPicker(load);
  load();
}

/** 新增退貨時先選類型與原單 */
async function returnPicker(reload) {
  try {
    const [sales, purchases] = await Promise.all([api('/sales' + qs({ from: daysAgo(365) })), api('/purchases' + qs({ from: daysAgo(365) }))]);
    const saleOpts = sales.data.map((s) => `<option value="${s.sale_id}">${esc(s.sale_no)}｜${esc(s.sale_date)}｜${esc(s.customer_name || '散客')}｜${money(s.total_amount)}</option>`).join('');
    const purOpts = purchases.data.map((p) => `<option value="${p.purchase_id}">${esc(p.purchase_no)}｜${esc(p.purchase_date)}｜${esc(p.supplier_name)}｜${money(p.total_amount)}</option>`).join('');
    const box = openModal(`
      <h2>新增退貨／折讓</h2>
      <form id="f"><div class="form-grid">
        <label>類型<select name="type">${plainOpts(RET_TYPES, '銷貨退回')}</select></label>
        <label class="full" id="docLabel">原銷貨單（近一年）<select name="doc" required><option value="">請選擇</option>${saleOpts}</select></label>
      </div>
      <div class="form-actions"><span class="spacer"></span><button type="button" id="cancel">取消</button><button class="primary">下一步</button></div></form>`);
    const f = $('#f', box);
    f.type.onchange = () => {
      const isP = f.type.value === '進貨退出';
      $('#docLabel', box).firstChild.textContent = isP ? '原進貨單（近一年）' : '原銷貨單（近一年）';
      f.doc.innerHTML = '<option value="">請選擇</option>' + (isP ? purOpts : saleOpts);
    };
    $('#cancel', box).onclick = closeModal;
    f.onsubmit = (e) => {
      e.preventDefault();
      const isP = f.type.value === '進貨退出';
      returnForm(f.type.value, isP ? { purchase_id: Number(f.doc.value) } : { sale_id: Number(f.doc.value) }, null, reload);
    };
  } catch (e) { fail(e); }
}

async function returnForm(type, src, id, reload) {
  try {
    const r = id ? (await api(`/returns/${id}`)).data : { return_type: type, return_date: today(), restock: 1, ...src, items: [] };
    type = r.return_type;
    const isP = type === '進貨退出';
    const isAllow = type === '銷貨折讓';
    const srcRes = await api('/returns/source' + qs(isP ? { purchase_id: r.purchase_id, exclude_return_id: id } : { sale_id: r.sale_id, exclude_return_id: id }));
    const lines = srcRes.data;
    const bal = srcRes.balance;
    const mine = new Map((r.items || []).map((it) => [isP ? it.purchase_item_id : it.sale_item_id, it]));
    const room = r2(bal.net + (id ? r.total_amount : 0));
    const lineRows = lines.map((l) => {
      const key = isP ? l.purchase_item_id : l.sale_item_id;
      const m = mine.get(key);
      return `<tr data-key="${key}"><td>${esc(l.name)}${l.lot_no ? `（${esc(l.lot_no)}）` : ''}${l.grind_size ? `／${esc(l.grind_size)}` : ''}</td>
        <td class="num">${fmt(l.qty, isP ? 2 : 0)}</td><td class="num">${l.returned ? fmt(l.returned, isP ? 2 : 0) : ''}</td>${isP ? `<td class="num">${fmt(l.stock, 2)}</td>` : ''}
        <td class="num">${fmt(l.returnable, isP ? 2 : 0)}</td>
        <td><input data-qty type="number" step="${isP ? 'any' : '1'}" min="0" max="${l.returnable}" value="${esc(m?.qty)}" class="num"></td>
        <td><input data-price type="number" step="any" min="0" value="${esc(m ? m.unit_price : l.unit_price)}" class="num"></td>
        <td class="num" data-amt></td></tr>`;
    }).join('');
    const box = openModal(`
      <h2>${id ? `${esc(type)} ${esc(r.return_no)}` : `新增${esc(type)}`}</h2>
      <p class="hint">原單：${esc(isP ? (r.purchase_no || bal.no) : (r.sale_no || bal.no))}${r.customer_name ? `｜${esc(r.customer_name)}` : ''}${r.supplier_name ? `｜${esc(r.supplier_name)}` : ''}　
        原單合計 ${money(bal.total)}、其他退貨 ${money(bal.returned - (id ? r.total_amount : 0))}、已${isP ? '付' : '收'} ${money(bal.paid)}；本單最多 ${money(room)}</p>
      <form id="f">
        <div class="form-grid">
          <label>日期 *<input name="return_date" type="date" required value="${esc(r.return_date)}"></label>
          <label>單號<input name="return_no" value="${esc(r.return_no)}" placeholder="自動產生"></label>
          ${type === '銷貨退回' ? `<label>熟豆回補庫存<select name="restock"><option value="1" ${r.restock ? 'selected' : ''}>回補（依原出貨批次加回）</option><option value="0" ${r.restock ? '' : 'selected'}>不回補（已開封／報廢）</option></select></label>` : ''}
          ${isAllow ? `<label>折讓金額 *<input name="total_amount" type="number" step="any" min="0" required value="${esc(r.total_amount)}"></label>` : ''}
          <label class="full">原因<input name="reason" value="${esc(r.reason)}" placeholder="例：包裝破損、口味不符、延遲到貨"></label>
          <label class="full">備註<input name="note" value="${esc(r.note)}"></label>
        </div>
        ${isAllow ? '<p class="hint">折讓只調整金額，不動庫存。</p>' : `
        <div class="section-title">${isP ? '退出' : '退回'}品項</div>
        <div class="table-wrap"><table class="items"><thead><tr><th>品項</th><th class="num">原數量</th><th class="num">已退</th>${isP ? '<th class="num">目前庫存</th>' : ''}<th class="num">可退</th><th style="width:100px">本次${isP ? '退出' : '退回'}</th><th style="width:110px">單價</th><th class="num">金額</th></tr></thead>
          <tbody id="lines">${lineRows}</tbody></table></div>
        <p class="hint">${isP ? '退出的生豆／包材會以入庫成本扣庫存（異動類型：退貨）。單價預設為原進貨單價（不含運費攤提），可修改成供應商實際退款單價。' : '單價預設為原售價，可修改（例如原單有整單折扣）。包材不回補。'}</p>
        <div class="totals"><div class="grand"><span>退貨金額</span><span id="tAmt"></span></div></div>`}
        <div class="form-actions">
          ${id ? '<button type="button" class="danger" id="del">刪除</button>' : ''}<span class="spacer"></span>
          <button type="button" id="cancel">取消</button><button class="primary">存檔</button>
        </div>
      </form>`, true);
    const f = $('#f', box);
    const calc = () => {
      let sum = 0;
      $$('#lines tr', box).forEach((tr) => {
        const a = r2((Number($('[data-qty]', tr).value) || 0) * (Number($('[data-price]', tr).value) || 0));
        sum += a;
        $('[data-amt]', tr).textContent = a ? money(a) : '';
      });
      if ($('#tAmt', box)) $('#tAmt', box).innerHTML = sum > room + 0.005 ? `<span class="down">${money(sum)}（超過 ${money(room)}）</span>` : money(sum);
    };
    if (!isAllow) { $('#lines', box).addEventListener('input', calc); calc(); }
    $('#cancel', box).onclick = closeModal;
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = { ...Object.fromEntries(new FormData(f)), return_type: type, sale_id: r.sale_id, purchase_id: r.purchase_id };
      if (body.restock !== undefined) body.restock = body.restock === '1';
      if (!isAllow) {
        body.items = $$('#lines tr', box).filter((tr) => Number($('[data-qty]', tr).value) > 0)
          .map((tr) => ({ [isP ? 'purchase_item_id' : 'sale_item_id']: Number(tr.dataset.key), qty: $('[data-qty]', tr).value, unit_price: $('[data-price]', tr).value }));
      }
      try {
        const res = await api(id ? `/returns/${id}` : '/returns', { method: id ? 'PUT' : 'POST', body });
        closeModal();
        toast(`已存檔 ${res.data.return_no}（${money(res.data.total_amount)}）`);
        reload?.();
      } catch (err) { fail(err); }
    };
    if (id) $('#del', box).onclick = async () => {
      if (!confirm(`確定刪除 ${r.return_no}？${type === '銷貨退回' && r.restock ? '\n回補的熟豆會再扣回。' : ''}${isP ? '\n退出的庫存會加回。' : ''}\n原單應收（付）會恢復，無法復原。`)) return;
      try { await api(`/returns/${id}`, { method: 'DELETE' }); closeModal(); toast('已刪除'); reload?.(); } catch (err) { fail(err); }
    };
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- 發票
const INV_TYPES = ['二聯', '三聯', '電子發票'];
const invTag = (s) => `<span class="tag ${s === '開立' ? '' : 'warn'}">${esc(s)}</span>`;

async function pageInvoices() {
  $('#main').innerHTML = `
    <h2>發票</h2>
    <div class="toolbar">
      <label>起日<input type="date" id="from" value="${monthStart()}"></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <label>類型<select id="type">${plainOpts(INV_TYPES, null, '全部')}</select></label>
      <label>狀態<select id="status">${plainOpts(['開立', '作廢', '折讓'], null, '全部')}</select></label>
      <label>搜尋<input id="q" placeholder="發票號碼、統編、單號"></label>
      <button id="search">查詢</button>
    </div>
    <p class="hint">這裡只登錄發票資料（實際開立仍在你原本的發票平台）。金額為含稅，系統依 5% 拆出未稅與稅額，並依營業稅期別（每兩個月）彙總，作廢的發票不計入。</p>
    <div class="stats" id="stats"></div>
    <div class="section-title">期別彙總</div>
    <div class="card"><div class="table-wrap" id="periods"></div></div>
    <div class="section-title">發票明細</div>
    <div class="card"><div class="table-wrap" id="list"></div></div>
    <div class="section-title">尚未開發票的銷貨單（同一區間）</div>
    <div class="card"><div class="table-wrap" id="todo"></div></div>`;
  const load = async () => {
    try {
      const range = { from: $('#from').value, to: $('#to').value };
      const [{ data, summary, periods }, todo] = await Promise.all([
        api('/invoices' + qs({ ...range, invoice_type: $('#type').value, status: $('#status').value, q: $('#q').value.trim() })),
        api('/invoices/uninvoiced' + qs(range)),
      ]);
      $('#stats').innerHTML = statCards([['有效張數', fmt(summary.count)], ['含稅金額', money(summary.amount)], ['未稅銷售額', money(summary.sales_amount)], ['稅額', money(summary.tax_amount)], ['作廢張數', fmt(summary.void_count)], ['未開發票', `${todo.data.length} 張／${money(todo.total)}`]]);
      $('#periods').innerHTML = periods.length ? `<table><thead><tr><th>期別</th><th class="num">張數</th><th class="num">含稅金額</th><th class="num">未稅銷售額</th><th class="num">稅額</th></tr></thead><tbody>
        ${periods.map((p) => `<tr><td>${esc(p.period)}</td><td class="num">${p.count}</td><td class="num">${money(p.amount)}</td><td class="num">${money(p.sales_amount)}</td><td class="num">${money(p.tax_amount)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">沒有資料</div>';
      $('#list').innerHTML = data.length ? `<table><thead><tr><th>日期</th><th>發票號碼</th><th>類型</th><th>銷貨單</th><th>客戶</th><th>買方統編</th><th>載具</th><th class="num">含稅</th><th class="num">未稅</th><th class="num">稅額</th><th>狀態</th></tr></thead><tbody>
        ${data.map((r) => `<tr class="clickable" data-id="${r.invoice_id}" data-sale="${r.sale_id}"><td>${esc(r.invoice_date)}</td><td>${esc(r.invoice_no)}</td><td>${esc(r.invoice_type)}</td><td>${esc(r.sale_no)}</td><td>${esc(r.buyer_name || r.customer_name)}</td>
          <td>${esc(r.buyer_tax_id)}</td><td>${esc(r.carrier)}</td><td class="num">${money(r.amount)}</td><td class="num">${money(r.sales_amount)}</td><td class="num">${money(r.tax_amount)}</td><td>${invTag(r.status)}${r.void_reason ? `（${esc(r.void_reason)}）` : ''}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">此區間沒有發票</div>';
      $('#todo').innerHTML = todo.data.length ? `<table><thead><tr><th>銷貨日</th><th>單號</th><th>客戶</th><th>統編</th><th>通路</th><th class="num">合計</th><th></th></tr></thead><tbody>
        ${todo.data.map((s) => `<tr><td>${esc(s.sale_date)}</td><td>${esc(s.sale_no)}</td><td>${esc(s.customer_name)}</td><td>${esc(s.tax_id)}</td><td>${esc(s.channel)}</td><td class="num">${money(s.total_amount)}</td>
          <td><button type="button" class="link" data-new="${s.sale_id}">登錄發票</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">都開好了</div>';
      $$('#list tr.clickable').forEach((tr) => tr.onclick = () => invoiceForm(Number(tr.dataset.sale), Number(tr.dataset.id), load));
      $$('#todo [data-new]').forEach((b) => b.onclick = () => invoiceForm(Number(b.dataset.new), null, load));
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  $('#q').onkeydown = (e) => e.key === 'Enter' && load();
  load();
}

async function invoiceForm(saleId, id, reload) {
  try {
    const sale = (await api(`/sales/${saleId}`)).data;
    const cust = sale.customer_id ? (await api(`/customers/${sale.customer_id}`)).data : null;
    const inv = id ? (await api(`/invoices/${id}`)).data
      : { invoice_date: today(), invoice_type: cust?.tax_id ? '三聯' : '電子發票', buyer_tax_id: cust?.tax_id || '', buyer_name: cust?.tax_id ? cust.name : '', amount: sale.net_amount };
    const voided = inv.status === '作廢';
    const dis = voided ? 'disabled' : '';
    const box = openModal(`
      <h2>${id ? `發票 ${esc(inv.invoice_no)}` : '登錄發票'}</h2>
      <p class="hint">銷貨單 ${esc(sale.sale_no)}｜${esc(sale.sale_date)}｜${esc(sale.customer_name || '散客')}｜合計 ${money(sale.total_amount)}${sale.returned_amount ? `（扣退貨折讓後 ${money(sale.net_amount)}）` : ''}</p>
      ${voided ? `<div class="notice">此發票已於 ${esc(inv.void_date)} 作廢${inv.void_reason ? `：${esc(inv.void_reason)}` : ''}。</div>` : ''}
      <form id="f">
        <div class="form-grid">
          <label>發票號碼 *<input name="invoice_no" required value="${esc(inv.invoice_no)}" placeholder="AB12345678" ${dis}></label>
          <label>發票日期 *<input name="invoice_date" type="date" required value="${esc(inv.invoice_date)}" ${dis}></label>
          <label>類型<select name="invoice_type" ${dis}>${plainOpts(INV_TYPES, inv.invoice_type)}</select></label>
          <label>含稅金額<input name="amount" type="number" step="any" min="0" value="${esc(inv.amount)}" ${dis}></label>
          <label>買方統編<input name="buyer_tax_id" value="${esc(inv.buyer_tax_id)}" maxlength="8" ${dis}></label>
          <label>買方名稱<input name="buyer_name" value="${esc(inv.buyer_name)}" ${dis}></label>
          <label>載具<input name="carrier" value="${esc(inv.carrier)}" placeholder="手機條碼 /ABC1234" ${dis}></label>
          <label>未稅／稅額<input id="split" disabled></label>
          <label class="full">備註<input name="note" value="${esc(inv.note)}" ${dis}></label>
        </div>
        <div class="form-actions">
          ${id ? '<button type="button" class="danger" id="del">刪除</button>' : ''}${id && !voided ? '<button type="button" id="void">作廢</button>' : ''}<span class="spacer"></span>
          <button type="button" id="cancel">${voided ? '關閉' : '取消'}</button>${voided ? '' : '<button class="primary">存檔</button>'}
        </div>
      </form>`);
    const f = $('#f', box);
    const split = () => { const a = Number(f.amount.value) || 0; const s = Math.round(a / 1.05); $('#split', box).value = `${money(s)}／${money(a - s)}`; };
    f.amount.oninput = split; split();
    $('#cancel', box).onclick = closeModal;
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const res = await api(id ? `/invoices/${id}` : '/invoices', { method: id ? 'PUT' : 'POST', body: { ...Object.fromEntries(new FormData(f)), sale_id: saleId } });
        closeModal(); toast(`已存檔發票 ${res.data.invoice_no}`); reload?.();
      } catch (err) { fail(err); }
    };
    if ($('#void', box)) $('#void', box).onclick = async () => {
      const reason = prompt(`作廢發票 ${inv.invoice_no}，請輸入作廢原因：`, '');
      if (reason === null) return;
      try { await api(`/invoices/${id}/void`, { method: 'POST', body: { void_date: today(), void_reason: reason } }); closeModal(); toast('已作廢'); reload?.(); } catch (err) { fail(err); }
    };
    if (id) $('#del', box).onclick = async () => {
      if (!confirm(`確定刪除發票 ${inv.invoice_no} 的登錄資料？\n（登錄錯誤才刪除；實際作廢請按「作廢」。）`)) return;
      try { await api(`/invoices/${id}`, { method: 'DELETE' }); closeModal(); toast('已刪除'); reload?.(); } catch (err) { fail(err); }
    };
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- 訂閱
const FREQS = ['每週', '雙週', '每月'];
const SUB_STATUS = ['進行中', '暫停', '取消'];

async function pageSubscriptions() {
  $('#main').innerHTML = `
    <h2>訂閱</h2>
    <div class="section-title">待出貨</div>
    <div class="toolbar">
      <label>出貨日<input type="date" id="shipDate" value="${today()}"></label>
      <button id="loadDue">重新整理</button><span class="spacer"></span>
      <button id="gen" class="primary">產生勾選的銷貨單</button>
    </div>
    <p class="hint">列出「下次出貨日」在出貨日當天或之前、進行中的訂閱。勾選後一次產生銷貨單（銷貨日 = 出貨日，會扣熟豆與包材），並把下次出貨日往後推一期。沒按就不會出貨。</p>
    <div class="card"><div class="table-wrap" id="due"></div></div>
    <div class="section-title">全部訂閱</div>
    <div class="toolbar">
      <label>狀態<select id="status">${plainOpts(SUB_STATUS, null, '全部')}</select></label>
      <span class="spacer"></span><button id="add" class="primary">＋ 新增訂閱</button>
    </div>
    <div class="stats" id="stats"></div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;
  const loadDue = async () => {
    try {
      const { data, total } = await api('/subscriptions/due' + qs({ date: $('#shipDate').value }));
      $('#due').innerHTML = data.length ? `<table><thead><tr><th style="width:36px"><input type="checkbox" id="all" checked></th><th>應出貨日</th><th>客戶</th><th>產品</th><th>研磨</th><th class="num">數量</th><th class="num">金額</th><th>頻率</th><th>出貨後下次</th></tr></thead><tbody>
        ${data.map((s) => `<tr><td><input type="checkbox" data-sub="${s.subscription_id}" checked></td><td>${esc(s.next_ship_date)}${s.next_ship_date < $('#shipDate').value ? ' <span class="tag warn">已過期</span>' : ''}</td><td>${esc(s.customer_name)}</td><td>${esc(s.product_name)}</td><td>${esc(s.grind_size)}</td>
          <td class="num">${s.qty}</td><td class="num">${money(s.amount)}</td><td>${esc(s.frequency)}</td><td>${esc(s.after)}</td></tr>`).join('')}
        <tr class="total"><td></td><td>合計</td><td colspan="4"></td><td class="num">${money(total)}</td><td colspan="2"></td></tr></tbody></table>` : '<div class="empty">沒有待出貨的訂閱</div>';
      if ($('#all')) $('#all').onchange = (e) => $$('#due [data-sub]').forEach((c) => (c.checked = e.target.checked));
    } catch (e) { fail(e); }
  };
  const load = async () => {
    try {
      const { data, summary } = await api('/subscriptions' + qs({ status: $('#status').value }));
      $('#stats').innerHTML = statCards([['訂閱數', fmt(summary.count)], ['進行中', fmt(summary.active)], ['每月約當營收', money(summary.monthly), 'up']]);
      $('#list').innerHTML = data.length ? `<table><thead><tr><th>客戶</th><th>產品</th><th class="num">每期數量</th><th class="num">每期金額</th><th>頻率</th><th>下次出貨</th><th>開始</th><th>結束</th><th class="num">已出貨</th><th>狀態</th></tr></thead><tbody>
        ${data.map((s) => `<tr class="clickable" data-id="${s.subscription_id}"><td>${esc(s.customer_name)}</td><td>${esc(s.product_name)}</td><td class="num">${s.qty}</td><td class="num">${money(s.amount)}</td><td>${esc(s.frequency)}</td>
          <td>${esc(s.next_ship_date)}</td><td>${esc(s.start_date)}</td><td>${esc(s.end_date)}</td><td class="num">${s.shipped_count}</td><td><span class="tag ${s.status === '進行中' ? '' : 'warn'}">${esc(s.status)}</span></td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">還沒有訂閱</div>';
      $$('#list tr.clickable').forEach((tr) => tr.onclick = () => subForm(Number(tr.dataset.id), () => { load(); loadDue(); }));
    } catch (e) { fail(e); }
  };
  const generate = async (ids, allow = false) => {
    const { data } = await api('/subscriptions/generate', { method: 'POST', body: { date: $('#shipDate').value, ids, allow_shortage: allow } });
    const ok = data.filter((r) => r.ok);
    const short = data.filter((r) => r.shortage);
    const bad = data.filter((r) => !r.ok && !r.shortage);
    if (short.length && confirm(`以下訂閱庫存不足：\n\n${short.map((r) => shortageLines(r.shortages).join('\n')).join('\n')}\n\n仍要產生這 ${short.length} 張銷貨單嗎？`)) {
      ok.push(...(await generate(short.map((r) => r.subscription_id), true)).ok);
    }
    return { ok, bad };
  };
  $('#gen').onclick = async () => {
    const ids = $$('#due [data-sub]:checked').map((c) => Number(c.dataset.sub));
    if (!ids.length) return toast('請先勾選要出貨的訂閱', true);
    try {
      const { ok, bad } = await generate(ids);
      toast(`已產生 ${ok.length} 張銷貨單${ok.length ? '：' + ok.map((r) => r.sale_no).join('、') : ''}${bad.length ? `；${bad.length} 筆失敗（${bad.map((r) => r.error).join('、')}）` : ''}`, bad.length > 0);
      loadDue(); load();
    } catch (e) { fail(e); }
  };
  $('#loadDue').onclick = loadDue;
  $('#shipDate').onchange = loadDue;
  $('#status').onchange = load;
  $('#add').onclick = () => subForm(null, () => { load(); loadDue(); });
  loadDue(); load();
}

async function subForm(id, reload) {
  try {
    const [customers, products] = await Promise.all([lookup('customers', true), lookup('products', true)]);
    const s = id ? (await api(`/subscriptions/${id}`)).data : { start_date: today(), next_ship_date: today(), frequency: '每月', status: '進行中', qty: 1, channel: 'LINE', payment_method: '轉帳', shipping_fee: 0, sales: [] };
    const box = openModal(`
      <h2>${id ? `訂閱 #${id}` : '新增訂閱'}</h2>
      <form id="f">
        <div class="form-grid">
          <label>客戶 *<select name="customer_id" required>${options(customers, 'customer_id', s.customer_id, { blank: '請選擇' })}</select></label>
          <label>產品 *<select name="product_id" required>${options(products, 'product_id', s.product_id, { blank: '請選擇' })}</select></label>
          <label>研磨<select name="grind_size">${plainOpts(GRIND, s.grind_size, '')}</select></label>
          <label>每期數量 *<input name="qty" type="number" step="1" min="1" required value="${esc(s.qty)}"></label>
          <label>單價<input name="unit_price" type="number" step="any" min="0" value="${esc(s.unit_price)}" placeholder="空白 = 零售價"></label>
          <label>每期運費<input name="shipping_fee" type="number" step="any" min="0" value="${esc(s.shipping_fee)}"></label>
          <label>頻率<select name="frequency">${plainOpts(FREQS, s.frequency)}</select></label>
          <label>下次出貨日 *<input name="next_ship_date" type="date" required value="${esc(s.next_ship_date)}"></label>
          <label>開始日期 *<input name="start_date" type="date" required value="${esc(s.start_date)}"></label>
          <label>結束日期<input name="end_date" type="date" value="${esc(s.end_date)}"></label>
          <label>通路<select name="channel">${plainOpts(CHANNELS, s.channel)}</select></label>
          <label>付款方式<select name="payment_method">${plainOpts(PAY_METHODS, s.payment_method)}</select></label>
          <label>狀態<select name="status">${plainOpts(SUB_STATUS, s.status)}</select></label>
          <label class="full">備註<input name="note" value="${esc(s.note)}"></label>
        </div>
        ${s.sales.length ? `<div class="section-title">出貨紀錄</div><div class="table-wrap"><table><thead><tr><th>銷貨日</th><th>單號</th><th class="num">金額</th><th>收款</th></tr></thead><tbody>
          ${s.sales.map((x) => `<tr class="clickable" data-sale="${x.sale_id}"><td>${esc(x.sale_date)}</td><td>${esc(x.sale_no)}</td><td class="num">${money(x.total_amount)}</td><td>${payTag(x.payment_status)}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <div class="form-actions">
          ${id ? '<button type="button" class="danger" id="del">刪除</button>' : ''}<span class="spacer"></span>
          <button type="button" id="cancel">取消</button><button class="primary">存檔</button>
        </div>
      </form>`, true);
    const f = $('#f', box);
    f.product_id.onchange = () => { // 依客戶價格等級帶單價
      const p = products.find((x) => x.product_id === Number(f.product_id.value));
      const c = customers.find((x) => x.customer_id === Number(f.customer_id.value));
      if (p) f.unit_price.value = (c?.price_level === '批發價' && p.wholesale_price != null ? p.wholesale_price : p.retail_price) ?? '';
    };
    $$('[data-sale]', box).forEach((tr) => tr.onclick = () => saleForm(Number(tr.dataset.sale), reload));
    $('#cancel', box).onclick = closeModal;
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(id ? `/subscriptions/${id}` : '/subscriptions', { method: id ? 'PUT' : 'POST', body: Object.fromEntries(new FormData(f)) });
        closeModal(); toast('已存檔'); reload?.();
      } catch (err) { fail(err); }
    };
    if (id) $('#del', box).onclick = async () => {
      if (!confirm('確定刪除這個訂閱？')) return;
      try { await api(`/subscriptions/${id}`, { method: 'DELETE' }); closeModal(); toast('已刪除'); reload?.(); } catch (err) { fail(err); }
    };
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- 盤點／庫存調整
const COUNT_ITEM_TYPES = ['生豆', '熟豆', '包材'];
const ADJ_REASONS = ['試喝', '樣品', '報廢'];

async function pageCounts() {
  $('#main').innerHTML = `
    <h2>盤點／庫存調整</h2>
    <div class="toolbar">
      <label>起日<input type="date" id="from" value="${monthStart()}"></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <label>類型<select id="ctype">${plainOpts(['盤點', '調整'], null, '全部')}</select></label>
      <label>品項<select id="itype">${plainOpts(COUNT_ITEM_TYPES, null, '全部')}</select></label>
      <button id="search">查詢</button><span class="spacer"></span>
      <button id="addCount" class="primary">＋ 盤點</button><button id="addAdj" class="primary">＋ 試喝／樣品／報廢</button>
    </div>
    <p class="hint">盤點：輸入實際數量，差異自動產生<span class="up">盤盈</span>／<span class="down">盤虧</span>。調整：試喝、樣品、報廢直接扣庫存。成本以批號成本（包材用移動平均）計算。盤點或調整過的批號會讓來源進貨單、烘焙批次鎖定。</p>
    <div class="stats" id="stats"></div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;
  const load = async () => {
    try {
      const { data, summary } = await api('/stock-counts' + qs({ from: $('#from').value, to: $('#to').value, count_type: $('#ctype').value, item_type: $('#itype').value }));
      $('#stats').innerHTML = statCards([['筆數', fmt(summary.count)], ['盤盈金額', '+' + money(summary.gain), 'up'], ['盤虧／調整金額', '−' + money(summary.loss), 'down']]);
      $('#list').innerHTML = data.length ? `<table><thead><tr><th>日期</th><th>單號</th><th>類型</th><th>品項</th><th class="num">筆數</th><th>原因</th><th class="num">盤盈</th><th class="num">盤虧／出庫</th><th>備註</th></tr></thead><tbody>
        ${data.map((c) => `<tr class="clickable" data-id="${c.count_id}"><td>${esc(c.count_date)}</td><td>${esc(c.count_no)}</td><td>${esc(c.count_type)}</td><td>${esc(c.item_type)}</td><td class="num">${c.item_count}</td>
          <td>${esc(c.reasons || '無差異')}</td>${inAmt(c.gain_amount)}${outAmt(c.loss_amount)}<td>${esc(c.note)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">此區間沒有盤點／調整</div>';
      $$('#list tr.clickable').forEach((tr) => tr.onclick = () => countForm(null, null, Number(tr.dataset.id), load));
    } catch (e) { fail(e); }
  };
  const pick = (countType) => {
    const box = openModal(`<h2>${countType === '盤點' ? '新增盤點' : '新增試喝／樣品／報廢'}</h2>
      <form id="f"><div class="form-grid"><label>品項類型<select name="t">${plainOpts(COUNT_ITEM_TYPES, '熟豆')}</select></label></div>
      <div class="form-actions"><span class="spacer"></span><button type="button" id="cancel">取消</button><button class="primary">下一步</button></div></form>`);
    $('#cancel', box).onclick = closeModal;
    $('#f', box).onsubmit = (e) => { e.preventDefault(); countForm(countType, $('#f', box).t.value, null, load); };
  };
  $('#search').onclick = load;
  $('#addCount').onclick = () => pick('盤點');
  $('#addAdj').onclick = () => pick('調整');
  load();
}

async function countForm(countType, itemType, id, reload) {
  try {
    const c = id ? (await api(`/stock-counts/${id}`)).data : { count_type: countType, item_type: itemType, count_date: today(), items: [] };
    countType = c.count_type; itemType = c.item_type;
    const isCount = countType === '盤點';
    const unitOf = (r) => r.unit || 'kg';
    const box = openModal(`
      <h2>${id ? `${esc(countType)} ${esc(c.count_no)}（${esc(itemType)}）` : `新增${esc(itemType)}${isCount ? '盤點' : '調整'}`}</h2>
      <form id="f">
        <div class="form-grid">
          <label>日期 *<input name="count_date" type="date" required value="${esc(c.count_date)}"></label>
          <label>單號<input name="count_no" value="${esc(c.count_no)}" placeholder="自動產生"></label>
          <label class="full">備註<input name="note" value="${esc(c.note)}"></label>
        </div>
        <p class="hint">${isCount ? '帳面數量 = 日期當天結束時的庫存。只填有盤的品項，空白的不處理；實際數量 = 帳面數量就是無差異。' : '輸入要扣掉的數量與原因，空白的不處理。'}</p>
        <div class="table-wrap" id="sheet"><div class="empty">載入中…</div></div>
        <div class="totals"><div class="grand"><span>差異金額</span><span id="tDiff"></span></div></div>
        <div class="form-actions">
          ${id ? '<button type="button" class="danger" id="del">刪除</button>' : ''}<span class="spacer"></span>
          <button type="button" id="cancel">取消</button><button class="primary">存檔</button>
        </div>
      </form>`, true);
    const f = $('#f', box);
    const mine = new Map(c.items.map((i) => [i.item_ref_id, i]));
    let rows = [];
    const loadSheet = async () => {
      const keep = new Map($$('#sheet tr[data-ref]', box).map((tr) => [Number(tr.dataset.ref), { a: $('[data-actual]', tr)?.value, q: $('[data-qty]', tr)?.value, r: $('[data-reason]', tr)?.value }]));
      rows = (await api('/stock-counts/sheet' + qs({ item_type: itemType, date: f.count_date.value, exclude_count_id: id }))).data;
      for (const i of c.items) if (!rows.some((r) => r.item_ref_id === i.item_ref_id)) rows.push({ item_ref_id: i.item_ref_id, code: i.code, name: i.name, system_qty: i.system_qty, unit_cost: i.unit_cost });
      $('#sheet', box).innerHTML = rows.length ? `<table class="items"><thead><tr><th>${itemType === '包材' ? '包材' : '批號'}</th><th>品項</th><th class="num">帳面數量</th><th class="num">單位成本</th>
        ${isCount ? '<th style="width:120px">實際數量</th><th class="num">差異</th>' : '<th style="width:110px">扣除數量</th><th style="width:100px">原因</th>'}<th class="num">金額</th></tr></thead><tbody>
        ${rows.map((r) => {
          const m = mine.get(r.item_ref_id); const k = keep.get(r.item_ref_id) || {};
          return `<tr data-ref="${r.item_ref_id}" data-sys="${r.system_qty}" data-cost="${r.unit_cost}"><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td class="num">${fmt(r.system_qty, 2)} ${esc(unitOf(r))}</td><td class="num">${fmt(r.unit_cost, 2)}</td>
            ${isCount ? `<td><input data-actual type="number" step="any" min="0" value="${esc(k.a ?? m?.actual_qty ?? '')}" class="num"></td><td class="num" data-diff></td>`
              : `<td><input data-qty type="number" step="any" min="0" value="${esc(k.q ?? (m ? -m.diff_qty : ''))}" class="num"></td><td><select data-reason>${plainOpts(ADJ_REASONS, k.r || m?.reason || '試喝')}</select></td>`}
            <td class="num" data-amt></td></tr>`;
        }).join('')}</tbody></table>` : `<div class="empty">${f.count_date.value} 沒有任何${itemType}庫存</div>`;
      calc();
    };
    const calc = () => {
      let sum = 0;
      $$('#sheet tr[data-ref]', box).forEach((tr) => {
        const sys = Number(tr.dataset.sys); const cost = Number(tr.dataset.cost);
        let diff = null;
        if (isCount) { const v = $('[data-actual]', tr).value; if (v !== '') diff = r2(Number(v) - sys); }
        else { const v = Number($('[data-qty]', tr).value); if (v) diff = -v; }
        if (isCount) $('[data-diff]', tr).innerHTML = diff === null ? '' : diff > 0 ? `<span class="up">+${fmt(diff, 2)}</span>` : diff < 0 ? `<span class="down">${fmt(diff, 2)}</span>` : '0';
        const amt = diff === null ? 0 : r2(diff * cost);
        sum += amt;
        $('[data-amt]', tr).innerHTML = diff ? `<span class="${amt >= 0 ? 'up' : 'down'}">${amt >= 0 ? '+' : '−'}${money(Math.abs(amt))}</span>` : '';
      });
      $('#tDiff', box).innerHTML = `<span class="${sum >= 0 ? 'up' : 'down'}">${sum >= 0 ? '+' : '−'}${money(Math.abs(sum))}</span>`;
    };
    $('#sheet', box).addEventListener('input', calc);
    f.count_date.onchange = loadSheet;
    $('#cancel', box).onclick = closeModal;
    await loadSheet();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = { ...Object.fromEntries(new FormData(f)), count_type: countType, item_type: itemType };
      body.items = $$('#sheet tr[data-ref]', box).map((tr) => (isCount
        ? { item_ref_id: Number(tr.dataset.ref), actual_qty: $('[data-actual]', tr).value }
        : { item_ref_id: Number(tr.dataset.ref), qty: $('[data-qty]', tr).value, reason: $('[data-reason]', tr).value }))
        .filter((it) => (isCount ? it.actual_qty !== '' : Number(it.qty) > 0));
      try {
        const res = await api(id ? `/stock-counts/${id}` : '/stock-counts', { method: id ? 'PUT' : 'POST', body });
        closeModal(); toast(`已存檔 ${res.data.count_no}`); reload?.();
      } catch (err) { fail(err); }
    };
    if (id) $('#del', box).onclick = async () => {
      if (!confirm(`確定刪除 ${c.count_no}？相關的庫存異動會一起刪除。`)) return;
      try { await api(`/stock-counts/${id}`, { method: 'DELETE' }); closeModal(); toast('已刪除'); reload?.(); } catch (err) { fail(err); }
    };
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- 產品配方
async function pageRecipes() {
  $('#main').innerHTML = `
    <h2>產品配方</h2>
    <p class="hint">配方只放包材（熟豆依產品主檔的「使用熟豆品項 × 每包淨重」扣）。銷貨存檔時依「每個產品用量 × 數量」扣包材庫存（包裝耗用），包材成本算進銷貨成本。修改配方不影響已存檔的銷貨單。點產品編輯配方。</p>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;
  try {
    const [products, { data: recipes }] = await Promise.all([lookup('products', true), api('/recipes')]);
    const rmap = new Map(recipes.map((r) => [r.product_id, r]));
    const load = async () => pageRecipes();
    $('#list').innerHTML = products.length ? `<table><thead><tr><th>料號</th><th>產品</th><th>類別</th><th>使用熟豆</th><th class="num">淨重 g</th><th>配方（包材 × 每個用量）</th></tr></thead><tbody>
      ${products.map((p) => `<tr class="clickable" data-id="${p.product_id}"><td>${esc(p.sku)}</td><td>${esc(p.name)}${p.is_active ? '' : '（停用）'}</td><td>${esc(p.category)}</td><td>${esc(p.roasted_bean_name)}</td><td class="num">${fmt(p.net_weight_g)}</td>
        <td>${rmap.get(p.product_id) ? esc(rmap.get(p.product_id).recipe_text) : '<span class="tag warn">未設定</span>'}</td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">還沒有產品</div>';
    $$('#list tr.clickable').forEach((tr) => tr.onclick = () => recipeForm(Number(tr.dataset.id), load));
  } catch (e) { fail(e); }
}

async function recipeForm(productId, reload) {
  try {
    const [packs, { data: r }] = await Promise.all([lookup('packaging-items', true), api(`/recipes/${productId}`)]);
    const row = (it = {}) => `<tr><td><select data-k="packaging_id">${options(packs, 'packaging_id', it.packaging_id, { blank: '選擇包材', label: (k) => `${k.name}（${k.unit}）` })}</select></td>
      <td><input data-k="qty" type="number" step="any" min="0" value="${esc(it.qty)}" class="num"></td><td class="num">${it.cost != null ? fmt(it.cost, 2) : ''}</td><td><button type="button" class="link" data-del>刪除</button></td></tr>`;
    const box = openModal(`
      <h2>配方：${esc(r.name)}</h2>
      <form id="f">
        <div class="table-wrap"><table class="items"><thead><tr><th style="min-width:240px">包材</th><th style="width:110px">每個產品用量</th><th class="num">目前成本</th><th></th></tr></thead>
          <tbody id="items">${(r.items.length ? r.items : [{}]).map(row).join('')}</tbody></table></div>
        <p class="hint">例：「耶加雪菲 濾掛 10入」= 濾掛袋 10 個 ＋ 外盒 1 個 ＋ 標籤 1 張。目前包材成本合計約 ${fmt(r.packaging_cost, 2)} 元／個（依移動平均成本）。</p>
        <div class="form-actions"><button type="button" id="addItem">＋ 新增一筆</button><span class="spacer"></span><button type="button" id="cancel">取消</button><button class="primary">存檔</button></div>
      </form>`);
    $('#items', box).addEventListener('click', (e) => { if (e.target.matches('[data-del]')) e.target.closest('tr').remove(); });
    $('#addItem', box).onclick = () => $('#items', box).insertAdjacentHTML('beforeend', row());
    $('#cancel', box).onclick = closeModal;
    $('#f', box).onsubmit = async (e) => {
      e.preventDefault();
      const items = $$('#items tr', box).map((tr) => Object.fromEntries($$('[data-k]', tr).map((el) => [el.dataset.k, el.value]))).filter((it) => it.packaging_id || it.qty);
      try { await api(`/recipes/${productId}`, { method: 'PUT', body: { items } }); closeModal(); toast('已存檔配方'); reload?.(); } catch (err) { fail(err); }
    };
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- 銷貨單列印
// 三種內容 × 三種紙張，在 iframe 內預覽後呼叫瀏覽器列印（可另存 PDF）。單據給客戶看，不含成本、毛利、批次。
const PRINT_MODES = [['each', '銷貨單（每張一頁）'], ['merge', '同客戶合併（銷貨彙整單）'], ['list', '銷貨彙總表（清單）']];
const PRINT_PAPERS = [['a4', 'A4 直式'], ['a5', 'A5 直式（A4 對半）'], ['t80', '80mm 熱感紙']];
const PRINT_MAX = 300;
const printPref = (k, v) => {
  try { if (v === undefined) return localStorage.getItem('print.' + k); localStorage.setItem('print.' + k, v); } catch { /* 無法使用 localStorage 就不記 */ }
  return null;
};

const PRINT_CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font:10.5pt/1.5 "Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif;color:#1f1a17;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.sheet{break-after:page;page-break-after:always}
.sheet:last-child{break-after:auto;page-break-after:auto}
.head{display:flex;justify-content:space-between;align-items:flex-end;gap:12pt;border-bottom:2.2pt solid #6f4e37;padding-bottom:7pt}
.shop-name{font-size:17pt;font-weight:700;letter-spacing:.5pt;line-height:1.25}
.shop-info{font-size:8.5pt;color:#5f554d;margin-top:2pt}
.title{text-align:right;white-space:nowrap}
.title h1{margin:0;font-size:19pt;letter-spacing:5pt;color:#6f4e37;line-height:1.2}
.title .no{font-size:11pt;font-weight:700;margin-top:3pt;font-variant-numeric:tabular-nums}
.title .dt{font-size:9.5pt;color:#5f554d}
.info{display:grid;grid-template-columns:1.35fr 1fr;gap:0 16pt;margin:9pt 0 8pt;padding:7pt 10pt;background:#faf7f2;border:.6pt solid #e0d6c9;border-radius:4pt}
.info .row{display:flex;gap:6pt;padding:1.2pt 0}
.info .k{flex:none;width:4.6em;color:#7a6f66}
.info .v{flex:1;min-width:0;word-break:break-word}
.info .v b{font-size:11.5pt}
table{width:100%;border-collapse:collapse}
thead{display:table-header-group}
tr{break-inside:avoid;page-break-inside:avoid}
th{background:#f1eae0;border-top:1pt solid #6f4e37;border-bottom:1pt solid #6f4e37;padding:4.5pt 6pt;text-align:left;font-size:9.5pt;font-weight:700;white-space:nowrap}
td{padding:4.5pt 6pt;border-bottom:.5pt solid #ddd3c6;vertical-align:top}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.ctr{text-align:center}
.sub{font-size:8.5pt;color:#7a6f66}
.nowrap{white-space:nowrap}
tr.adj td{color:#5f554d;font-size:9.5pt}
tr.grp td{background:#faf7f2;font-weight:700;font-size:9.5pt}
tr.sum td{font-weight:700;border-top:1pt solid #6f4e37;border-bottom:1pt solid #6f4e37;background:#faf7f2}
.below{display:flex;justify-content:space-between;gap:18pt;margin-top:9pt;break-inside:avoid;page-break-inside:avoid}
.notes{flex:1;min-width:0;font-size:9.5pt}
.notes .lbl{font-weight:700;color:#6f4e37;margin-top:5pt}
.notes .lbl:first-child{margin-top:0}
.pre{white-space:pre-wrap;word-break:break-word}
.totals{flex:none;width:44%}
.totals div{display:flex;justify-content:space-between;padding:1.6pt 0}
.totals .grand{font-size:13pt;font-weight:700;border-top:1pt solid #6f4e37;border-bottom:1pt solid #6f4e37;margin:3pt 0;padding:4pt 0}
.totals .due{font-weight:700}
.sign{display:flex;gap:26pt;margin-top:26pt;break-inside:avoid;page-break-inside:avoid}
.sign div{flex:1;border-top:.6pt solid #1f1a17;padding-top:3pt;font-size:9pt;color:#5f554d}
.foot{margin-top:12pt;padding-top:6pt;border-top:.5pt dashed #b9ad9f;font-size:8.5pt;color:#5f554d;text-align:center}
.show-t{display:none}

.p-a5{font-size:9pt}
.p-a5 .shop-name{font-size:14pt}.p-a5 .title h1{font-size:15pt;letter-spacing:4pt}.p-a5 .title .no{font-size:10pt}
.p-a5 th,.p-a5 td{padding:3.5pt 4pt}.p-a5 th{font-size:8.5pt}.p-a5 .totals{width:50%}.p-a5 .totals .grand{font-size:11.5pt}.p-a5 .sign{margin-top:20pt}

.p-t80{font-size:9pt;line-height:1.4}
.p-t80 .hide-t{display:none}
.p-t80 .show-t{display:block}
.p-t80 tr.show-t{display:table-row}
.p-t80 .head{display:block;text-align:center;border-bottom:1pt dashed #000;padding-bottom:5pt}
.p-t80 .shop-name{font-size:13pt}.p-t80 .shop-info{font-size:8pt;color:#000}
.p-t80 .title{text-align:center;margin-top:4pt;white-space:normal}
.p-t80 .title h1{font-size:12pt;letter-spacing:3pt;color:#000}.p-t80 .title .no{font-size:10pt}.p-t80 .title .dt{color:#000}
.p-t80 .info{display:block;background:none;border:0;border-bottom:1pt dashed #000;border-radius:0;padding:4pt 0;margin:0 0 3pt}
.p-t80 .info .k{color:#000}
.p-t80 th{background:none;border-top:0;border-bottom:.8pt solid #000;padding:3pt 2pt;font-size:8.5pt}
.p-t80 td{padding:3pt 2pt;border-bottom:.5pt dotted #777}
.p-t80 .sub,.p-t80 tr.adj td{color:#000}
.p-t80 tr.grp td,.p-t80 tr.sum td{background:none}
.p-t80 tr.sum td{border-top:.8pt solid #000;border-bottom:.8pt solid #000}
.p-t80 .below{display:flex;flex-direction:column-reverse;gap:0;margin-top:4pt}
.p-t80 .totals{width:100%}
.p-t80 .totals .grand{font-size:12pt;border-color:#000}
.p-t80 .notes{margin-top:5pt;font-size:8.5pt}.p-t80 .notes .lbl{color:#000}
.p-t80 .foot{border-top:1pt dashed #000;color:#000;margin-top:6pt}

@media screen{
  body{background:#8d857c;padding:14px 0}
  .sheet{background:#fff;margin:0 auto 14px;box-shadow:0 2px 10px rgba(0,0,0,.35)}
  .p-a4 .sheet{width:210mm;min-height:297mm;padding:12mm}
  .p-a5 .sheet{width:148mm;min-height:210mm;padding:8mm}
  .p-t80 .sheet{width:80mm;padding:4mm}
}
@media print{
  .p-t80 .sheet{width:72mm;margin:0 auto;padding:2mm 0 6mm}
}`;
const PAGE_RULE = { a4: '@page{size:A4 portrait;margin:12mm}', a5: '@page{size:A5 portrait;margin:8mm}', t80: '@page{margin:0}' };

const pMoney = (n) => fmt(Math.round(Number(n) || 0), 0);
const sumBy = (rows, f) => r2(rows.reduce((s, r) => s + (Number(f(r)) || 0), 0));
const infoRow = (k, v) => (v ? `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>` : '');

function printHead(shop, title, no, sub) {
  const line2 = [shop.phone && `電話 ${esc(shop.phone)}`, shop.tax_id && `統編 ${esc(shop.tax_id)}`, esc(shop.contact)].filter(Boolean).join('　');
  return `<div class="head">
    <div><div class="shop-name">${esc(shop.shop_name || 'PiNN Cafe')}</div>
      <div class="shop-info">${shop.address ? `<div>${esc(shop.address)}</div>` : ''}${line2 ? `<div>${line2}</div>` : ''}</div></div>
    <div class="title"><h1>${title}</h1>${no ? `<div class="no">${esc(no)}</div>` : ''}${sub ? `<div class="dt">${sub}</div>` : ''}</div>
  </div>`;
}
function printCustomer(s, right) {
  return `<div class="info"><div>
      ${infoRow('客戶', `<b>${esc(s.customer_name || '散客')}</b>`)}${infoRow('電話', esc(s.customer_phone))}${infoRow('統一編號', esc(s.customer_tax_id))}${infoRow('送貨地址', esc(s.customer_address))}
    </div><div>${right}</div></div>`;
}
/** 合計區：rows = [[標籤, 金額字串, class]] */
const totalsBox = (rows) => `<div class="totals">${rows.filter(Boolean).map(([k, v, c]) => `<div class="${c || ''}"><span>${k}</span><span>${v}</span></div>`).join('')}</div>`;
function payRows(net, paid, unpaid, returned, showPay) {
  if (!showPay) return [];
  return [
    returned ? ['退貨／折讓', '−' + pMoney(returned)] : null,
    returned ? ['應收淨額', pMoney(net)] : null,
    paid ? ['已收', pMoney(paid)] : null,
    unpaid > 0.005 ? ['未收金額', pMoney(unpaid), 'due'] : ['收款狀態', '已收清', 'due'],
  ];
}
function printNotes(shop, note, unpaid, showPay) {
  const parts = [];
  if (note) parts.push(`<div class="lbl">備註</div><div class="pre">${esc(note)}</div>`);
  if (shop.bank_info && (!showPay || unpaid > 0.005)) parts.push(`<div class="lbl">匯款資訊</div><div class="pre">${esc(shop.bank_info)}</div>`);
  return `<div class="notes">${parts.join('')}</div>`;
}
const printTail = (shop) => `<div class="sign hide-t"><div>經手人</div><div>客戶簽收</div></div>${shop.sales_note ? `<div class="foot pre">${esc(shop.sales_note)}</div>` : ''}`;
/** 品名欄：熱感紙把研磨、單價收在品名下方 */
const itemName = (it) => `${esc(it.product_name)}${it.note ? `<div class="sub">${esc(it.note)}</div>` : ''}<div class="sub show-t">${[esc(it.grind_size), '@' + pMoney(it.unit_price)].filter(Boolean).join('　')}</div>`;

/** 單張銷貨單 */
function saleSheet(s, shop, o) {
  return `<section class="sheet">
    ${printHead(shop, '銷貨單', s.sale_no, `日期 ${esc(s.sale_date)}`)}
    ${printCustomer(s, `${infoRow('通路', esc(s.channel))}${infoRow('付款方式', esc(s.payment_method))}${infoRow('應收日期', esc(s.due_date))}${infoRow('發票號碼', esc(s.invoice_no))}`)}
    <table><thead><tr><th class="ctr hide-t" style="width:2.6em">項次</th><th>品名</th><th class="hide-t">研磨</th><th class="num">數量</th><th class="num hide-t">單價</th><th class="num">金額</th></tr></thead><tbody>
      ${s.items.map((it, i) => `<tr><td class="ctr hide-t">${i + 1}</td><td>${itemName(it)}</td><td class="hide-t nowrap">${esc(it.grind_size)}</td><td class="num">${fmt(it.qty)}</td><td class="num hide-t">${pMoney(it.unit_price)}</td><td class="num">${pMoney(it.amount)}</td></tr>`).join('')}
    </tbody></table>
    <div class="below">${printNotes(shop, s.note, s.unpaid_amount, o.showPay)}
      ${totalsBox([
        ['小計', pMoney(s.subtotal)], s.discount ? ['折扣', '−' + pMoney(s.discount)] : null, s.shipping_fee ? ['運費', pMoney(s.shipping_fee)] : null,
        ['合計', 'NT$ ' + pMoney(s.total_amount), 'grand'],
        ...payRows(s.net_amount, s.paid_amount, s.unpaid_amount, s.returned_amount, o.showPay),
      ])}</div>
    ${printTail(shop)}
  </section>`;
}

/** 同一客戶多張合併成一張彙整單 */
function mergedSheet(list, shop, o) {
  const first = list[0];
  const dates = list.map((s) => s.sale_date).sort();
  const period = dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} ～ ${dates[dates.length - 1]}`;
  const tot = {
    subtotal: sumBy(list, (s) => s.subtotal), discount: sumBy(list, (s) => s.discount), shipping: sumBy(list, (s) => s.shipping_fee), total: sumBy(list, (s) => s.total_amount),
    returned: sumBy(list, (s) => s.returned_amount), net: sumBy(list, (s) => s.net_amount), paid: sumBy(list, (s) => s.paid_amount), unpaid: sumBy(list, (s) => s.unpaid_amount),
  };
  const adj = (label, amt) => `<tr class="adj"><td class="hide-t"></td><td class="hide-t"></td><td>${label}</td><td class="hide-t"></td><td></td><td class="hide-t"></td><td class="num">${amt}</td></tr>`;
  const body = list.map((s) => `<tr class="grp show-t"><td colspan="7">${esc(s.sale_date)}　${esc(s.sale_no)}</td></tr>` + s.items.map((it, i) => `<tr>
      <td class="hide-t nowrap">${i ? '' : esc(s.sale_date)}</td><td class="hide-t nowrap">${i ? '' : esc(s.sale_no)}</td><td>${itemName(it)}</td><td class="hide-t nowrap">${esc(it.grind_size)}</td>
      <td class="num">${fmt(it.qty)}</td><td class="num hide-t">${pMoney(it.unit_price)}</td><td class="num">${pMoney(it.amount)}</td></tr>`).join('')
    + (s.discount ? adj('折扣', '−' + pMoney(s.discount)) : '') + (s.shipping_fee ? adj('運費', pMoney(s.shipping_fee)) : '')).join('');
  const notes = list.filter((s) => s.note).map((s) => `${s.sale_no}：${s.note}`).join('\n');
  return `<section class="sheet">
    ${printHead(shop, '銷貨彙整單', '', `期間 ${esc(period)}`)}
    ${printCustomer(first, `${infoRow('銷貨單數', `${list.length} 張`)}${infoRow('列印日期', today())}`)}
    <table><thead><tr><th class="hide-t">日期</th><th class="hide-t">單號</th><th>品名</th><th class="hide-t">研磨</th><th class="num">數量</th><th class="num hide-t">單價</th><th class="num">金額</th></tr></thead><tbody>${body}</tbody></table>
    <div class="below">${printNotes(shop, notes, tot.unpaid, o.showPay)}
      ${totalsBox([
        ['明細小計', pMoney(tot.subtotal)], tot.discount ? ['折扣', '−' + pMoney(tot.discount)] : null, tot.shipping ? ['運費', pMoney(tot.shipping)] : null,
        ['合計', 'NT$ ' + pMoney(tot.total), 'grand'],
        ...payRows(tot.net, tot.paid, tot.unpaid, tot.returned, o.showPay),
      ])}</div>
    ${printTail(shop)}
  </section>`;
}

/** 銷貨彙總表：一張單一列 */
function listSheet(list, shop, o) {
  const dates = list.map((s) => s.sale_date).sort();
  const period = dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} ～ ${dates[dates.length - 1]}`;
  const pay = o.showPay;
  return `<section class="sheet">
    ${printHead(shop, '銷貨彙總表', '', `期間 ${esc(period)}`)}
    <div class="sub" style="margin:6pt 0 4pt">共 ${list.length} 張銷貨單　列印日期 ${today()}</div>
    <table><thead><tr><th class="hide-t">日期</th><th>單號</th><th>客戶</th><th class="hide-t">通路</th><th class="hide-t">品項</th><th class="hide-t">付款方式</th><th class="num">合計</th>${pay ? '<th class="num hide-t">已收</th><th class="num">未收</th>' : ''}</tr></thead><tbody>
      ${list.map((s) => `<tr><td class="hide-t nowrap">${esc(s.sale_date)}</td><td class="nowrap">${esc(s.sale_no)}</td><td>${esc(s.customer_name || '散客')}</td><td class="hide-t nowrap">${esc(s.channel)}</td>
        <td class="hide-t sub">${s.items.map((it) => `${esc(it.product_name)}${it.grind_size ? `（${esc(it.grind_size)}）` : ''}×${fmt(it.qty)}`).join('、')}</td><td class="hide-t nowrap">${esc(s.payment_method)}</td>
        <td class="num">${pMoney(s.total_amount)}</td>${pay ? `<td class="num hide-t">${s.paid_amount ? pMoney(s.paid_amount) : ''}</td><td class="num">${s.unpaid_amount > 0.005 ? pMoney(s.unpaid_amount) : ''}</td>` : ''}</tr>`).join('')}
      <tr class="sum"><td class="hide-t"></td><td>合計</td><td>${list.length} 張</td><td class="hide-t"></td><td class="hide-t"></td><td class="hide-t"></td>
        <td class="num">${pMoney(sumBy(list, (s) => s.total_amount))}</td>${pay ? `<td class="num hide-t">${pMoney(sumBy(list, (s) => s.paid_amount))}</td><td class="num">${pMoney(sumBy(list, (s) => s.unpaid_amount))}</td>` : ''}</tr>
    </tbody></table>
  </section>`;
}

/** 產生整份列印文件（iframe srcdoc） */
function buildPrintDoc(sales, shop, o) {
  let sheets; let title;
  if (o.mode === 'list') {
    sheets = [listSheet(sales, shop, o)];
    title = `銷貨彙總表_${today()}`;
  } else if (o.mode === 'merge') {
    // 同客戶合併；散客沒有客戶資料，不合併、各自一張
    const groups = new Map();
    for (const s of sales) {
      const key = s.customer_id ? 'c' + s.customer_id : 's' + s.sale_id;
      groups.set(key, [...(groups.get(key) || []), s]);
    }
    sheets = [...groups.values()].map((g) => (g.length > 1 ? mergedSheet(g, shop, o) : saleSheet(g[0], shop, o)));
    title = `銷貨彙整單_${today()}`;
  } else {
    sheets = sales.map((s) => saleSheet(s, shop, o));
    title = sales.length === 1 ? `銷貨單_${sales[0].sale_no}` : `銷貨單_${today()}_${sales.length}張`;
  }
  return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PAGE_RULE[o.paper]}${PRINT_CSS}</style></head><body class="p-${o.paper}">${sheets.join('')}</body></html>`;
}

/** 列印視窗：ids = 要列印的銷貨單；onClose = 關閉後要做的事（例：回到銷貨單） */
async function printSales(ids, onClose) {
  try {
    if (!ids.length) return toast('沒有可列印的銷貨單', true);
    if (ids.length > PRINT_MAX) return toast(`一次最多列印 ${PRINT_MAX} 張銷貨單，請縮小查詢範圍或改用勾選`, true);
    const { data: sales, shop } = await api('/sales/print' + qs({ ids: ids.join(',') }));
    const single = sales.length === 1;
    const mode0 = single ? 'each' : (PRINT_MODES.some(([k]) => k === printPref('mode')) ? printPref('mode') : 'each');
    const paper0 = PRINT_PAPERS.some(([k]) => k === printPref('paper')) ? printPref('paper') : 'a4';
    const box = openModal(`
      <h2>列印銷貨單 <span class="hint">${single ? esc(sales[0].sale_no) : `共 ${sales.length} 張`}</span></h2>
      <div class="toolbar">
        ${single ? '' : `<label>內容<select id="pMode">${PRINT_MODES.map(([k, v]) => `<option value="${k}" ${k === mode0 ? 'selected' : ''}>${v}</option>`).join('')}</select></label>`}
        <label>紙張<select id="pPaper">${PRINT_PAPERS.map(([k, v]) => `<option value="${k}" ${k === paper0 ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>收款資訊<select id="pPay"><option value="1">顯示已收／未收</option><option value="0" ${printPref('pay') === '0' ? 'selected' : ''}>不顯示</option></select></label>
        <span class="spacer"></span>
        <button type="button" id="pClose">關閉</button><button type="button" id="pGo" class="primary">🖨 列印</button>
      </div>
      <p class="hint" id="pHint"></p>
      <iframe id="pFrame" title="列印預覽" style="width:100%;height:68vh;border:1px solid var(--line);border-radius:8px;background:#8d857c"></iframe>`, true);
    const opts = () => ({ mode: single ? 'each' : $('#pMode', box).value, paper: $('#pPaper', box).value, showPay: $('#pPay', box).value === '1' });
    const render = () => {
      const o = opts();
      printPref('paper', o.paper); printPref('pay', o.showPay ? '1' : '0'); if (!single) printPref('mode', o.mode);
      $('#pFrame', box).srcdoc = buildPrintDoc(sales, shop, o);
      const hints = [];
      if (!shop.shop_name) hints.push(canWriteRes('shop') ? '尚未設定商店資料，抬頭暫以「PiNN Cafe」顯示；請到「系統 → 商店資料」填寫店名、電話、地址、匯款資訊。' : '尚未設定商店資料，請管理者到「系統 → 商店資料」填寫。');
      if (o.mode === 'merge') hints.push('同一客戶的銷貨單合併成一張；散客與只有一張的客戶仍各自一張。');
      if (o.paper === 't80') hints.push('熱感紙：列印對話框的紙張請選印表機的 80mm 紙捲、邊界選「無」。');
      else hints.push('列印對話框可選「另存為 PDF」傳給客戶；請取消「頁首及頁尾」。');
      $('#pHint', box).textContent = hints.join('　');
    };
    $$('select', box).forEach((el) => el.onchange = render);
    $('#pGo', box).onclick = () => { const w = $('#pFrame', box).contentWindow; w.focus(); w.print(); };
    $('#pClose', box).onclick = () => { closeModal(); onClose?.(); };
    render();
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- 商店資料（列印抬頭）
async function pageShop() {
  const { data: s } = await api('/shop');
  const ro = canWriteRes('shop') ? '' : 'disabled';
  $('#main').innerHTML = `
    <h2>商店資料</h2>
    <p class="hint">列印銷貨單時顯示在抬頭與頁尾。沒填的欄位不會印出來。</p>
    <div class="card" style="padding:16px;max-width:760px"><form id="f">
      <div class="form-grid">
        <label>店名／公司名稱<input name="shop_name" maxlength="60" value="${esc(s.shop_name)}" placeholder="PiNN Cafe" ${ro}></label>
        <label>統一編號<input name="tax_id" maxlength="8" inputmode="numeric" value="${esc(s.tax_id)}" ${ro}></label>
        <label>電話<input name="phone" maxlength="40" value="${esc(s.phone)}" ${ro}></label>
        <label>其他聯絡方式<input name="contact" maxlength="120" value="${esc(s.contact)}" placeholder="LINE、Email、網站" ${ro}></label>
        <label class="full">地址<input name="address" maxlength="120" value="${esc(s.address)}" ${ro}></label>
        <label class="full">匯款資訊（還有未收金額的銷貨單才會印）<textarea name="bank_info" rows="3" maxlength="300" placeholder="銀行（代號）分行&#10;戶名&#10;帳號" ${ro}>${esc(s.bank_info)}</textarea></label>
        <label class="full">銷貨單備註（印在每張單最下方）<textarea name="sales_note" rows="3" maxlength="500" placeholder="例：咖啡豆請於常溫陰涼處保存，建議烘焙日起一個月內飲用完畢。" ${ro}>${esc(s.sales_note)}</textarea></label>
      </div>
      ${ro ? '' : '<div class="form-actions"><button class="primary">存檔</button></div>'}
    </form></div>`;
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/shop', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) }); toast('已存檔'); } catch (err) { fail(err); }
  };
}

// ---------------------------------------------------------------- Phase 5 共用：權限、Excel
let ME = null; // /api/me：email、role、read、write、modules
const ROUTE_RES = {
  purchases: 'purchases', sales: 'sales', 'customer-history': 'sales', returns: 'returns', subscriptions: 'subscriptions', invoices: 'invoices',
  roasts: 'roast-batches', 'stock-beans': 'inventory', 'stock-roasted': 'inventory', 'stock-packaging': 'inventory', 'stock-counts': 'stock-counts', 'opening-stock': 'opening-stock',
  bank: 'bank-transactions', expenses: 'expenses', receivables: 'finance', payables: 'finance', 'expense-summary': 'finance', reconcile: 'reconcile',
  recipes: 'recipes', 'rpt-profit': 'reports', 'rpt-pnl': 'reports', 'rpt-loss': 'reports', 'rpt-trace': 'reports', 'rpt-stock': 'inventory', 'rpt-processing': 'reports',
  users: 'users', audit: 'audit-logs', data: 'backup', 'bank-codes': 'bank-codes', shop: 'shop',
};
const canRead = (routeKey) => {
  if (!ME) return true;
  const res = ROUTE_RES[routeKey] || routeKey;
  const mod = ME.modules[res];
  return !mod || ME.read.includes(mod);
};
const canWriteRes = (res) => !ME || !ME.modules[res] || ME.write.includes(ME.modules[res]);

let excelLoading = null;
function loadExcel() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  excelLoading ||= new Promise((ok, bad) => {
    const s = document.createElement('script');
    s.src = 'vendor/exceljs.min.js';
    s.onload = () => ok(window.ExcelJS);
    s.onerror = () => bad(new Error('Excel 元件載入失敗，請重新整理頁面'));
    document.head.appendChild(s);
  });
  return excelLoading;
}
async function downloadWorkbook(wb, filename) {
  const buf = await wb.xlsx.writeBuffer();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
/** 把畫面上的數字字串轉回數字（1,234／+12.5／−300／15.2%） */
function cellValue(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  const m = t.match(/^([+\-−])?([\d,]+(?:\.\d+)?)(%)?$/);
  if (!m) return { v: t };
  let n = Number(m[2].replace(/,/g, ''));
  if (m[1] === '-' || m[1] === '−') n = -n;
  return m[3] ? { v: n / 100, fmt: '0.0%' } : { v: n, fmt: Number.isInteger(n) ? '#,##0' : '#,##0.00' };
}
const sheetName = (s, used) => {
  let n = (s || '工作表').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 28) || '工作表';
  let k = n; let i = 2;
  while (used.has(k)) k = `${n}${i++}`;
  used.add(k); return k;
};
function addAoaSheet(wb, name, rows, used) {
  const ws = wb.addWorksheet(sheetName(name, used));
  rows.forEach((r, i) => {
    const row = ws.addRow(r.map((c) => (c && typeof c === 'object' && 'v' in c ? c.v : c)));
    r.forEach((c, j) => { if (c && typeof c === 'object' && c.fmt) row.getCell(j + 1).numFmt = c.fmt; });
    if (i === 0) row.font = { bold: true };
  });
  ws.columns.forEach((col) => {
    let w = 8;
    col.eachCell({ includeEmpty: false }, (cell) => { w = Math.max(w, String(cell.value ?? '').replace(/[^\x00-\xff]/g, 'xx').length + 2); });
    col.width = Math.min(w, 60);
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return ws;
}
/** 匯出目前頁面上所有表格（每個表格一個工作表，依上方的區段標題命名） */
async function exportPage() {
  try {
    const ExcelJS = await loadExcel();
    const wb = new ExcelJS.Workbook();
    const used = new Set();
    const title = $('#main h2')?.textContent.trim() || '匯出';
    const filters = $$('#main .toolbar label').map((l) => {
      const el = $('input,select', l);
      const v = el?.tagName === 'SELECT' ? el.options[el.selectedIndex]?.text : el?.value;
      return v ? `${l.firstChild.textContent.trim()}：${v}` : null;
    }).filter(Boolean).join('　');
    $$('#main table').forEach((tb, i) => {
      if (tb.closest('#modal')) return;
      let label = title;
      for (let el = tb.closest('.card, .table-wrap'); el; el = el.previousElementSibling) {
        if (el.classList?.contains('section-title')) { label = el.textContent.trim(); break; }
      }
      const rows = $$('tr', tb).map((tr) => $$('th,td', tr).filter((c) => !c.querySelector('input[type=checkbox]') || c.textContent.trim())
        .map((c) => {
          const inp = $('input:not([type=checkbox]),select', c);
          return cellValue(inp ? (inp.tagName === 'SELECT' ? inp.options[inp.selectedIndex]?.text || '' : inp.value) : c.textContent.replace(/^[▸▾]\s*/, ''));
        }));
      if (rows.length) addAoaSheet(wb, i === 0 ? title : label, rows, used);
    });
    if (!wb.worksheets.length) return toast('這一頁沒有可匯出的表格', true);
    if (filters) wb.worksheets[0].spliceRows(1, 0, [filters], []); // 第一張表上方註明篩選條件
    await downloadWorkbook(wb, `${title}_${today()}.xlsx`);
  } catch (e) { fail(e); }
}
/** 每次換頁後，在有表格的頁面工具列加上「匯出 Excel」 */
function addExportButton() {
  const tb = $('#main .toolbar');
  if (!tb || $('#exportBtn')) return;
  const b = document.createElement('button');
  b.id = 'exportBtn'; b.type = 'button'; b.textContent = '⬇ 匯出 Excel';
  b.onclick = exportPage;
  const sp = $('.spacer', tb);
  sp ? sp.after(b) : tb.appendChild(b);
}

// ---------------------------------------------------------------- 報表：毛利分析
const pctCell = (r) => `<td class="num">${r === null || r === undefined ? '' : pct(r)}</td>`;
const signCell = (n) => `<td class="num ${n > 0 ? 'up' : n < 0 ? 'down' : ''}">${money(n)}</td>`;

async function pageProfit() {
  $('#main').innerHTML = `
    <h2>毛利分析</h2>
    <div class="toolbar">
      <label>起日<input type="date" id="from" value="${monthStart()}"></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <label>分組<select id="group"><option value="product">產品</option><option value="customer">客戶</option><option value="channel">通路</option><option value="roasted_bean">熟豆品項</option><option value="month">月份</option></select></label>
      <button id="search">查詢</button><span class="spacer"></span>
    </div>
    <p class="hint">營收 = 明細金額扣掉整單折扣（不含運費）；退貨折讓依退貨日計入。成本 = 熟豆＋包材（銷貨當下成本，扣掉退回回補）。
      <b>加工成本</b> = 出貨熟豆 kg × 該批烘焙月份的每 kg 加工成本（勾選「攤入烘焙」的費用 ÷ 當月烘焙產出 kg，見 <a href="#rpt-processing">加工成本</a>），只在報表中攤提，不改已存檔的成本。<span class="up">紅色 = 獲利</span>、<span class="down">綠色 = 虧損</span>。</p>
    <div class="stats" id="stats"></div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;
  const load = async () => {
    try {
      const { data, total } = await api('/reports/profit' + qs({ from: $('#from').value, to: $('#to').value, group: $('#group').value }));
      $('#stats').innerHTML = statCards([['淨營收', money(total.net_revenue)], ['成本（豆＋包材）', money(total.cost)], ['毛利', money(total.gross), total.gross >= 0 ? 'up' : 'down'], ['毛利率', pct(total.margin) || '—'],
        ['加工成本', money(total.processing)], ['調整後毛利', money(total.adj_gross), total.adj_gross >= 0 ? 'up' : 'down'], ['調整後毛利率', pct(total.adj_margin) || '—']]);
      const row = (r, cls = '') => `<tr class="${cls}"><td>${esc(r.label)}</td><td class="num">${fmt(r.qty)}</td><td class="num">${money(r.revenue)}</td><td class="num">${r.returns ? '−' + money(r.returns) : ''}</td>
        <td class="num"><b>${money(r.net_revenue)}</b></td><td class="num">${money(r.cost)}</td><td class="num">${money(r.packaging)}</td>${signCell(r.gross)}${pctCell(r.margin)}
        <td class="num">${money(r.processing)}</td>${signCell(r.adj_gross)}${pctCell(r.adj_margin)}</tr>`;
      $('#list').innerHTML = data.length ? `<table><thead><tr><th>${esc($('#group').selectedOptions[0].text)}</th><th class="num">數量</th><th class="num">營收</th><th class="num">退貨折讓</th><th class="num">淨營收</th>
        <th class="num">成本</th><th class="num">其中包材</th><th class="num">毛利</th><th class="num">毛利率</th><th class="num">加工成本</th><th class="num">調整後毛利</th><th class="num">調整後毛利率</th></tr></thead>
        <tbody>${data.map((r) => row(r)).join('')}${row(total, 'total')}</tbody></table>` : '<div class="empty">此區間沒有銷貨</div>';
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  $('#group').onchange = load;
  load();
}

// ---------------------------------------------------------------- 報表：損益概要
async function pagePnl() {
  $('#main').innerHTML = `
    <h2>損益概要</h2>
    <div class="toolbar">
      <label>起日<input type="date" id="from" value="${today().slice(0, 4)}-01-01"></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <label>期間<select id="period"><option value="month">月</option><option value="quarter">季</option><option value="year">年</option></select></label>
      <button id="search">查詢</button><span class="spacer"></span>
    </div>
    <p class="hint">權責基礎（依單據日期，不看有沒有收付款）。營業收入 = 銷貨（扣折扣）＋ 運費 − 退貨折讓；銷貨成本 = 熟豆＋包材成本 − 退回回補；
      營業費用含「攤入烘焙」的費用（損益表不再另外攤加工成本，避免重複）；庫存損耗 = 盤虧／試喝／樣品／報廢 − 盤盈。<span class="up">紅色 = 獲利</span>、<span class="down">綠色 = 虧損</span>。</p>
    <div class="stats" id="stats"></div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;
  const load = async () => {
    try {
      const { data, total, categories } = await api('/reports/pnl' + qs({ from: $('#from').value, to: $('#to').value, period: $('#period').value }));
      $('#stats').innerHTML = statCards([['營業收入', money(total.revenue)], ['銷貨毛利', money(total.gross), total.gross >= 0 ? 'up' : 'down'], ['毛利率', pct(total.gross_margin) || '—'],
        ['營業費用', money(total.expenses)], ['本期淨利', money(total.net), total.net >= 0 ? 'up' : 'down'], ['淨利率', pct(total.net_margin) || '—']]);
      if (!data.length) { $('#list').innerHTML = '<div class="empty">此區間沒有資料</div>'; return; }
      const cols = [...data, total];
      const line = (label, f, opt = {}) => `<tr class="${opt.cls || ''}"><td>${opt.indent ? '　' : ''}${label}</td>${cols.map((c) => {
        const v = f(c);
        if (opt.pct) return pctCell(v);
        if (opt.sign) return signCell(v);
        return `<td class="num">${v ? money(v) : ''}</td>`;
      }).join('')}</tr>`;
      $('#list').innerHTML = `<table><thead><tr><th>項目</th>${cols.map((c) => `<th class="num">${esc(c.period)}</th>`).join('')}</tr></thead><tbody>
        ${line('銷貨收入（扣折扣）', (c) => c.sales)}${line('運費收入', (c) => c.shipping)}${line('銷貨退回／折讓', (c) => -c.returns)}
        ${line('營業收入', (c) => c.revenue, { cls: 'total' })}
        ${line('銷貨成本', (c) => c.cogs, { indent: true })}${line('退回回補成本', (c) => -c.restock_cost, { indent: true })}
        ${line('銷貨毛利', (c) => c.gross, { cls: 'total', sign: true })}${line('毛利率', (c) => c.gross_margin, { pct: true })}
        ${categories.map((n) => line(n, (c) => c.by_category[n] || 0, { indent: true })).join('')}
        ${line('營業費用合計', (c) => c.expenses)}${line('　其中攤入烘焙', (c) => c.roast_expenses, { indent: true })}
        ${line('庫存損耗', (c) => c.inv_loss)}
        ${line('本期淨利', (c) => c.net, { cls: 'total', sign: true })}${line('淨利率', (c) => c.net_margin, { pct: true })}
        </tbody></table>`;
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  $('#period').onchange = load;
  load();
}

// ---------------------------------------------------------------- 報表：失重率分析
async function pageLoss() {
  $('#main').innerHTML = `
    <h2>失重率分析</h2>
    <div class="toolbar">
      <label>起日<input type="date" id="from" value="${today().slice(0, 4)}-01-01"></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <label>依<select id="by"><option value="green">生豆品項</option><option value="roasted">熟豆品項</option></select></label>
      <button id="search">查詢</button><span class="spacer"></span>
    </div>
    <p class="hint">失重率 =（投入 − 產出）÷ 投入，依投入 kg 加權平均。一個批次投入多種生豆（綜合豆）時，批次失重率套用到每一種生豆。超出 10%～25% 標示提醒。</p>
    <div class="stats" id="stats"></div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;
  const load = async () => {
    try {
      const { data, months, total } = await api('/reports/loss' + qs({ from: $('#from').value, to: $('#to').value, by: $('#by').value }));
      $('#stats').innerHTML = statCards([['投入 kg', '−' + kg(total.input_kg), 'down'], ['產出 kg', '+' + kg(total.output_kg), 'up'], ['平均失重率', pct(total.loss_rate) || '—']]);
      $('#list').innerHTML = data.length ? `<table><thead><tr><th>品項</th><th class="num">批次</th><th class="num">投入 kg</th><th class="num">產出 kg</th><th class="num">平均失重率</th><th class="num">最低</th><th class="num">最高</th>
        ${months.map((m) => `<th class="num">${m}</th>`).join('')}</tr></thead><tbody>
        ${data.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${r.batches}</td><td class="num">${kg(r.input_kg)}</td><td class="num">${kg(r.output_kg)}</td><td class="num"><b>${lossTag(r.loss_rate)}</b></td>
          <td class="num">${pct(r.min_rate)}</td><td class="num">${pct(r.max_rate)}</td>${months.map((m) => `<td class="num">${r.months[m] ? lossTag(r.months[m].loss_rate) : ''}</td>`).join('')}</tr>`).join('')}
        </tbody></table>` : '<div class="empty">此區間沒有烘焙批次</div>';
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  $('#by').onchange = load;
  load();
}

// ---------------------------------------------------------------- 報表：批號追溯
async function pageTrace() {
  const [green, roasted] = await Promise.all([api('/inventory/green-beans?show_empty=1'), api('/inventory/roasted?show_empty=1')]);
  const gOpts = green.data.flatMap((b) => b.lots.map((l) => `<option value="g${l.lot_id}">${esc(l.lot_no)}｜${esc(b.name)}｜剩 ${kg(l.closing_qty)} kg</option>`)).join('');
  const rOpts = roasted.data.flatMap((b) => b.lots.map((l) => `<option value="r${l.roasted_lot_id}">${esc(l.batch_no)}｜${esc(b.name)}｜${esc(l.roast_date)}｜剩 ${kg(l.closing_qty)} kg</option>`)).join('');
  $('#main').innerHTML = `
    <h2>批號追溯</h2>
    <div class="toolbar">
      <label>批號<select id="lot"><option value="">請選擇</option><optgroup label="生豆批號">${gOpts}</optgroup><optgroup label="熟豆批次（烘焙批次）">${rOpts}</optgroup></select></label>
      <span class="spacer"></span>
    </div>
    <p class="hint">生豆批號：進貨來源 → 用在哪些烘焙批次 → 熟豆賣給哪些客戶。熟豆批次：用了哪些生豆（來自哪個供應商）→ 賣給哪些客戶。可用於品質問題追查或回收通知。</p>
    <div id="out"></div>`;
  const outTable = (rows) => (rows.length ? `<div class="table-wrap"><table><thead><tr><th>日期</th><th>類型</th><th>單號</th><th>客戶</th><th class="num">kg</th></tr></thead><tbody>
    ${rows.map((o) => `<tr><td>${esc(o.movement_date.slice(0, 10))}</td><td>${esc(o.movement_type)}</td><td>${esc(o.doc_no)}</td><td>${esc(o.customer_name)}</td>
      <td class="num ${o.qty > 0 ? 'up' : 'down'}">${o.qty > 0 ? '+' : ''}${kg(o.qty)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">尚無出庫紀錄。</p>');
  $('#lot').onchange = async () => {
    const v = $('#lot').value;
    if (!v) { $('#out').innerHTML = ''; return; }
    try {
      const d = await api('/reports/trace' + qs(v[0] === 'g' ? { lot_id: v.slice(1) } : { roasted_lot_id: v.slice(1) }));
      if (d.type === 'green') {
        const l = d.lot;
        $('#out').innerHTML = `
          <div class="stats">${statCards([['生豆批號', esc(l.lot_no)], ['品項', esc(l.bean_name)], ['來源', l.purchase_no ? `${esc(l.supplier_name)}（${esc(l.purchase_no)}）` : '期初庫存'], ['入庫', `${esc(l.received_date)}／${kg(l.initial_kg)} kg`], ['目前剩餘', kg(l.current_kg) + ' kg'], ['出貨客戶數', d.customers.length]])}</div>
          ${d.customers.length ? `<p class="hint">曾收到這批豆子的客戶：${d.customers.map(esc).join('、')}</p>` : ''}
          ${d.batches.map((b) => `<div class="section-title">烘焙批次 ${esc(b.batch_no)}（${esc(b.roast_date)}，${esc(b.roasted_bean_name)}）</div>
            <p class="hint">投入本批號 ${kg(b.input_kg)} kg，佔該批次 ${pct(b.share)}；產出 ${kg(b.output_kg)} kg，失重率 ${pct(b.loss_rate)}，熟豆剩 ${kg(b.current_kg)} kg</p>
            <div class="card">${outTable(b.outflows)}</div>`).join('') || '<p class="hint">這批生豆還沒有烘焙紀錄。</p>'}
          ${d.movements.length > 1 ? `<div class="section-title">生豆其他異動</div><div class="card"><div class="table-wrap"><table><thead><tr><th>日期</th><th>類型</th><th class="num">kg</th><th>備註</th></tr></thead><tbody>
            ${d.movements.map((m) => `<tr><td>${esc(m.movement_date.slice(0, 10))}</td><td>${esc(m.movement_type)}</td><td class="num ${m.qty > 0 ? 'up' : 'down'}">${kg(m.qty)}</td><td>${esc(m.note)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}`;
      } else {
        const l = d.lot;
        $('#out').innerHTML = `
          <div class="stats">${statCards([['熟豆批次', esc(l.batch_no)], ['熟豆品項', esc(l.roasted_bean_name)], ['烘焙日', esc(l.roast_date)], ['產出', kg(l.output_kg) + ' kg'], ['失重率', pct(l.loss_rate)], ['目前剩餘', kg(l.current_kg) + ' kg']])}</div>
          <div class="section-title">投入生豆</div><div class="card"><div class="table-wrap"><table><thead><tr><th>生豆批號</th><th>品項</th><th>來源</th><th>入庫日</th><th class="num">投入 kg</th></tr></thead><tbody>
            ${d.inputs.map((i) => `<tr><td>${esc(i.lot_no)}</td><td>${esc(i.bean_name)}</td><td>${i.purchase_no ? `${esc(i.supplier_name)}（${esc(i.purchase_no)}）` : '期初庫存'}</td><td>${esc(i.received_date)}</td><td class="num">${kg(i.input_kg)}</td></tr>`).join('')}</tbody></table></div></div>
          <div class="section-title">出庫紀錄${d.customers.length ? `（客戶：${d.customers.map(esc).join('、')}）` : ''}</div><div class="card">${outTable(d.outflows)}</div>`;
      }
    } catch (e) { fail(e); }
  };
}

// ---------------------------------------------------------------- 報表：庫存現況
async function pageStockNow() {
  $('#main').innerHTML = `
    <h2>庫存現況</h2>
    <div class="toolbar"><label>截止日<input type="date" id="asof" value="${today()}"></label><button id="search">查詢</button><span class="spacer"></span></div>
    <p class="hint">截止日當天結束時的生豆、熟豆、包材數量與金額（依各批號成本；包材依進貨成本）。</p>
    <div class="stats" id="stats"></div>
    <div class="section-title">生豆</div><div class="card"><div class="table-wrap" id="g"></div></div>
    <div class="section-title">熟豆</div><div class="card"><div class="table-wrap" id="r"></div></div>
    <div class="section-title">包材</div><div class="card"><div class="table-wrap" id="p"></div></div>`;
  const load = async () => {
    try {
      const to = $('#asof').value;
      const [g, r, p] = await Promise.all([api('/inventory/green-beans' + qs({ to })), api('/inventory/roasted' + qs({ to })), api('/inventory/packaging' + qs({ to }))]);
      const tbl = (rows, unit, low) => (rows.length ? `<table><thead><tr><th>品項</th><th class="num">數量（${unit}）</th><th class="num">金額</th><th class="num">平均成本</th><th>狀態</th></tr></thead><tbody>
        ${rows.map((x) => `<tr><td>${esc(x.name)}</td><td class="num">${unit === 'kg' ? kg(x.closing_qty) : fmt(x.closing_qty)}</td><td class="num">${money(x.closing_amount)}</td>
          <td class="num">${x.closing_qty > 0 ? fmt(x.closing_amount / x.closing_qty, 2) : ''}</td><td>${low(x) ? '<span class="tag warn">低於安全庫存</span>' : ''}</td></tr>`).join('')}
        <tr class="total"><td>合計</td><td></td><td class="num">${money(rows.reduce((s, x) => s + x.closing_amount, 0))}</td><td></td><td></td></tr></tbody></table>` : '<div class="empty">沒有庫存</div>');
      const gr = g.data.filter((x) => Math.abs(x.closing_qty) > 0.0005);
      const rr = r.data.filter((x) => Math.abs(x.closing_qty) > 0.0005);
      const pr = p.data.filter((x) => Math.abs(x.closing_qty) > 0.0005);
      const sum = (rows) => rows.reduce((s, x) => s + x.closing_amount, 0);
      $('#stats').innerHTML = statCards([['生豆', `${kg(gr.reduce((s, x) => s + x.closing_qty, 0))} kg／${money(sum(gr))}`], ['熟豆', `${kg(rr.reduce((s, x) => s + x.closing_qty, 0))} kg／${money(sum(rr))}`], ['包材', money(sum(pr))], ['庫存總額', money(sum(gr) + sum(rr) + sum(pr))]]);
      $('#g').innerHTML = tbl(gr, 'kg', (x) => x.low_stock);
      $('#r').innerHTML = tbl(rr, 'kg', (x) => x.low_stock);
      $('#p').innerHTML = tbl(pr, '單位', (x) => x.low_stock);
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  load();
}

// ---------------------------------------------------------------- 報表：加工成本
async function pageProcessing() {
  $('#main').innerHTML = `
    <h2>加工成本（費用攤提）</h2>
    <div class="toolbar">
      <label>起日<input type="date" id="from" value="${today().slice(0, 4)}-01-01"></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <button id="search">查詢</button><span class="spacer"></span>
    </div>
    <p class="hint">每月勾選「攤入烘焙成本」的費用（例：瓦斯、電費）÷ 當月烘焙產出 kg = 當月每 kg 加工成本。毛利分析會用出貨熟豆的烘焙月份套用這個費率。
      當月沒有烘焙產出時費用無法攤提，列為「未攤提」。要攤入哪些費用，請在費用支出或費用類別勾選「攤入烘焙」。</p>
    <div class="stats" id="stats"></div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;
  const load = async () => {
    try {
      const { data, total } = await api('/reports/processing' + qs({ from: $('#from').value, to: $('#to').value }));
      $('#stats').innerHTML = statCards([['攤入烘焙費用', money(total.expense)], ['烘焙產出 kg', kg(total.output_kg)], ['平均每 kg', total.output_kg ? fmt(total.expense / total.output_kg, 2) : '—'], ['未攤提', money(total.unallocated)]]);
      $('#list').innerHTML = data.length ? `<table><thead><tr><th>月份</th><th class="num">費用筆數</th><th class="num">攤入烘焙費用</th><th class="num">烘焙批次</th><th class="num">產出 kg</th><th class="num">每 kg 加工成本</th><th>狀態</th></tr></thead><tbody>
        ${data.map((r) => `<tr><td>${esc(r.ym)}</td><td class="num">${r.expense_count}</td><td class="num">${money(r.expense)}</td><td class="num">${r.batches}</td><td class="num">${kg(r.output_kg)}</td>
          <td class="num"><b>${r.rate === null ? '—' : fmt(r.rate, 2)}</b></td><td>${r.unallocated ? `<span class="tag warn">未攤提 ${money(r.unallocated)}</span>` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">此區間沒有資料</div>';
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  load();
}

// ---------------------------------------------------------------- 銀行代碼
async function pageBankCodes() {
  $('#main').innerHTML = `
    <h2>銀行代碼</h2>
    <div class="toolbar">
      <label>搜尋<input id="q" placeholder="代號或名稱"></label>
      <label>類別<select id="cat"><option value="">全部</option>${plainOpts(['本國銀行', '郵局', '外商銀行', '信用合作社', '農漁會', '其他'])}</select></label>
      <label>狀態<select id="active"><option value="">全部</option><option value="1">啟用中</option><option value="0">已停用</option></select></label>
      <button id="search">查詢</button><span class="spacer"></span>
      <button id="restore">補回內建代號</button><button id="add" class="primary">＋ 新增代號</button>
    </div>
    <p class="hint">跨行匯款用的 3 碼銀行（總機構）代號，已內建本國銀行、郵局、外商銀行、信用合作社與農漁會資訊中心。銀行合併、更名時可直接修改名稱或停用；個別農漁會、找不到的機構請自行新增。
      內建代號不能刪除；已有帳戶使用的代號也不能刪除，請改停用。分行代號（4 碼）在各帳戶上自行填寫。</p>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;
  const load = async () => {
    try {
      const { data } = await api('/bank-codes' + qs({ q: $('#q').value.trim(), category: $('#cat').value, active: $('#active').value }));
      $('#list').innerHTML = data.length ? `<table><thead><tr><th>代號</th><th>名稱</th><th>類別</th><th class="num">使用帳戶</th><th>來源</th><th>狀態</th><th>備註</th></tr></thead><tbody>
        ${data.map((c) => `<tr class="clickable ${c.is_active ? '' : 'inactive'}" data-code="${c.code}"><td><b>${c.code}</b></td><td>${esc(c.name)}</td><td>${esc(c.category)}</td><td class="num">${c.used || ''}</td>
          <td>${c.is_builtin ? '內建' : '自訂'}</td><td>${c.is_active ? '<span class="tag">啟用</span>' : '<span class="tag warn">停用</span>'}</td><td>${esc(c.note)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">沒有資料</div>';
      $$('#list tr.clickable').forEach((tr) => tr.onclick = () => bankCodeForm(data.find((c) => c.code === tr.dataset.code), load));
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  $('#q').onkeydown = (e) => e.key === 'Enter' && load();
  $('#cat').onchange = load; $('#active').onchange = load;
  $('#add').onclick = () => bankCodeForm(null, load);
  $('#restore').onclick = async () => { try { const r = await api('/bank-codes/restore', { method: 'POST' }); toast(r.inserted ? `已補回 ${r.inserted} 個內建代號` : '內建代號都在，不需要補'); delete cache['bank-codes']; load(); } catch (e) { fail(e); } };
  load();
}
function bankCodeForm(c, reload) {
  const x = c || { category: '本國銀行', is_active: 1 };
  const box = openModal(`
    <h2>${c ? `銀行代號 ${esc(c.code)}` : '新增銀行代號'}</h2>
    <form id="f"><div class="form-grid">
      <label>代號（3 碼）*<input name="code" required pattern="\\d{3}" maxlength="3" inputmode="numeric" value="${esc(x.code)}" ${c ? 'disabled' : ''}></label>
      <label>名稱 *<input name="name" required value="${esc(x.name)}"></label>
      <label>類別<select name="category">${plainOpts(['本國銀行', '郵局', '外商銀行', '信用合作社', '農漁會', '其他'], x.category)}</select></label>
      <label>狀態<select name="is_active"><option value="1" ${x.is_active ? 'selected' : ''}>啟用</option><option value="0" ${x.is_active ? '' : 'selected'}>停用</option></select></label>
      <label class="full">備註<input name="note" value="${esc(x.note)}" placeholder="例：2024 年併入某銀行"></label>
    </div>
    <div class="form-actions">${c && !c.is_builtin ? '<button type="button" class="danger" id="del">刪除</button>' : ''}<span class="spacer"></span><button type="button" id="cancel">取消</button><button class="primary">存檔</button></div></form>`);
  const f = $('#f', box);
  $('#cancel', box).onclick = closeModal;
  f.onsubmit = async (e) => {
    e.preventDefault();
    try { await api(c ? `/bank-codes/${c.code}` : '/bank-codes', { method: c ? 'PUT' : 'POST', body: Object.fromEntries(new FormData(f)) }); delete cache['bank-codes']; closeModal(); toast('已存檔'); reload(); } catch (err) { fail(err); }
  };
  if ($('#del', box)) $('#del', box).onclick = async () => {
    if (!confirm(`刪除代號 ${c.code}？`)) return;
    try { await api(`/bank-codes/${c.code}`, { method: 'DELETE' }); delete cache['bank-codes']; closeModal(); toast('已刪除'); reload(); } catch (err) { fail(err); }
  };
}

// ---------------------------------------------------------------- 銀行對帳
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  const delim = (text.split('\n')[0].match(/\t/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  const utf = new TextDecoder('utf-8').decode(buf);
  if (!utf.includes('�')) return utf.replace(/^﻿/, '');
  try { return new TextDecoder('big5').decode(buf); } catch { return utf; } // 台灣網銀常見 Big5
}
/** 日期：2026/11/05、2026-11-05、20261105、115/11/05（民國） */
function parseDate(s) {
  const t = String(s || '').trim().replace(/\s.*$/, '');
  let m = t.match(/^(\d{2,4})[/.\-年](\d{1,2})[/.\-月](\d{1,2})/) || t.match(/^(\d{4})(\d{2})(\d{2})$/) || t.match(/^(\d{3})(\d{2})(\d{2})$/);
  if (!m) return null;
  let y = Number(m[1]);
  if (y < 1000) y += 1911;
  const d = `${y}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}
const parseNum = (s) => {
  const t = String(s ?? '').replace(/[,\s$元NT]/g, '');
  if (!t || t === '-') return null;
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t);
  const n = Number(t.replace(/[()+-]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
};

async function pageReconcile() {
  const accounts = await lookup('bank-accounts', true);
  $('#main').innerHTML = `
    <h2>銀行對帳</h2>
    <div class="acct-strip" id="ovw"></div>
    <div class="toolbar">
      <label>帳戶<select id="acc">${options(accounts.filter((a) => a.is_active), 'account_id', null, { blank: '請選擇', label: (a) => a.account_name })}</select></label>
      <label>起日<input type="date" id="from" value="${monthStart()}"></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <button id="search">查詢</button><span class="spacer"></span>
      <button id="openingBtn">期初設定</button>
      <button id="addLine">＋ 手動輸入明細</button>
      <button id="upload" class="primary">⬆ 匯入對帳單 CSV</button><input type="file" id="file" accept=".csv,.txt,.tsv" hidden>
    </div>
    <p class="hint">從網銀下載交易明細 CSV 匯入（支援 UTF-8 與 Big5、民國年日期），第一次匯入時設定欄位對應，之後同一帳戶會自動套用。系統會依「同方向、同金額、日期相差 5 天內」建議配對，確認後兩邊都標記已對帳；
      已對帳的收支不能再改金額、日期或刪除。對帳單上有、系統沒有的明細可直接「建立收支」。現金等沒有對帳單的帳戶，可在右側直接「標記已核對」。
      沒有 CSV 時可「手動輸入明細」照存摺逐筆登打（餘額必填）。「期初設定」可改帳戶期初（系統餘額起點）和對帳起點（存摺某日的餘額），系統會逐日檢查存摺餘額是否連續，不連續代表可能漏登。</p>
    <div class="stats" id="stats"></div>
    <div id="work"></div>`;
  const loadOverview = async () => {
    const { data } = await api('/reconcile');
    $('#ovw').innerHTML = data.map((a) => `<div class="acct" data-id="${a.account_id}"><div class="k">${esc(a.account_name)}</div>
      <div class="v" style="font-size:14px">${a.open_lines ? `<span class="down">${a.open_lines} 筆待對</span>` : '✓'}　未核收支 ${a.open_txns}</div>
      <div class="k">對帳至 ${esc(a.last_reconciled_date || '—')}</div></div>`).join('');
    $$('#ovw .acct').forEach((el) => el.onclick = () => { $('#acc').value = el.dataset.id; load(); });
  };
  const load = async () => {
    loadOverview().catch(() => {});
    const aid = $('#acc').value;
    if (!aid) { $('#work').innerHTML = '<div class="empty">請選擇帳戶</div>'; $('#stats').innerHTML = ''; return; }
    lastData = null;
    try {
      const d = await api(`/reconcile/${aid}` + qs({ from: $('#from').value, to: $('#to').value }));
      lastData = d;
      const sug = new Map(d.suggestions.map((s) => [s.line_id, s.txn_id]));
      const txnById = new Map(d.txns.map((t) => [t.txn_id, t]));
      const sugTxn = new Set(d.suggestions.map((s) => s.txn_id));
      $('#stats').innerHTML = statCards([['對帳單筆數', fmt(d.summary.lines)], ['已對帳', fmt(d.summary.matched), 'up'], ['待對帳', fmt(d.summary.open_lines), d.summary.open_lines ? 'down' : ''], ['系統未核收支', fmt(d.summary.open_txns)],
        ...(d.check ? [[`餘額核對（${d.check.date}）`, `對帳單 ${money(d.check.statement_balance)}／系統 ${money(d.check.system_balance)}${d.check.diff ? `<br><span class="down">差 ${money(d.check.diff)}</span>` : ' ✓'}`]] : [])]);
      const amt = (dir, a) => (dir === DIR_IN ? `<span class="up">+${money(a)}</span>` : `<span class="down">−${money(a)}</span>`);
      const acc = d.account;
      const oc = d.opening_check;
      $('#work').innerHTML = `
        <div class="card"><div class="form-grid" style="margin:0">
          <div><div class="hint">帳戶期初（系統餘額起點）</div><b>${acc.opening_date ? esc(acc.opening_date) : '未設定日期'}　${money(acc.opening_balance)}</b></div>
          <div><div class="hint">對帳起點（存摺餘額）</div><b>${d.opening ? `${esc(d.opening.open_date)}　${money(d.opening.open_balance)}` : '未設定'}</b>
            ${oc ? (oc.diff ? `<div class="down">與系統同日餘額 ${money(oc.system_balance)} 差 ${money(oc.diff)}</div>` : '<div class="up">與系統同日餘額相符 ✓</div>') : ''}</div>
          <div><div class="hint">存摺餘額連續性</div><b>${d.all_breaks ? `<span class="down">${d.all_breaks} 天不連續</span>` : d.lines.some((l) => l.day_ok !== null) ? '<span class="up">連續 ✓</span>' : '—'}</b></div>
        </div>
        ${d.breaks.length ? `<p class="hint down">${d.breaks.map((x) => `${esc(x.date)}：依前一日餘額推算應為 ${money(x.expected)}，存摺為 ${money(x.statement)}（差 ${money(x.diff)}）`).join('<br>')}<br>可能漏登明細或餘額抄錯，請補登或修改。</p>` : ''}</div>
        <div class="section-title">對帳單明細 ${d.suggestions.length ? `<button type="button" id="acceptAll" class="primary">確認 ${d.suggestions.length} 筆建議配對</button>` : ''}</div>
        <div class="card"><div class="table-wrap">${d.lines.length ? `<table><thead><tr><th>日期</th><th>摘要</th><th>序號</th><th class="num">金額</th><th class="num">對帳單餘額</th><th>狀態／配對</th><th></th></tr></thead><tbody>
          ${d.lines.map((l) => {
            const s = sug.get(l.line_id);
            const st = l.status === '已對帳' ? `<span class="tag">已對帳 ${esc(l.matched_txn_no)}</span>` : l.status === '忽略' ? '<span class="tag">忽略</span>'
              : s ? `<span class="tag warn">建議：${esc(txnById.get(s).txn_no)} ${esc(txnById.get(s).txn_date)}</span>` : '<span class="tag warn">找不到對應收支</span>';
            const act = l.status === '已對帳' ? `<button type="button" class="link" data-unmatch="${l.line_id}">取消配對</button>`
              : l.status === '忽略' ? `<button type="button" class="link" data-unignore="${l.line_id}">取消忽略</button>`
              : `${s ? `<button type="button" class="link" data-accept="${l.line_id}">確認</button>　` : ''}<button type="button" class="link" data-pick="${l.line_id}">手動配對</button>　<button type="button" class="link" data-create="${l.line_id}">建立收支</button>　<button type="button" class="link" data-ignore="${l.line_id}">忽略</button>`;
            const balTag = l.day_ok === false ? ` <span class="tag warn" title="依前一日餘額推算當日應為 ${money(l.day_expected)}">不連續</span>` : '';
            return `<tr><td>${esc(l.txn_date)}${l.before_opening ? ' <span class="hint">起點前</span>' : ''}</td><td>${esc(l.description)}${l.import_batch === '手動輸入' ? ' <span class="hint">手動</span>' : ''}</td><td>${esc(l.ref_no)}</td><td class="num">${amt(l.direction, l.amount)}</td><td class="num">${l.balance === null ? '' : money(l.balance)}${balTag}</td><td>${st}</td><td><button type="button" class="link" data-edit="${l.line_id}">修改</button>　${act}</td></tr>`;
          }).join('')}</tbody></table>` : '<div class="empty">這段期間還沒有匯入對帳單</div>'}</div></div>
        <div class="section-title">系統收支（未核對） ${d.txns.filter((t) => !t.reconciled).length ? '<button type="button" id="markAll">全部標記已核對</button>' : ''}</div>
        <div class="card"><div class="table-wrap">${d.txns.length ? `<table><thead><tr><th>日期</th><th>編號</th><th>類別</th><th>對象／摘要</th><th class="num">金額</th><th>狀態</th><th></th></tr></thead><tbody>
          ${d.txns.map((t) => `<tr><td>${esc(t.txn_date)}</td><td>${esc(t.txn_no)}</td><td>${esc(t.category)}</td><td>${esc([t.counterparty, t.description].filter(Boolean).join('／'))}</td><td class="num">${amt(t.direction, t.amount)}</td>
            <td>${t.reconciled ? '<span class="tag">已核對</span>' : sugTxn.has(t.txn_id) ? '<span class="tag warn">有建議配對</span>' : '<span class="tag warn">對帳單上找不到</span>'}</td>
            <td>${t.reconciled ? `<button type="button" class="link" data-tunmatch="${t.txn_id}">取消核對</button>` : `<button type="button" class="link" data-mark="${t.txn_id}">標記已核對</button>`}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">沒有收支</div>'}</div></div>
        ${d.lines.length ? '<p class="hint"><button type="button" class="link" id="delOpen">刪除這段期間未對帳的對帳單明細</button>（匯入錯檔時使用）</p>' : ''}`;
      const post = async (sub, body, msg) => { try { await api(`/reconcile/${aid}/${sub}`, { method: 'POST', body }); if (msg) toast(msg); load(); } catch (e) { fail(e); } };
      if ($('#acceptAll')) $('#acceptAll').onclick = () => post('match', { pairs: d.suggestions.map((s) => ({ line_id: s.line_id, txn_id: s.txn_id })) }, `已對帳 ${d.suggestions.length} 筆`);
      $$('[data-accept]').forEach((b) => b.onclick = () => post('match', { pairs: [{ line_id: Number(b.dataset.accept), txn_id: sug.get(Number(b.dataset.accept)) }] }, '已對帳'));
      $$('[data-unmatch]').forEach((b) => b.onclick = () => post('unmatch', { line_id: Number(b.dataset.unmatch) }, '已取消配對'));
      $$('[data-tunmatch]').forEach((b) => b.onclick = () => post('unmatch', { txn_id: Number(b.dataset.tunmatch) }, '已取消核對'));
      $$('[data-ignore]').forEach((b) => b.onclick = () => post('ignore', { line_id: Number(b.dataset.ignore) }));
      $$('[data-unignore]').forEach((b) => b.onclick = () => post('ignore', { line_id: Number(b.dataset.unignore), ignore: false }));
      $$('[data-mark]').forEach((b) => b.onclick = () => post('mark', { txn_ids: [Number(b.dataset.mark)] }, '已標記'));
      if ($('#markAll')) $('#markAll').onclick = () => confirm('把清單上所有未核對的收支都標記為已核對？') && post('mark', { txn_ids: d.txns.filter((t) => !t.reconciled).map((t) => t.txn_id) }, '已標記');
      $$('[data-pick]').forEach((b) => b.onclick = () => {
        const l = d.lines.find((x) => x.line_id === Number(b.dataset.pick));
        const cands = d.txns.filter((t) => !t.reconciled && t.direction === l.direction);
        const box = openModal(`<h2>手動配對</h2><p class="hint">對帳單：${esc(l.txn_date)}　${esc(l.description || '')}　${l.direction} ${money(l.amount)}（金額必須相同）</p>
          <form id="f"><div class="form-grid"><label class="full">系統收支<select name="txn" required><option value="">請選擇</option>${cands.map((t) => `<option value="${t.txn_id}" ${Math.abs(t.amount - l.amount) < 0.005 ? '' : 'disabled'}>${esc(t.txn_date)}｜${esc(t.txn_no)}｜${money(t.amount)}｜${esc(t.counterparty || t.description || '')}</option>`).join('')}</select></label></div>
          <div class="form-actions"><span class="spacer"></span><button type="button" id="cancel">取消</button><button class="primary">配對</button></div></form>`);
        $('#cancel', box).onclick = closeModal;
        $('#f', box).onsubmit = (e) => { e.preventDefault(); closeModal(); post('match', { pairs: [{ line_id: l.line_id, txn_id: Number($('#f', box).txn.value) }] }, '已對帳'); };
      });
      $$('[data-create]').forEach((b) => b.onclick = () => {
        const l = d.lines.find((x) => x.line_id === Number(b.dataset.create));
        txnForm(l.direction, null, load, { account_id: Number(aid), txn_date: l.txn_date, amount: l.amount, description: l.description, bank_ref_no: l.ref_no, category: l.direction === DIR_IN ? '其他' : '其他' });
      });
      $$('[data-edit]').forEach((b) => b.onclick = () => stmtLineForm(Number(aid), d.lines.find((x) => x.line_id === Number(b.dataset.edit)), load));
      if ($('#delOpen')) $('#delOpen').onclick = async () => {
        if (!confirm('刪除這個帳戶所有「未對帳／忽略」的對帳單明細？（已對帳的不會刪）')) return;
        try { const r = await api(`/reconcile/${aid}/lines`, { method: 'DELETE' }); toast(`已刪除 ${r.deleted} 筆`); load(); } catch (e) { fail(e); }
      };
    } catch (e) { fail(e); }
  };
  let lastData = null;
  $('#search').onclick = load;
  $('#acc').onchange = load;
  $('#addLine').onclick = () => { if (!$('#acc').value) return toast('請先選擇帳戶', true); stmtLineForm(Number($('#acc').value), null, load); };
  $('#openingBtn').onclick = () => { if (!$('#acc').value) return toast('請先選擇帳戶', true); bankOpeningForm(Number($("#acc").value), lastData, load); };
  $('#upload').onclick = () => { if (!$('#acc').value) return toast('請先選擇帳戶', true); $('#file').click(); };
  $('#file').onchange = async () => {
    const file = $('#file').files[0];
    $('#file').value = '';
    if (!file) return;
    try { csvMappingForm(Number($('#acc').value), parseCsv(await readTextFile(file)), file.name, load); } catch (e) { fail(e); }
  };
  load();
}

/** 手動輸入／修改對帳單明細 */
function stmtLineForm(aid, l, reload) {
  const x = l || { txn_date: today(), direction: DIR_IN };
  const locked = l?.status === '已對帳';
  const needBal = !l || l.import_batch === '手動輸入' || l.balance !== null;
  const dis = locked ? 'disabled' : '';
  const box = openModal(`
    <h2>${l ? '修改對帳單明細' : '手動輸入對帳單明細'}</h2>
    ${locked ? `<div class="notice">已對帳（${esc(l.matched_txn_no || '')}），只能改摘要、序號、餘額；要改日期或金額請先「取消配對」。</div>` : ''}
    <form id="f"><div class="form-grid">
      <label>日期 *<input type="date" name="txn_date" required value="${esc(x.txn_date)}" ${dis}></label>
      <label>存入／支出 *<select name="direction" ${dis}><option value="${DIR_IN}" ${x.direction === DIR_IN ? 'selected' : ''}>存入（入帳）</option><option value="${DIR_OUT}" ${x.direction === DIR_OUT ? 'selected' : ''}>支出（出帳）</option></select></label>
      <label>金額 *<input type="number" name="amount" step="0.01" min="0.01" required value="${esc(x.amount ?? '')}" ${dis}></label>
      <label>存摺餘額${needBal ? ' *' : ''}<input type="number" name="balance" step="0.01" ${needBal ? 'required' : ''} value="${esc(x.balance ?? '')}"></label>
      <label>摘要<input name="description" value="${esc(x.description)}"></label>
      <label>交易序號<input name="ref_no" value="${esc(x.ref_no)}"></label>
    </div>
    <p class="hint" id="balHint"></p>
    <div class="form-actions">${l && !locked ? '<button type="button" class="danger" id="del">刪除</button>' : ''}<span class="spacer"></span><button type="button" id="cancel">取消</button>
      ${l ? '' : '<button type="button" id="saveNext">存檔並繼續輸入</button>'}<button class="primary">存檔</button></div></form>`);
  const f = $('#f', box);
  $('#cancel', box).onclick = closeModal;
  const body = () => ({ ...Object.fromEntries(new FormData(f)), ...(l ? { line_id: l.line_id } : {}), ...(locked ? {} : {}) });
  const save = async (next) => {
    if (!f.reportValidity()) return;
    try {
      await api(`/reconcile/${aid}/lines`, { method: l ? 'PUT' : 'POST', body: body() });
      toast('已存檔'); reload();
      if (next) { // 保留日期，下一筆的餘額從這筆推算
        const bal = Number(f.balance.value);
        f.amount.value = ''; f.description.value = ''; f.ref_no.value = ''; f.balance.value = '';
        $('#balHint', box).textContent = `上一筆存摺餘額 ${money(bal)}`;
        f.dataset.prev = bal;
        f.amount.focus();
      } else closeModal();
    } catch (e) { fail(e); }
  };
  // 輸入金額時，依上一筆餘額提示本筆應有餘額
  const hint = () => {
    if (!f.dataset.prev || !f.amount.value) return;
    const exp = Number(f.dataset.prev) + (f.direction.value === DIR_IN ? 1 : -1) * Number(f.amount.value);
    $('#balHint', box).textContent = `上一筆存摺餘額 ${money(Number(f.dataset.prev))}，依此推算本筆餘額 ${money(exp)}`;
    if (!f.balance.value) f.balance.placeholder = r2(exp);
  };
  f.amount.oninput = hint; f.direction.onchange = hint;
  f.onsubmit = (e) => { e.preventDefault(); save(false); };
  if ($('#saveNext', box)) $('#saveNext', box).onclick = () => save(true);
  if ($('#del', box)) $('#del', box).onclick = async () => {
    if (!confirm('刪除這筆對帳單明細？')) return;
    try { await api(`/reconcile/${aid}/lines?line_id=${l.line_id}`, { method: 'DELETE' }); closeModal(); toast('已刪除'); reload(); } catch (e) { fail(e); }
  };
}

/** 期初設定：帳戶期初（系統）＋ 對帳起點（存摺） */
async function bankOpeningForm(aid, d, reload) {
  try {
    const acc = d?.account || (await api(`/reconcile/${aid}` + qs({ from: today(), to: today() }))).account;
    const op = (await api(`/reconcile/${aid}/opening`)).data;
    const box = openModal(`
      <h2>期初設定：${esc(acc.account_name)}</h2>
      <form id="fa">
        <div class="section-title">帳戶期初（系統餘額起點）</div>
        <p class="hint">與「主檔 → 銀行帳戶」的期初餘額、期初日期是同一組資料。系統帳戶餘額 = 期初餘額 ＋ 期初日之後的收支；期初日期不能晚於最早一筆收支。</p>
        <div class="form-grid">
          <label>期初日期<input type="date" name="opening_date" value="${esc(acc.opening_date || '')}"></label>
          <label>期初餘額 *<input type="number" step="0.01" min="0" name="opening_balance" required value="${esc(acc.opening_balance ?? 0)}"></label>
        </div>
        <div class="form-actions"><span class="spacer"></span><button class="primary">儲存帳戶期初</button></div>
      </form>
      <form id="fs">
        <div class="section-title">對帳起點（存摺餘額）</div>
        <p class="hint">開始對帳那天「結束時」存摺上的餘額。之後的對帳單明細會從這裡逐日檢查餘額是否連續；系統也會比對同一天的系統餘額，有差額代表起點之前還有收支沒登錄或沒對清。</p>
        <div class="form-grid">
          <label>起點日期 *<input type="date" name="open_date" required value="${esc(op?.open_date || acc.opening_date || '')}"></label>
          <label>當日存摺餘額 *<input type="number" step="0.01" name="open_balance" required value="${esc(op?.open_balance ?? '')}"></label>
          <label class="full">備註<input name="note" value="${esc(op?.note || '')}"></label>
        </div>
        ${op ? `<p class="hint">最後修改：${esc(op.updated_at)} ${esc(op.updated_by || '')}</p>` : ''}
        <div class="form-actions">${op ? '<button type="button" class="danger" id="delOp">清除對帳起點</button>' : ''}<span class="spacer"></span><button type="button" id="cancel">關閉</button><button class="primary">儲存對帳起點</button></div>
      </form>`);
    $('#cancel', box).onclick = closeModal;
    $('#fa', box).onsubmit = async (e) => {
      e.preventDefault();
      try { await api(`/reconcile/${aid}/account-opening`, { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) }); delete cache['bank-accounts']; toast('帳戶期初已儲存'); reload(); } catch (err) { fail(err); }
    };
    $('#fs', box).onsubmit = async (e) => {
      e.preventDefault();
      try { await api(`/reconcile/${aid}/opening`, { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) }); closeModal(); toast('對帳起點已儲存'); reload(); } catch (err) { fail(err); }
    };
    if ($('#delOp', box)) $('#delOp', box).onclick = async () => {
      if (!confirm('清除對帳起點？（不影響對帳單明細與收支）')) return;
      try { await api(`/reconcile/${aid}/opening`, { method: 'DELETE' }); closeModal(); toast('已清除'); reload(); } catch (err) { fail(err); }
    };
  } catch (e) { fail(e); }
}

async function csvMappingForm(aid, rows, filename, reload) {
  if (!rows.length) return toast('檔案是空的', true);
  const saved = (await api(`/reconcile/${aid}/profile`)).data || {};
  const width = Math.max(...rows.slice(0, 20).map((r) => r.length));
  // 自動猜：找含「日期」的列當標題列
  const guessHeader = rows.findIndex((r) => r.some((c) => /日期|交易日/.test(c)));
  const m = { header: saved.header ?? Math.max(0, guessHeader) + (guessHeader >= 0 ? 1 : 0), mode: saved.mode || 'split', ...saved };
  const hdr = rows[Math.max(0, m.header - 1)] || [];
  const guess = (re) => { const i = hdr.findIndex((c) => re.test(c)); return i >= 0 ? i : ''; };
  m.date ??= guess(/交易日|日期/); m.in ??= guess(/存入|收入|轉入|貸方/); m.out ??= guess(/支出|提款|轉出|借方/); m.amount ??= guess(/^金額|交易金額/);
  m.desc ??= guess(/摘要|說明|備註|附言/); m.ref ??= guess(/序號|交易序|流水|代號/); m.balance ??= guess(/餘額|結餘/);
  const colOpts = (sel) => '<option value="">（無）</option>' + Array.from({ length: width }, (_, i) => `<option value="${i}" ${String(sel) === String(i) ? 'selected' : ''}>第 ${i + 1} 欄${hdr[i] ? `：${esc(hdr[i].slice(0, 12))}` : ''}</option>`).join('');
  const box = openModal(`
    <h2>匯入對帳單：${esc(filename)}</h2>
    <form id="f">
      <div class="form-grid">
        <label>略過前幾列（標題）<input name="header" type="number" min="0" value="${esc(m.header)}"></label>
        <label>日期欄 *<select name="date" required>${colOpts(m.date)}</select></label>
        <label>金額格式<select name="mode"><option value="split" ${m.mode === 'split' ? 'selected' : ''}>存入、支出分兩欄</option><option value="signed" ${m.mode === 'signed' ? 'selected' : ''}>單一金額欄（負數 = 支出）</option></select></label>
        <label data-m="split">存入欄<select name="in">${colOpts(m.in)}</select></label>
        <label data-m="split">支出欄<select name="out">${colOpts(m.out)}</select></label>
        <label data-m="signed">金額欄<select name="amount">${colOpts(m.amount)}</select></label>
        <label>摘要欄<select name="desc">${colOpts(m.desc)}</select></label>
        <label>交易序號欄<select name="ref">${colOpts(m.ref)}</select></label>
        <label>餘額欄<select name="balance">${colOpts(m.balance)}</select></label>
      </div>
      <div class="section-title">預覽（前 8 筆轉換結果）</div>
      <div class="table-wrap" id="pv"></div>
      <p class="hint">設定會存起來，下次這個帳戶匯入時自動套用。重複匯入同一筆明細會自動略過。</p>
      <div class="form-actions"><span class="spacer"></span><button type="button" id="cancel">取消</button><button class="primary">匯入</button></div>
    </form>`, true);
  const f = $('#f', box);
  const readMap = () => Object.fromEntries(['header', 'date', 'mode', 'in', 'out', 'amount', 'desc', 'ref', 'balance'].map((k) => [k, f[k].value === '' ? '' : k === 'mode' ? f[k].value : Number(f[k].value)]));
  const convert = (mp) => rows.slice(mp.header || 0).map((r, i) => {
    const date = parseDate(r[mp.date]);
    let amount = null; let dir = null;
    if (mp.mode === 'split') {
      const a = mp.in === '' ? null : parseNum(r[mp.in]); const b = mp.out === '' ? null : parseNum(r[mp.out]);
      if (a) { amount = Math.abs(a); dir = DIR_IN; } else if (b) { amount = Math.abs(b); dir = DIR_OUT; }
    } else {
      const a = mp.amount === '' ? null : parseNum(r[mp.amount]);
      if (a) { amount = Math.abs(a); dir = a > 0 ? DIR_IN : DIR_OUT; }
    }
    return { row: i + 1 + (mp.header || 0), txn_date: date, direction: dir, amount, description: mp.desc === '' ? '' : (r[mp.desc] || '').trim(), ref_no: mp.ref === '' ? '' : (r[mp.ref] || '').trim(), balance: mp.balance === '' ? null : parseNum(r[mp.balance]) };
  });
  const preview = () => {
    const mp = readMap();
    $$('[data-m]', box).forEach((el) => (el.hidden = el.dataset.m !== mp.mode));
    const out = convert(mp);
    const ok = out.filter((x) => x.txn_date && x.amount);
    $('#pv', box).innerHTML = `<p class="hint">可匯入 ${ok.length} 筆，略過 ${out.length - ok.length} 列（日期或金額無法辨識，例如合計列）。</p>
      <table><thead><tr><th>列</th><th>日期</th><th class="num">金額</th><th>摘要</th><th>序號</th><th class="num">餘額</th></tr></thead><tbody>
      ${out.slice(0, 8).map((x) => `<tr><td>${x.row}</td><td>${x.txn_date ? esc(x.txn_date) : '<span class="tag warn">無法辨識</span>'}</td><td class="num">${x.amount ? (x.direction === DIR_IN ? `<span class="up">+${money(x.amount)}</span>` : `<span class="down">−${money(x.amount)}</span>`) : '<span class="tag warn">—</span>'}</td>
        <td>${esc(x.description)}</td><td>${esc(x.ref_no)}</td><td class="num">${x.balance === null ? '' : money(x.balance)}</td></tr>`).join('')}</tbody></table>`;
  };
  f.addEventListener('change', preview);
  f.header.oninput = preview;
  preview();
  $('#cancel', box).onclick = closeModal;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const mp = readMap();
    const lines = convert(mp).filter((x) => x.txn_date && x.amount).map(({ row, ...x }) => x);
    if (!lines.length) return toast('沒有可匯入的明細，請檢查欄位設定', true);
    try {
      await api(`/reconcile/${aid}/profile`, { method: 'PUT', body: { mapping: mp } });
      const r = await api(`/reconcile/${aid}/import`, { method: 'POST', body: { lines } });
      closeModal(); toast(`已匯入 ${r.inserted} 筆${r.skipped ? `，略過重複 ${r.skipped} 筆` : ''}`); reload();
    } catch (err) { fail(err); }
  };
}

// ---------------------------------------------------------------- 使用者
async function pageUsers() {
  $('#main').innerHTML = `
    <h2>使用者</h2>
    <div class="toolbar"><span class="spacer"></span><button id="add" class="primary">＋ 新增使用者</button></div>
    <p class="hint">登入由 Cloudflare Access 控管；這裡決定登入後的角色與權限。<b>新增使用者後，也要到 Cloudflare Zero Trust → Access → Applications 把對方的 email 加進允許名單</b>，對方才登得進來。至少保留一位管理者。</p>
    <div class="card"><div class="table-wrap" id="list"></div></div>
    <div class="section-title">角色權限</div>
    <div class="card"><div class="table-wrap" id="roles"></div></div>`;
  const load = async () => {
    try {
      const [{ data }, roles] = await Promise.all([api('/users'), api('/users/roles')]);
      $('#list').innerHTML = `<table><thead><tr><th>Email</th><th>名稱</th><th>角色</th><th>最後登入</th><th>狀態</th><th>備註</th></tr></thead><tbody>
        ${data.map((u) => `<tr class="clickable" data-id="${u.user_id}"><td>${esc(u.email)}${ME && u.email === ME.email ? '（你）' : ''}</td><td>${esc(u.name)}</td><td>${esc(u.role)}</td><td>${esc(u.last_login_at)}</td>
          <td>${u.is_active ? '<span class="tag">啟用</span>' : '<span class="tag warn">停用</span>'}</td><td>${esc(u.note)}</td></tr>`).join('')}</tbody></table>`;
      const mods = roles.modules;
      $('#roles').innerHTML = `<table><thead><tr><th>功能</th>${roles.data.map((r) => `<th>${esc(r.role)}</th>`).join('')}</tr></thead><tbody>
        ${Object.entries(mods).map(([k, label]) => `<tr><td>${esc(label)}</td>${roles.data.map((r) => `<td>${r.write.includes(k) ? '<span class="up">可修改</span>' : r.read.includes(k) ? '可查看' : '<span class="down">—</span>'}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      $$('#list tr.clickable').forEach((tr) => tr.onclick = () => userForm(data.find((u) => u.user_id === Number(tr.dataset.id)), load));
    } catch (e) { fail(e); }
  };
  $('#add').onclick = () => userForm(null, load);
  load();
}
function userForm(u, reload) {
  const x = u || { role: '門市', is_active: 1 };
  const box = openModal(`
    <h2>${u ? '修改使用者' : '新增使用者'}</h2>
    <form id="f"><div class="form-grid">
      <label>Email（Google 帳號）*<input name="email" type="email" required value="${esc(x.email)}"></label>
      <label>名稱<input name="name" value="${esc(x.name)}"></label>
      <label>角色<select name="role">${plainOpts(['管理者', '烘豆師', '門市', '會計'], x.role)}</select></label>
      <label>狀態<select name="is_active"><option value="1" ${x.is_active ? 'selected' : ''}>啟用</option><option value="0" ${x.is_active ? '' : 'selected'}>停用</option></select></label>
      <label class="full">備註<input name="note" value="${esc(x.note)}"></label>
    </div>
    <div class="form-actions">${u ? '<button type="button" class="danger" id="del">刪除</button>' : ''}<span class="spacer"></span><button type="button" id="cancel">取消</button><button class="primary">存檔</button></div></form>`);
  const f = $('#f', box);
  $('#cancel', box).onclick = closeModal;
  f.onsubmit = async (e) => {
    e.preventDefault();
    try { await api(u ? `/users/${u.user_id}` : '/users', { method: u ? 'PUT' : 'POST', body: Object.fromEntries(new FormData(f)) }); closeModal(); toast(u ? '已存檔' : '已新增，記得也把對方加進 Cloudflare Access'); reload(); } catch (err) { fail(err); }
  };
  if (u) $('#del', box).onclick = async () => {
    if (!confirm(`確定刪除 ${u.email}？（建議改為停用，保留紀錄）`)) return;
    try { await api(`/users/${u.user_id}`, { method: 'DELETE' }); closeModal(); toast('已刪除'); reload(); } catch (err) { fail(err); }
  };
}

// ---------------------------------------------------------------- 操作日誌
const RES_LABELS = {
  purchases: '進貨單', sales: '銷貨單', returns: '退貨／折讓', subscriptions: '訂閱', invoices: '發票', 'roast-batches': '烘焙批次', 'opening-stock': '期初庫存', 'stock-counts': '盤點／調整',
  'bank-transactions': '銀行收支', expenses: '費用', reconcile: '銀行對帳', recipes: '產品配方', users: '使用者', import: '主檔匯入', shop: '商店資料',
  suppliers: '供應商', customers: '客戶', 'green-beans': '生豆品項', 'roasted-beans': '熟豆品項', 'packaging-items': '包材', products: '產品', 'bank-accounts': '銀行帳戶', 'expense-categories': '費用類別',
};
async function pageAudit() {
  $('#main').innerHTML = `
    <h2>操作日誌</h2>
    <div class="toolbar">
      <label>起日<input type="date" id="from" value="${monthStart()}"></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <label>功能<select id="res"><option value="">全部</option>${Object.entries(RES_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label>動作<select id="act">${plainOpts(['新增', '修改', '刪除', '其他'], null, '全部')}</select></label>
      <label>使用者<select id="usr"><option value="">全部</option></select></label>
      <label>搜尋<input id="q" placeholder="單號、名稱"></label>
      <button id="search">查詢</button><span class="spacer"></span>
    </div>
    <p class="hint">所有新增、修改、刪除都會自動記錄操作者與修改前後的資料（最多顯示 200 筆，請用條件縮小範圍）。點任一列看差異。</p>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;
  let usersLoaded = false;
  const load = async () => {
    try {
      const { data, users } = await api('/audit-logs' + qs({ from: $('#from').value, to: $('#to').value, resource: $('#res').value, action: $('#act').value, user: $('#usr').value, q: $('#q').value.trim() }));
      if (!usersLoaded) { $('#usr').insertAdjacentHTML('beforeend', users.map((u) => `<option>${esc(u)}</option>`).join('')); usersLoaded = true; }
      $('#list').innerHTML = data.length ? `<table><thead><tr><th>時間</th><th>使用者</th><th>動作</th><th>功能</th><th>單號／名稱</th><th>路徑</th></tr></thead><tbody>
        ${data.map((l) => `<tr class="clickable" data-id="${l.log_id}"><td>${esc(l.created_at)}</td><td>${esc(l.user_email)}</td>
          <td><span class="${l.action === '新增' ? 'up' : l.action === '刪除' ? 'down' : ''}">${esc(l.action)}</span></td><td>${esc(RES_LABELS[l.resource] || l.resource)}</td><td>${esc(l.summary)}</td><td class="hint">${esc(l.method)} ${esc(l.path)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">沒有紀錄</div>';
      $$('#list tr.clickable').forEach((tr) => tr.onclick = () => auditDetail(Number(tr.dataset.id)));
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  $('#q').onkeydown = (e) => e.key === 'Enter' && load();
  load();
}
async function auditDetail(id) {
  try {
    const { data: l } = await api(`/audit-logs/${id}`);
    const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return s; } };
    const b = parse(l.before_json); const a = parse(l.after_json);
    const flat = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {});
    const keys = [...new Set([...Object.keys(flat(b)), ...Object.keys(flat(a))])];
    const show = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v, null, 1) : String(v));
    const changed = keys.filter((k) => JSON.stringify(flat(b)[k]) !== JSON.stringify(flat(a)[k]));
    openModal(`
      <h2>${esc(l.action)}｜${esc(RES_LABELS[l.resource] || l.resource)} ${esc(l.summary || '')}</h2>
      <p class="hint">${esc(l.created_at)}　${esc(l.user_email)}　${esc(l.method)} ${esc(l.path)}</p>
      ${b && a && typeof a === 'object' && keys.length ? `<div class="section-title">欄位差異（${changed.length} 個欄位有變動）</div>
        <div class="table-wrap"><table><thead><tr><th>欄位</th><th>修改前</th><th>修改後</th></tr></thead><tbody>
        ${keys.map((k) => { const ch = changed.includes(k); return `<tr ${ch ? 'style="background:#fff7e6"' : ''}><td>${esc(k)}</td><td><pre class="json">${esc(show(flat(b)[k]))}</pre></td><td><pre class="json">${esc(show(flat(a)[k]))}</pre></td></tr>`; }).join('')}
        </tbody></table></div>` : `<div class="form-grid"><div class="full"><div class="section-title">修改前</div><pre class="json">${esc(show(b) || '（無）')}</pre></div>
        <div class="full"><div class="section-title">${l.action === '刪除' ? '請求內容' : '修改後／結果'}</div><pre class="json">${esc(show(a) || '（無）')}</pre></div></div>`}
      <div class="form-actions"><span class="spacer"></span><button type="button" onclick="closeModal()">關閉</button></div>`, true);
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- 匯入／備份
const IMPORTABLE = { suppliers: '供應商', customers: '客戶', 'green-beans': '生豆品項', 'packaging-items': '包材', products: '產品' };
async function readSheetRows(file) {
  if (/\.csv$|\.txt$/i.test(file.name)) {
    const rows = parseCsv(await readTextFile(file));
    const [h, ...rest] = rows;
    return rest.map((r) => Object.fromEntries(h.map((k, i) => [k.trim(), r[i] ?? ''])));
  }
  const ExcelJS = await loadExcel();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.worksheets[0];
  const header = [];
  ws.getRow(1).eachCell((c, i) => { header[i] = String(c.text || '').trim(); });
  const out = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const o = {};
    header.forEach((h, i) => { if (!h) return; const c = row.getCell(i); const v = c.value; o[h] = v instanceof Date ? v.toISOString() : (v && typeof v === 'object' ? (v.result ?? v.text ?? c.text) : v); });
    out.push(o);
  });
  return out;
}
async function pageData() {
  const isAdmin = ME?.role === '管理者';
  $('#main').innerHTML = `
    <h2>匯入／備份</h2>
    <div class="section-title">主檔匯入</div>
    <div class="toolbar">
      <label>資料<select id="res">${Object.entries(IMPORTABLE).filter(([k]) => canWriteRes(k)).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <button id="tpl">⬇ 下載範本（含目前資料）</button>
      <button id="pick" class="primary">⬆ 選擇 Excel／CSV 匯入</button><input type="file" id="file" accept=".xlsx,.csv,.txt" hidden>
    </div>
    <p class="hint">用範本的第一列欄名填資料（範本裡已含目前所有資料，可直接修改後匯回）。名稱相同（產品可用料號）視為同一筆 → 更新；新的名稱 → 新增。
      關聯欄位（供應商、熟豆品項）請填名稱。匯入前會先全部檢查，有任何錯誤整批都不會寫入。</p>
    <div id="result"></div>
    <div class="section-title">全部資料備份</div>
    <p class="hint">${isAdmin ? '把所有資料表匯出成一個 Excel 檔（每個資料表一張工作表），建議每月下載一份留存。另外 Cloudflare D1 本身有 30 天的「時間移動」可以還原。' : '只有管理者可以下載全部資料備份。'}</p>
    ${isAdmin ? '<div class="toolbar"><button id="backup" class="primary">⬇ 下載全部資料備份</button></div>' : ''}`;
  const res = () => $('#res').value;
  $('#tpl').onclick = async () => {
    try {
      const ExcelJS = await loadExcel();
      const [{ data: t }, list] = await Promise.all([api(`/import/${res()}`), api(`/${res()}`)]);
      const nameMaps = {};
      if (['green-beans', 'packaging-items'].includes(res())) nameMaps.s = new Map((await lookup('suppliers', true)).map((x) => [x.supplier_id, x.name]));
      if (res() === 'products') nameMaps.r = new Map((await lookup('roasted-beans', true)).map((x) => [x.roasted_bean_id, x.name]));
      const val = (row, f) => {
        if (f === 'is_active') return row.is_active ? '是' : '否';
        if (f === 'default_supplier_id' || f === 'supplier_id') return nameMaps.s?.get(row[f]) || '';
        if (f === 'roasted_bean_id') return nameMaps.r?.get(row[f]) || '';
        return row[f] ?? '';
      };
      const wb = new ExcelJS.Workbook();
      addAoaSheet(wb, t.label, [t.cols.map((c) => c.label + (c.required ? ' *' : '')), ...list.data.map((row) => t.cols.map((c) => val(row, c.field)))], new Set());
      await downloadWorkbook(wb, `匯入範本_${t.label}_${today()}.xlsx`);
    } catch (e) { fail(e); }
  };
  $('#pick').onclick = () => $('#file').click();
  $('#file').onchange = async () => {
    const file = $('#file').files[0];
    $('#file').value = '';
    if (!file) return;
    try {
      const rows = (await readSheetRows(file)).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.replace(/\s*\*$/, ''), v])));
      const run = async (dry) => api(`/import/${res()}`, { method: 'POST', body: { rows, dry_run: dry } });
      let r;
      try { r = await run(true); } catch (e) {
        if (e.data?.errors) {
          $('#result').innerHTML = `<div class="notice">檔案有 ${e.data.errors.length} 列錯誤，整批沒有匯入。請修正後再匯入：</div>
            <div class="card"><div class="table-wrap"><table><thead><tr><th>Excel 列</th><th>錯誤</th></tr></thead><tbody>${e.data.errors.map((x) => `<tr><td>${x.line}</td><td>${esc(x.error)}</td></tr>`).join('')}</tbody></table></div></div>`;
          return;
        }
        throw e;
      }
      if (!confirm(`「${file.name}」檢查通過：\n新增 ${r.insert} 筆、更新 ${r.update} 筆。\n\n確定匯入？`)) return;
      r = await run(false);
      $('#result').innerHTML = `<div class="notice">已匯入：新增 ${r.insert} 筆、更新 ${r.update} 筆。</div>`;
      delete cache[res()];
    } catch (e) { fail(e); }
  };
  if ($('#backup')) $('#backup').onclick = async () => {
    try {
      toast('準備備份中…');
      const [ExcelJS, d] = await Promise.all([loadExcel(), api('/backup')]);
      const wb = new ExcelJS.Workbook();
      const used = new Set();
      for (const [name, rows] of Object.entries(d.tables)) {
        const cols = rows.length ? Object.keys(rows[0]) : ['（空）'];
        addAoaSheet(wb, name, [cols, ...rows.map((r) => cols.map((c) => r[c]))], used);
      }
      await downloadWorkbook(wb, `pinncafe-erp_備份_${today()}.xlsx`);
      toast(`已下載 ${Object.keys(d.tables).length} 個資料表`);
    } catch (e) { fail(e); }
  };
}

// ---------------------------------------------------------------- 路由
const ROUTES = {
  purchases: pagePurchases,
  sales: pageSales,
  'customer-history': pageCustomerHistory,
  roasts: pageRoasts,
  'opening-stock': pageOpening,
  returns: pageReturns,
  invoices: pageInvoices,
  subscriptions: pageSubscriptions,
  'stock-counts': pageCounts,
  recipes: pageRecipes,
  bank: pageBank,
  expenses: pageExpenses,
  receivables: pageReceivables,
  payables: pagePayables,
  'expense-summary': pageExpenseSummary,
  'stock-beans': pageStockBeans,
  'stock-roasted': pageStockRoasted,
  'stock-packaging': pageStockPackaging,
  reconcile: pageReconcile,
  'bank-codes': pageBankCodes,
  'rpt-profit': pageProfit,
  'rpt-pnl': pagePnl,
  'rpt-loss': pageLoss,
  'rpt-trace': pageTrace,
  'rpt-stock': pageStockNow,
  'rpt-processing': pageProcessing,
  users: pageUsers,
  audit: pageAudit,
  data: pageData,
  shop: pageShop,
  ...Object.fromEntries(Object.keys(MASTERS).map((k) => [k, () => pageMaster(k)])),
};

function route() {
  let key = location.hash.slice(1) || 'purchases';
  if (!ROUTES[key]) key = 'purchases';
  if (!canRead(key)) { // 沒權限的頁面 → 第一個有權限的頁面
    const first = $$('#nav a').find((a) => !a.hidden);
    if (first && first.getAttribute('href') !== '#' + key) { location.hash = first.getAttribute('href'); return; }
  }
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + key));
  $('#nav').classList.remove('open');
  closeModal();
  Promise.resolve(ROUTES[key]()).then(addExportButton).catch(fail);
}

window.addEventListener('hashchange', route);
$('#menuBtn').onclick = () => $('#nav').classList.toggle('open');
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
// 依角色隱藏沒有權限的選單，再開始路由
api('/me').then((r) => {
  ME = r.data;
  $('#who').textContent = `${ME.email}（${ME.role}）`;
  $$('#nav a').forEach((a) => { a.hidden = !canRead(a.getAttribute('href').slice(1)); });
  $$('#nav .nav-group').forEach((g) => { // 整組都沒權限就隱藏標題
    let el = g.nextElementSibling; let any = false;
    while (el && !el.classList.contains('nav-group')) { if (!el.hidden) any = true; el = el.nextElementSibling; }
    g.hidden = !any;
  });
}).catch((e) => { $('#who').textContent = ''; $('#main').innerHTML = `<div class="notice">${esc(e.message)}</div>`; throw e; }).then(route, () => {});
