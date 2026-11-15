// 咖啡烘豆進銷存 — 後台管理（Phase 1～4）
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
      ['address', '地址', 'text', { full: true }], ['bank_info', '匯款資訊', 'text', { full: true }], ['note', '備註', 'textarea', { full: true }],
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
    cols: [['account_name', '帳戶名稱'], ['account_type', '類型'], ['bank_name', '銀行'], ['account_no_masked', '帳號末四碼'], ['opening_balance', '期初餘額', 'num'], ['opening_date', '期初日期']],
    fields: [
      ['account_name', '帳戶名稱', 'text', { required: true }],
      ['account_type', '類型', 'enum', { values: ['銀行', '現金', 'LINE Pay', '信用卡收單', '電商平台'], noBlank: true }],
      ['bank_name', '銀行名稱'], ['account_no_masked', '帳號末四碼（不要填完整帳號）'],
      ['opening_balance', '期初餘額', 'number'], ['opening_date', '期初日期', 'date'],
      ['note', '備註', 'textarea', { full: true }],
    ],
    hint: '現金、LINE Pay、刷卡收單也各建一個帳戶，收款時選對帳戶，餘額才會對得上。期初日期建議填開帳日的前一天，交易日期不可早於期初日期。',
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
      $('#list').innerHTML = data.length ? `<table><thead><tr>${m.cols.map(([, l, t]) => `<th class="${t ? 'num' : ''}">${l}</th>`).join('')}<th>狀態</th></tr></thead><tbody>
        ${data.map((r) => `<tr class="clickable ${r.is_active ? '' : 'inactive'}" data-id="${r[m.pk]}">
          ${m.cols.map(([c, , t]) => `<td class="${t && t !== 'yn' ? 'num' : ''}">${t === 'yn' ? (r[c] ? '是' : '') : t === 'num2' ? esc(fmt(r[c], 2)) : t ? esc(fmt(r[c])) : esc(r[c])}</td>`).join('')}
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

async function masterForm(key, id, reload) {
  const m = MASTERS[key];
  try {
    const row = id ? (await api(`/${key}/${id}`)).data : { is_active: 1 };
    const fkData = {};
    for (const [, , type, o] of m.fields) if (type === 'fk') fkData[o.resource] = await lookup(o.resource, true);

    const input = ([name, label, type = 'text', o = {}]) => {
      const v = row[name];
      let ctl;
      if (type === 'bool') ctl = `<select name="${name}"><option value="0" ${v ? '' : 'selected'}>否</option><option value="1" ${v ? 'selected' : ''}>是</option></select>`;
      else if (type === 'enum') ctl = `<select name="${name}">${o.noBlank ? '' : '<option value=""></option>'}${o.values.map((x) => `<option ${v === x ? 'selected' : ''}>${x}</option>`).join('')}</select>`;
      else if (type === 'fk') ctl = `<select name="${name}">${options(fkData[o.resource], o.idKey, v, o.blank ? { blank: o.blank } : {})}</select>`;
      else if (type === 'textarea') ctl = `<textarea name="${name}" rows="2">${esc(v)}</textarea>`;
      else ctl = `<input name="${name}" type="${type === 'number' ? 'number' : type}" ${type === 'number' ? 'step="any" min="0"' : ''} value="${esc(v)}" ${o.required ? 'required' : ''}>`;
      return `<label class="${o.full ? 'full' : ''}">${label}${o.required ? ' *' : ''}${ctl}</label>`;
    };

    const prefs = key === 'customers' ? `
      <div class="section-title">喜好 <button type="button" id="addPref">＋ 新增一筆</button></div>
      <div class="table-wrap"><table class="items"><thead><tr><th>烘焙度</th><th>偏好風味</th><th>研磨度</th><th>沖煮器具</th><th>常買品項</th><th>不喜歡</th><th>備註</th><th></th></tr></thead>
      <tbody id="prefs">${(row.preferences || []).map(prefRow).join('')}</tbody></table></div>` : '';

    const box = openModal(`
      <h2>${id ? '編輯' : '新增'}${m.title}</h2>
      <form id="f">
        <div class="form-grid">${m.fields.map(input).join('')}
          <label>狀態<select name="is_active"><option value="1" ${row.is_active ? 'selected' : ''}>啟用</option><option value="0" ${row.is_active ? '' : 'selected'}>停用</option></select></label>
        </div>${m.hint ? `<p class="hint">${m.hint}</p>` : ''}${prefs}
        <div class="form-actions">
          ${id ? '<button type="button" class="danger" id="del">刪除</button>' : ''}<span class="spacer"></span>
          <button type="button" id="cancel">取消</button><button class="primary">存檔</button>
        </div>
      </form>`, key === 'customers');

    $('#cancel', box).onclick = closeModal;
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
        await api(id ? `/${key}/${id}` : `/${key}`, { method: id ? 'PUT' : 'POST', body });
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
      <button id="add" class="primary">＋ 新增銷貨單</button>
    </div>
    <div class="stats" id="stats"></div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;

  const load = async () => {
    try {
      const { data, summary } = await api('/sales' + qs({ from: $('#from').value, to: $('#to').value, customer_id: $('#cust').value, product_id: $('#prod').value, channel: $('#chan').value, payment_status: $('#pay').value }));
      $('#stats').innerHTML = [['銷貨單數', fmt(summary.count), ''], ['營業額', money(summary.total_amount), 'up'], ['熟豆成本', money(summary.cost_amount), ''], ['毛利', money(summary.gross_profit), ''], ['未收款', money(summary.unpaid_amount), ''], ['出貨熟豆 kg', '−' + kg(summary.roasted_kg), 'down']]
        .map(([k, v, c]) => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`).join('');
      $('#list').innerHTML = data.length ? `<table><thead><tr><th>銷貨日期</th><th>單號</th><th>客戶</th><th>通路</th><th class="num">明細數</th><th class="num">小計</th><th class="num">折扣</th><th class="num">運費</th><th class="num">合計</th><th class="num">未收</th><th class="num">毛利</th><th>付款方式</th><th>收款</th></tr></thead><tbody>
        ${data.map((r) => `<tr class="clickable" data-id="${r.sale_id}"><td>${esc(r.sale_date)}</td><td>${esc(r.sale_no)}</td><td>${r.customer_name ? esc(r.customer_name) : '<span class="tag">散客</span>'}</td><td>${esc(r.channel)}</td>
          <td class="num">${r.item_count}</td><td class="num">${money(r.subtotal)}</td><td class="num">${r.discount ? '−' + money(r.discount) : ''}</td><td class="num">${r.shipping_fee ? money(r.shipping_fee) : ''}</td>
          <td class="num up"><b>${money(r.total_amount)}</b></td><td class="num">${r.unpaid_amount ? money(r.unpaid_amount) : ''}</td><td class="num">${money(r.gross_profit)}</td><td>${esc(r.payment_method)}</td><td>${payTag(r.payment_status, r.overpaid)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">此區間沒有銷貨單</div>';
      $$('#list tr.clickable').forEach((tr) => tr.onclick = () => saleForm(Number(tr.dataset.id), load));
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
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
      $('#list').innerHTML = data.length ? `<table><thead><tr><th>日期</th><th>編號</th><th>帳戶</th><th>類別</th><th>對象</th><th>摘要</th><th class="num">入帳</th><th class="num">出帳</th>${showBal ? '<th class="num">餘額</th>' : ''}<th>沖銷單據</th></tr></thead><tbody>
        ${data.map((r) => `<tr class="clickable" data-id="${r.txn_id}"><td>${esc(r.txn_date)}</td><td>${esc(r.txn_no)}</td><td>${esc(r.account_name)}</td><td>${esc(r.category)}</td>
          <td>${r.category === '轉帳' ? (r.direction === DIR_OUT ? '→ ' : '← ') + esc(r.transfer_account_name) : esc(r.counterparty)}</td><td>${esc(r.description)}</td>
          ${r.direction === DIR_IN ? inAmt(r.amount) + '<td></td>' : '<td></td>' + outAmt(r.amount)}${showBal ? `<td class="num">${money(r.balance)}</td>` : ''}
          <td>${esc(r.doc_nos)}${['銷貨收款', '進貨付款', '費用'].includes(r.category) && r.unallocated > 0.005 ? ` <span class="tag warn">未沖 ${money(r.unallocated)}</span>` : ''}</td></tr>`).join('')}
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
      <form id="f">
        <div class="form-grid">
          <label>帳戶 *<select name="account_id" required>${options(accounts, 'account_id', t.account_id, { blank: '請選擇', label: (a) => a.account_name })}</select></label>
          <label>交易日期 *<input name="txn_date" type="date" required value="${esc(t.txn_date)}"></label>
          <label>金額 *<input name="amount" type="number" step="any" min="0" required value="${esc(t.amount)}" class="${isIn ? 'up' : 'down'}"></label>
          <label>類別<select name="category">${plainOpts(TXN_CATS[direction], t.category)}</select></label>
          <label>${isIn ? '客戶' : '供應商'}<select name="${partyKey}">${options(parties, partyKey, t[partyKey], { blank: isIn ? '（不指定／散客）' : '（不指定）' })}</select></label>
          <label>交易對象（自由填寫）<input name="counterparty" value="${esc(t.counterparty)}" placeholder="選了${isIn ? '客戶' : '供應商'}可留空"></label>
          <label>銀行交易序號<input name="bank_ref_no" value="${esc(t.bank_ref_no)}"></label>
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
    f[partyKey].onchange = loadDocs;
    $('#cancel', box).onclick = closeModal;
    await loadDocs();

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
  ...Object.fromEntries(Object.keys(MASTERS).map((k) => [k, () => pageMaster(k)])),
};

function route() {
  const key = location.hash.slice(1) || 'purchases';
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + key));
  $('#nav').classList.remove('open');
  closeModal();
  (ROUTES[key] || ROUTES.purchases)().catch(fail);
}

window.addEventListener('hashchange', route);
$('#menuBtn').onclick = () => $('#nav').classList.toggle('open');
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
api('/me').then((r) => ($('#who').textContent = r.data.email)).catch(() => {});
route();
