// 主檔定義：欄位、型別、列舉值。CRUD 邏輯在 crud.js
// type: text | number | int | bool | date | enum | fk

export const ROAST_LEVELS = ['淺焙', '中焙', '中深焙', '深焙'];
export const GRIND_SIZES = ['原豆', '手沖', '義式', '法壓', '冷萃'];

export const resources = {
  suppliers: {
    table: 'suppliers', pk: 'supplier_id', label: '供應商',
    search: ['name', 'contact_name', 'phone', 'tax_id'],
    fields: {
      name: { type: 'text', required: true },
      tax_id: { type: 'text' }, contact_name: { type: 'text' },
      phone: { type: 'text' }, email: { type: 'text' }, address: { type: 'text' },
      country: { type: 'text' }, payment_terms: { type: 'text' },
      bank_info: { type: 'text' }, note: { type: 'text' },
      is_active: { type: 'bool', default: 1 },
    },
    refs: [
      ['purchases', 'supplier_id', '進貨單'],
      ['green_beans', 'default_supplier_id', '生豆品項'],
      ['packaging_items', 'supplier_id', '包材'],
      ['bank_transactions', 'supplier_id', '銀行收支'],
    ],
  },
  customers: {
    table: 'customers', pk: 'customer_id', label: '客戶',
    search: ['name', 'phone', 'line_id', 'tax_id'],
    fields: {
      name: { type: 'text', required: true },
      customer_type: { type: 'enum', values: ['零售', '批發', '咖啡廳', '電商'], default: '零售' },
      price_level: { type: 'enum', values: ['零售價', '批發價', 'VIP'], default: '零售價' },
      tax_id: { type: 'text' }, phone: { type: 'text' }, email: { type: 'text' },
      line_id: { type: 'text' }, shipping_address: { type: 'text' },
      payment_terms: { type: 'text' }, credit_limit: { type: 'number' },
      birthday: { type: 'date' }, source: { type: 'text' }, note: { type: 'text' },
      is_active: { type: 'bool', default: 1 },
    },
    refs: [['sales', 'customer_id', '銷貨單'], ['bank_transactions', 'customer_id', '銀行收支'], ['subscriptions', 'customer_id', '訂閱']],
  },
  'green-beans': {
    table: 'green_beans', pk: 'bean_id', label: '生豆品項',
    search: ['name', 'country', 'region', 'farm'],
    fields: {
      name: { type: 'text', required: true },
      country: { type: 'text' }, region: { type: 'text' }, farm: { type: 'text' },
      process: { type: 'enum', values: ['水洗', '日曬', '蜜處理', '厭氧', '其他'] },
      variety: { type: 'text' }, altitude: { type: 'text' }, crop_year: { type: 'text' },
      cupping_score: { type: 'number' },
      default_supplier_id: { type: 'fk' },
      safety_stock_kg: { type: 'number', default: 0 },
      note: { type: 'text' },
      is_active: { type: 'bool', default: 1 },
    },
    joins: 'LEFT JOIN suppliers s ON s.supplier_id = t.default_supplier_id',
    joinCols: 's.name AS default_supplier_name',
    refs: [
      ['purchase_items', 'bean_id', '進貨明細'],
      ['green_bean_lots', 'bean_id', '生豆批號'],
    ],
  },
  'packaging-items': {
    table: 'packaging_items', pk: 'packaging_id', label: '包材',
    search: ['name'],
    fields: {
      name: { type: 'text', required: true },
      unit: { type: 'text', default: '個' },
      unit_cost: { type: 'number' },
      supplier_id: { type: 'fk' },
      safety_stock: { type: 'int', default: 0 },
      note: { type: 'text' },
      is_active: { type: 'bool', default: 1 },
    },
    joins: 'LEFT JOIN suppliers s ON s.supplier_id = t.supplier_id',
    joinCols: 's.name AS supplier_name',
    refs: [['purchase_items', 'packaging_id', '進貨明細'], ['product_recipes', 'packaging_id', '產品配方']],
  },
  products: {
    table: 'products', pk: 'product_id', label: '產品',
    search: ['name', 'sku'],
    fields: {
      sku: { type: 'text' },
      name: { type: 'text', required: true },
      category: { type: 'enum', values: ['單品豆', '綜合豆', '濾掛', '禮盒', '器具', '其他'], default: '單品豆' },
      roast_level: { type: 'enum', values: ROAST_LEVELS },
      net_weight_g: { type: 'int' },
      retail_price: { type: 'number' }, wholesale_price: { type: 'number' },
      shelf_life_days: { type: 'int' },
      roasted_bean_id: { type: 'fk' },
      note: { type: 'text' },
      is_active: { type: 'bool', default: 1 },
    },
    joins: 'LEFT JOIN roasted_beans rb ON rb.roasted_bean_id = t.roasted_bean_id',
    joinCols: 'rb.name AS roasted_bean_name',
    // 指定熟豆品項的產品，銷貨時要靠每包淨重換算扣多少熟豆
    validate(row) {
      if (row.roasted_bean_id && !(row.net_weight_g > 0)) {
        return '已指定熟豆品項的產品必須填「每包淨重（g）」，銷貨時才能換算要扣多少熟豆';
      }
      return null;
    },
    refs: [['sale_items', 'product_id', '銷貨明細'], ['subscriptions', 'product_id', '訂閱']],
  },
  'roasted-beans': {
    table: 'roasted_beans', pk: 'roasted_bean_id', label: '熟豆品項',
    search: ['name'],
    fields: {
      name: { type: 'text', required: true },
      roast_level: { type: 'enum', values: ROAST_LEVELS },
      shelf_life_days: { type: 'int' },
      safety_stock_kg: { type: 'number', default: 0 },
      note: { type: 'text' },
      is_active: { type: 'bool', default: 1 },
    },
    refs: [
      ['products', 'roasted_bean_id', '產品'],
      ['roast_batches', 'roasted_bean_id', '烘焙批次'],
    ],
  },
  'bank-accounts': {
    table: 'bank_accounts', pk: 'account_id', label: '銀行帳戶',
    search: ['account_name', 'bank_name', 'account_no_masked'],
    fields: {
      account_name: { type: 'text', required: true },
      account_type: { type: 'enum', values: ['銀行', '現金', 'LINE Pay', '信用卡收單', '電商平台'], default: '銀行' },
      bank_name: { type: 'text' },
      account_no_masked: { type: 'text' },
      opening_balance: { type: 'number', default: 0 },
      opening_date: { type: 'date' },
      note: { type: 'text' },
      is_active: { type: 'bool', default: 1 },
    },
    // 只存帳號末四碼，避免完整帳號留在系統裡
    validate(row) {
      if (row.account_no_masked && !/^\d{1,4}$/.test(row.account_no_masked)) return '帳號只填末四碼（最多 4 位數字），不要存完整帳號';
      if (row.opening_balance < 0) return '期初餘額不可為負數';
      return null;
    },
    refs: [['bank_transactions', 'account_id', '銀行收支']],
  },
  'expense-categories': {
    table: 'expense_categories', pk: 'category_id', label: '費用類別',
    search: ['name'],
    fields: {
      name: { type: 'text', required: true },
      allocate_to_roast: { type: 'bool', default: 0 },
      note: { type: 'text' },
      is_active: { type: 'bool', default: 1 },
    },
    refs: [['expenses', 'category_id', '費用']],
  },
};

export const PREF_FIELDS = {
  roast_level: { type: 'enum', values: ROAST_LEVELS },
  flavor_notes: { type: 'text' },
  grind_size: { type: 'enum', values: GRIND_SIZES },
  brew_method: { type: 'text' },
  favorite_products: { type: 'text' },
  dislikes: { type: 'text' },
  note: { type: 'text' },
};
