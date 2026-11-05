'use strict';

/* Расходы по компании (spec 111). Добавочная миграция: в expenses появляется nullable
   company_code. Старые строки остаются общими (company_code IS NULL) и не приписываются
   ни одной компании задним числом. Если расходы уже есть, перед миграцией делается проверенный
   физический снимок базы рядом с ней; при сбое снимок остаётся оператору, миграция откатывается целиком. */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const MIGRATION_VERSION = 11;

function hasCompanyColumn(db) {
  return db.prepare('PRAGMA table_info(expenses)').all().some((column) => column.name === 'company_code');
}

function backupBeforeExpensesScope(db, databasePath) {
  if (!databasePath || databasePath === ':memory:') return null;
  if (db.isTransaction) throw new Error('Бэкап расходов должен предшествовать транзакции миграции');
  // Пустую таблицу нечего терять: ALTER на ней не затрагивает данные, снимок не нужен.
  if (db.prepare('SELECT COUNT(*) AS count FROM expenses').get().count === 0) return null;
  const destination = path.resolve(
    `${databasePath}.before-expenses-company-v${MIGRATION_VERSION}-${Date.now()}-${randomUUID()}.sqlite`
  );
  db.prepare('VACUUM INTO ?').run(destination);
  fs.chmodSync(destination, 0o600);
  const copy = new DatabaseSync(destination, { readOnly: true });
  try {
    const integrity = copy.prepare('PRAGMA integrity_check').all();
    if (integrity.some((row) => row.integrity_check !== 'ok')) {
      throw new Error('Проверка бэкапа перед миграцией расходов не пройдена');
    }
    const original = db.prepare('SELECT COUNT(*) AS count FROM expenses').get().count;
    const copied = copy.prepare('SELECT COUNT(*) AS count FROM expenses').get().count;
    if (original !== copied) throw new Error('Бэкап расходов неполный');
  } finally {
    copy.close();
  }
  return destination;
}

function migrateExpensesCompany(db) {
  if (!hasCompanyColumn(db)) db.exec('ALTER TABLE expenses ADD COLUMN company_code TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS expenses_company_spent_idx ON expenses(company_code, spent_at)');
}

/* Расходы за период. Без компании — все строки, как раньше. С компанией — только её строки;
   пустой результат означает «расходы не внесены», а не нулевой расход. */
function expenseRows(db, { from, to = null, companyCode = null, source = null }) {
  const clauses = ['spent_at >= ?'];
  const params = [from];
  if (to) {
    clauses.push('spent_at <= ?');
    params.push(to);
  }
  if (companyCode) {
    clauses.push('company_code = ? COLLATE NOCASE');
    params.push(companyCode);
  }
  if (source) {
    clauses.push('source = ?');
    params.push(source);
  }
  return db.prepare(`
    SELECT source, SUM(amount) AS expenses, COUNT(*) AS entries FROM expenses
    WHERE ${clauses.join(' AND ')} GROUP BY source
  `).all(...params);
}

function expenseTotal(rows, companyCode) {
  if (companyCode && rows.length === 0) return null;
  return rows.reduce((sum, row) => sum + row.expenses, 0);
}

module.exports = {
  MIGRATION_VERSION, hasCompanyColumn, backupBeforeExpensesScope, migrateExpensesCompany,
  expenseRows, expenseTotal,
};
