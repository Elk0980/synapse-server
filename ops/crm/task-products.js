'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const fail = (status,message) => { throw Object.assign(new Error(message),{status}); };
const nameKey = value => String(value).normalize('NFKC').trim().toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const slugFor = value => nameKey(value).replace(/ /g,'-');
const hasBoardSchema = db => db.prepare('PRAGMA table_info(tasks)').all().some(row=>row.name==='product_id');

// Выполняется до BEGIN миграции. VACUUM INTO создаёт согласованный физический
// снимок, включая WAL; копирование только основного файла SQLite недостаточно.
function backupTasksBoard(db,databasePath) {
  if (!databasePath || databasePath===':memory:') return null;
  if (db.isTransaction) throw new Error('Бэкап доски должен предшествовать транзакции миграции');
  const destination=path.resolve(`${databasePath}.before-board-v10-${Date.now()}-${randomUUID()}.sqlite`);
  db.prepare('VACUUM INTO ?').run(destination);
  fs.chmodSync(destination,0o600);
  const copy=new DatabaseSync(destination,{readOnly:true});
  try {
    if (copy.prepare('PRAGMA integrity_check').all().some(row=>row.integrity_check!=='ok') || copy.prepare('PRAGMA foreign_key_check').all().length) {
      throw new Error('Проверка физического бэкапа доски не пройдена');
    }
  } finally { copy.close(); }
  return destination;
}

function verifyBoardSchema(db) {
  const required = {
    products:['id','company_code','name','slug'], tasks:['product_id','chat_url'], agents:['chat_url'],
    task_product_migration:['legacy_task_id','product_id','original_task','migrated_at'],
    task_product_child_migration:['task_id','parent_task_id','product_id']
  };
  for (const [table, columns] of Object.entries(required)) {
    const actual = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    if (columns.some(column => !actual.has(column))) throw new Error('Неполная схема продуктов доски: ' + table);
  }
  for (const name of ['task_product_migration_no_update','task_product_migration_no_delete',
    'task_product_child_migration_no_update','task_product_child_migration_no_delete',
    'tasks_product_insert','tasks_product_update','products_company_update']) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw new Error('Неполная схема продуктов доски: ' + name);
  }
  const unique = db.prepare('PRAGMA index_list(products)').all().some(index => index.unique &&
    db.prepare(`PRAGMA index_info("${index.name.replace(/"/g,'""')}")`).all().map(row => row.name).join(',') === 'company_code,slug');
  const sync = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='tasks_legacy_coordination_sync'").get()?.sql || '';
  if (!unique || !sync.includes('NEW.product_id IS NOT OLD.product_id') || !sync.includes('NEW.chat_url IS NOT OLD.chat_url') ||
      db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Неполная схема продуктов доски: ограничения');
}

function migrateTasksBoard(db) {
  if (!db.isTransaction) throw new Error('Миграция доски требует транзакцию');
  if (hasBoardSchema(db)) { verifyBoardSchema(db); return; }
  db.exec(`CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT NOT NULL COLLATE NOCASE,
      name TEXT NOT NULL, slug TEXT NOT NULL COLLATE NOCASE,
      UNIQUE(company_code,slug));
    ALTER TABLE tasks ADD COLUMN product_id INTEGER REFERENCES products(id);
    ALTER TABLE tasks ADD COLUMN chat_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE agents ADD COLUMN chat_url TEXT NOT NULL DEFAULT '';
    CREATE INDEX tasks_product_idx ON tasks(product_id);
    CREATE TABLE task_product_migration (
      legacy_task_id INTEGER PRIMARY KEY REFERENCES tasks(id), product_id INTEGER NOT NULL REFERENCES products(id),
      original_task TEXT NOT NULL, migrated_at TEXT NOT NULL);
    CREATE TABLE task_product_child_migration (
      task_id INTEGER PRIMARY KEY REFERENCES tasks(id), parent_task_id INTEGER NOT NULL REFERENCES tasks(id),
      product_id INTEGER NOT NULL REFERENCES products(id));
    CREATE TRIGGER task_product_migration_no_update BEFORE UPDATE ON task_product_migration
      BEGIN SELECT RAISE(ABORT,'Immutable task product migration'); END;
    CREATE TRIGGER task_product_migration_no_delete BEFORE DELETE ON task_product_migration
      BEGIN SELECT RAISE(ABORT,'Immutable task product migration'); END;
    CREATE TRIGGER task_product_child_migration_no_update BEFORE UPDATE ON task_product_child_migration
      BEGIN SELECT RAISE(ABORT,'Immutable task product migration'); END;
    CREATE TRIGGER task_product_child_migration_no_delete BEFORE DELETE ON task_product_child_migration
      BEGIN SELECT RAISE(ABORT,'Immutable task product migration'); END;
    CREATE TRIGGER tasks_product_insert BEFORE INSERT ON tasks
      WHEN NEW.product_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM products p WHERE p.id=NEW.product_id AND lower(p.company_code)=lower(NEW.company_code))
      BEGIN SELECT RAISE(ABORT,'TASK_PRODUCT_INVALID'); END;
    CREATE TRIGGER tasks_product_update BEFORE UPDATE OF product_id,company_code ON tasks
      WHEN NEW.product_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM products p WHERE p.id=NEW.product_id AND lower(p.company_code)=lower(NEW.company_code))
      BEGIN SELECT RAISE(ABORT,'TASK_PRODUCT_INVALID'); END;
    CREATE TRIGGER products_company_update BEFORE UPDATE OF company_code ON products
      WHEN EXISTS (SELECT 1 FROM tasks WHERE product_id=OLD.id AND lower(company_code)<>lower(NEW.company_code))
      BEGIN SELECT RAISE(ABORT,'TASK_PRODUCT_INVALID'); END;`);
  const markers=db.prepare("SELECT * FROM tasks WHERE client_ref LIKE 'product:%' AND title LIKE 'Продукт · %'").all();
  const stamp=new Date().toISOString();
  for (const marker of markers) {
    const productName=marker.title.slice('Продукт · '.length).trim(), slug=slugFor(productName);
    if (!slug || !marker.company_code || marker.parent_task_id!==null) throw new Error('Некорректная прежняя задача продукта');
    const code=marker.company_code.toLowerCase();
    db.prepare('INSERT INTO products(company_code,name,slug) VALUES(?,?,?) ON CONFLICT(company_code,slug) DO NOTHING').run(code,productName,slug);
    const product=db.prepare('SELECT * FROM products WHERE company_code=? COLLATE NOCASE AND slug=? COLLATE NOCASE').get(code,slug);
    db.prepare('INSERT INTO task_product_migration VALUES(?,?,?,?)').run(marker.id,product.id,JSON.stringify(marker),stamp);
    const children=db.prepare('SELECT id,parent_task_id FROM tasks WHERE parent_task_id=?').all(marker.id);
    for (const child of children) {
      db.prepare('INSERT INTO task_product_child_migration VALUES(?,?,?)').run(child.id,marker.id,product.id);
      db.prepare('UPDATE tasks SET parent_task_id=NULL,product_id=? WHERE id=?').run(product.id,child.id);
    }
    db.prepare('UPDATE tasks SET product_id=? WHERE id=?').run(product.id,marker.id);
  }
  // Сохраняем существующие ссылки; выделенное поле читатель заполняет из
  // совместимого старого links/chat при отсутствии явной HTTPS-ссылки.
  for (const agent of db.prepare('SELECT id,chat FROM agents').all()) {
    try { const url=validatedChat(agent.chat); db.prepare('UPDATE agents SET chat_url=? WHERE id=?').run(url,agent.id); } catch {}
  }
  const sync=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='tasks_legacy_coordination_sync'").get()?.sql;
  if (!sync) throw new Error('Не найден триггер версий прежних задач');
  const expanded=sync.replace(/AFTER UPDATE OF ([\s\S]+?) ON tasks/i,(_,fields)=>`AFTER UPDATE OF ${fields},product_id,chat_url ON tasks`)
    .replace(/AND \(([\s\S]+?)\)\s*BEGIN/i,(_,condition)=>`AND (${condition} OR NEW.product_id IS NOT OLD.product_id OR NEW.chat_url IS NOT OLD.chat_url) BEGIN`);
  if (expanded===sync || !expanded.includes('NEW.chat_url IS NOT OLD.chat_url')) throw new Error('Не удалось обновить триггер версий задач');
  db.exec(`DROP TRIGGER tasks_legacy_coordination_sync; ${expanded}`);
  verifyBoardSchema(db);
}

function validatedChat(value) {
  if (typeof value!=='string' || value.length>2048) fail(400,'Некорректная ссылка на чат');
  const result=value.trim();
  if (!result) return '';
  let url; try { url=new URL(result); } catch { fail(400,'Некорректная ссылка на чат'); }
  if (url.protocol!=='https:' || url.username || url.password) fail(400,'Нужна HTTPS-ссылка на чат без учётных данных');
  return result;
}

function boardFields(db,row) {
  if (!hasBoardSchema(db)) return {};
  const product=row.product_id===null?null:db.prepare('SELECT * FROM products WHERE id=?').get(row.product_id);
  const saved=db.prepare('SELECT data FROM task_coordination WHERE task_id=?').get(row.id);
  const links=saved?JSON.parse(saved.data).links || []:[];
  let chat=row.chat_url || '';
  if (!chat) {
    for (const link of links.filter(link=>/^чат/i.test(link.label || ''))) {
      try { chat=validatedChat(link.url); if(chat)break; } catch {}
    }
  }
  return {product_id:row.product_id,product_name:product?.name || '',chat_url:chat,
    product_placeholder:!!db.prepare('SELECT 1 FROM task_product_migration WHERE legacy_task_id=?').get(row.id)};
}

function createTaskProducts(db,{project,scopedTask,allowed,taskSummary}) {
  const ready=()=>{if(!hasBoardSchema(db))fail(503,'Миграция продуктов доски не установлена');};
  const product=(id,code,actor)=>{
    ready();
    if (!Number.isSafeInteger(id)||id<1)fail(400,'Некорректный продукт');
    const row=db.prepare('SELECT * FROM products WHERE id=?').get(id);
    if(!row||!allowed(actor).has(row.company_code.toLowerCase())||(code&&row.company_code.toLowerCase()!==code))fail(404,'Продукт не найден');
    return row;
  };
  const productName=value=>{
    if (typeof value!=='string'||value.length>200||!slugFor(value))fail(400,'Укажите название продукта до 200 символов');
    return value.trim();
  };
  const similar=(left,right)=>{
    const a=nameKey(left),b=nameKey(right);
    if(!a||!b)return false;
    if(a===b)return true;
    if(Math.min(a.length,b.length)>=6&&(a.includes(b)||b.includes(a)))return true;
    const aa=new Set(a.split(' ')),bb=new Set(b.split(' ')),common=[...aa].filter(word=>bb.has(word)).length;
    return common>=2&&common/(aa.size+bb.size-common)>=0.65;
  };
  const list=(args,actor)=>{
    ready();
    const codes=args.project!==undefined?[project(args.project,actor)]:[...allowed(actor)];
    const search=args.search===undefined||args.search===''?'':productName(args.search);
    return {products:db.prepare(`SELECT id,company_code,name,slug FROM products WHERE lower(company_code) IN (${codes.map(()=>'?').join(',')}) ORDER BY name,id`).all(...codes)
      .filter(row=>!search||nameKey(row.name).includes(nameKey(search)))};
  };
  const duplicates=(args,actor)=>{
    ready(); const code=project(args.project,actor);
    if(typeof args.title!=='string'||!args.title.trim()||args.title.length>1000)fail(400,'Укажите название задачи');
    const possible_duplicates=db.prepare(`SELECT t.id,t.title FROM tasks t WHERE t.is_deleted=0 AND lower(t.company_code)=?
      AND NOT EXISTS (SELECT 1 FROM task_product_migration m WHERE m.legacy_task_id=t.id) ORDER BY t.id DESC`).all(code)
      .filter(row=>similar(row.title,args.title)).slice(0,10).map(row=>taskSummary(db.prepare('SELECT * FROM tasks WHERE id=?').get(row.id)));
    const newName=args.new_product===undefined?'':productName(args.new_product);
    if(args.product_id!=null)product(args.product_id,code,actor);
    const possible_product_duplicates=newName?list({project:code},actor).products.filter(row=>similar(row.name,newName)).slice(0,10):[];
    return {possible_duplicates,possible_product_duplicates};
  };
  const resolve=(args,code,actor)=>{
    if(args.new_product!==undefined&&args.product_id!=null)fail(400,'Выберите продукт или создайте новый');
    if(args.product_id!=null)return product(args.product_id,code,actor).id;
    if(args.new_product===undefined)return null;
    ready();const name=productName(args.new_product),slug=slugFor(name);
    db.prepare('INSERT INTO products(company_code,name,slug) VALUES(?,?,?) ON CONFLICT(company_code,slug) DO NOTHING').run(code,name,slug);
    return db.prepare('SELECT id FROM products WHERE company_code=? COLLATE NOCASE AND slug=? COLLATE NOCASE').get(code,slug).id;
  };
  const validateParent=(parent,row,actor)=>{
    if(parent===null)return null;
    const candidate=scopedTask(parent,actor);
    if(candidate.id===row.id||candidate.parent_task_id!==null||candidate.company_code.toLowerCase()!==row.company_code.toLowerCase()||
      db.prepare('SELECT 1 FROM tasks WHERE parent_task_id=? AND is_deleted=0 LIMIT 1').get(row.id))fail(400,'Подзадача должна принадлежать корневой задаче того же проекта');
    return parent;
  };
  return {list,duplicates,resolve,product,validateParent};
}

module.exports={backupTasksBoard,migrateTasksBoard,hasBoardSchema,boardFields,createTaskProducts,validatedChat};
