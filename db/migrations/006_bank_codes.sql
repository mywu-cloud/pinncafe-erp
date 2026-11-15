-- 銀行代碼、完整帳號、供應商匯款帳戶、付款收款帳戶與匯費
-- 既有資料庫升級：只能跑一次（ALTER TABLE ADD COLUMN），之後再跑 schema.sql
CREATE TABLE IF NOT EXISTS bank_codes (
  code        TEXT    PRIMARY KEY CHECK (length(code) = 3),
  name        TEXT    NOT NULL,
  category    TEXT    NOT NULL DEFAULT '本國銀行' CHECK (category IN ('本國銀行','外商銀行','郵局','信用合作社','農漁會','其他')),
  is_builtin  INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0,1)),
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  note        TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now','+8 hours')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE TABLE IF NOT EXISTS supplier_bank_accounts (
  sba_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id     INTEGER NOT NULL REFERENCES suppliers(supplier_id),
  bank_code       TEXT    NOT NULL,
  branch_name     TEXT,
  branch_code     TEXT,
  account_no      TEXT    NOT NULL,
  account_holder  TEXT,
  is_default      INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  note            TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now','+8 hours')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX IF NOT EXISTS idx_sba_supplier ON supplier_bank_accounts(supplier_id);
ALTER TABLE bank_accounts ADD COLUMN bank_code TEXT;
ALTER TABLE bank_accounts ADD COLUMN branch_name TEXT;
ALTER TABLE bank_accounts ADD COLUMN branch_code TEXT;
ALTER TABLE bank_accounts ADD COLUMN account_no TEXT;
ALTER TABLE bank_accounts ADD COLUMN account_holder TEXT;
ALTER TABLE bank_transactions ADD COLUMN payee_account_id INTEGER REFERENCES supplier_bank_accounts(sba_id);
ALTER TABLE bank_transactions ADD COLUMN payee_info TEXT;
ALTER TABLE bank_transactions ADD COLUMN fee_txn_id INTEGER;
