'use strict';

const crypto = require('node:crypto');
const { COMPANIES, transaction } = require('./auth-store');

const LEGACY_SITES = [
  ['synapse-business', 'synapse-business', 'Synapse Бизнес', 'draft',
    'https://synapse.synapsebusiness.ru/', null, null, null],
  ['taisabai', 'taisabai', 'ТайСабай', 'draft',
    'https://taisabai.synapsebusiness.ru/', null, null, null],
  ['alvi', 'alvi', 'ALVI', 'draft', 'https://alvi.synapsebusiness.ru/', 'alvi',
    '/site-editor.html?site=alvi', '/price-editor.html?site=alvi'],
  ['avokado', 'avokado', 'Авокадо', 'published', 'https://avokado.synapsebusiness.ru/', 'avokado',
    '/site-editor.html?site=avokado', '/price-editor.html?site=avokado'],
  ['palitra-love', 'palitra-love', 'Палитра лав', 'draft',
    'https://palitra-love.synapsebusiness.ru/', 'palitra', null, '/price-editor-palitra.html'],
];

function fail(status, message) { throw Object.assign(new Error(message), { status }); }

function createSiteStore(db, authStore, saveDocument) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS managed_sites (
      id TEXT PRIMARY KEY, company_code TEXT NOT NULL, name TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('legacy','managed')),
      is_active INTEGER NOT NULL CHECK (is_active IN (0,1)),
      publication_status TEXT NOT NULL CHECK (publication_status IN ('draft','published')),
      public_url TEXT, content_site_id TEXT, site_editor_url TEXT, price_editor_url TEXT,
      created_by INTEGER REFERENCES auth_users(id), created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, deleted_at TEXT
    );
  `);
  const insertLegacy = db.prepare(`INSERT OR IGNORE INTO managed_sites
    (id, company_code, name, source, is_active, publication_status, public_url, content_site_id,
     site_editor_url, price_editor_url, created_at, updated_at)
    VALUES (?, ?, ?, 'legacy', 1, ?, ?, ?, ?, ?, ?, ?)`);
  for (const site of LEGACY_SITES) {
    const stamp = new Date().toISOString();
    insertLegacy.run(...site, stamp, stamp);
  }
  const visible = (user, row) => user.role === 'owner' || user.companyCodes.includes(row.company_code);
  const output = (user, row) => {
    const can = (permission) => user.role === 'owner' || user.permissions.includes(permission);
    return {
      id: row.id, name: row.name,
      company: { id: row.company_code, name: COMPANIES[row.company_code].name },
      isActive: Boolean(row.is_active), publicationStatus: row.publication_status,
      publicUrl: row.public_url, logoUrl: null,
      documents: { site: Boolean(row.site_editor_url || row.source === 'managed'), price: Boolean(row.price_editor_url) },
      editorUrls: {
        site: row.source === 'managed'
          ? `/site-editor.html?managedSite=${encodeURIComponent(row.id)}&mode=blank` : row.site_editor_url,
        price: row.price_editor_url,
      },
      capabilities: {
        view: can('sites.view'), create: can('sites.create'),
        editSite: can('site_editor.edit') && Boolean(row.site_editor_url || row.source === 'managed'),
        editPrice: can('price.edit') && Boolean(row.price_editor_url),
        delete: can('sites.delete') && row.source === 'managed' && row.publication_status === 'draft',
      },
    };
  };
  const rowById = (id) => db.prepare('SELECT * FROM managed_sites WHERE id=? AND deleted_at IS NULL').get(id);
  return {
    list(user, filters = {}) {
      if (filters.companyCode && !COMPANIES[filters.companyCode]) fail(400, 'Неизвестная компания');
      if (filters.state && !['active', 'draft', 'published'].includes(filters.state)) fail(400, 'Неизвестный фильтр');
      return db.prepare('SELECT * FROM managed_sites WHERE deleted_at IS NULL ORDER BY name').all()
        .filter((row) => visible(user, row))
        .filter((row) => !filters.companyCode || row.company_code === filters.companyCode)
        .filter((row) => filters.state !== 'active' || Boolean(row.is_active))
        .filter((row) => !['draft', 'published'].includes(filters.state) || row.publication_status === filters.state)
        .map((row) => output(user, row));
    },
    get(user, id) {
      const row = rowById(id);
      if (!row || !visible(user, row)) fail(404, 'Сайт не найден');
      return output(user, row);
    },
    create(user, { name, companyCode }) {
      if (typeof name !== 'string' || !name.trim() || name.length > 120 || !COMPANIES[companyCode]) {
        fail(400, 'Некорректное название или компания');
      }
      if (!visible(user, { company_code: companyCode })) fail(404, 'Компания не найдена');
      return transaction(db, () => {
        const id = `site-${crypto.randomBytes(10).toString('hex')}`;
        const stamp = new Date().toISOString();
        db.prepare(`INSERT INTO managed_sites
          (id, company_code, name, source, is_active, publication_status, created_by, created_at, updated_at)
          VALUES (?, ?, ?, 'managed', 1, 'draft', ?, ?, ?)`)
          .run(id, companyCode, name.trim(), user.id, stamp, stamp);
        saveDocument(`${id}/site`, { sections: [] }, user.displayName);
        authStore.audit(user.id, null, 'SITE_DRAFT_CREATED', { siteId: id, companyCode });
        return output(user, rowById(id));
      });
    },
    remove(user, id) {
      const row = rowById(id);
      if (!row || !visible(user, row)) fail(404, 'Сайт не найден');
      if (row.source !== 'managed' || row.publication_status !== 'draft') {
        fail(409, 'Удаление опубликованного сайта требует отдельного снятия с публикации');
      }
      const stamp = new Date().toISOString();
      db.prepare('UPDATE managed_sites SET is_active=0, deleted_at=?, updated_at=? WHERE id=?').run(stamp, stamp, id);
      authStore.audit(user.id, null, 'SITE_DRAFT_DELETED', { siteId: id, companyCode: row.company_code });
    },
  };
}

module.exports = { LEGACY_SITES, createSiteStore };
