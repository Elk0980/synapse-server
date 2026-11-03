'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {createTaskCoordination,migrateTasksMcp,migrateTasksBoard,backupTasksBoard}=require('./task-coordination');
const owner={role:'owner',userId:7,companyCodes:new Set(['alpha'])};
const beta={role:'owner',userId:7,companyCodes:new Set(['beta'])};
function fixture(t,{board=true,file=':memory:'}={}) {
  const db=new DatabaseSync(file);t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE companies(code TEXT PRIMARY KEY,is_deleted INTEGER NOT NULL DEFAULT 0);
    INSERT INTO companies VALUES('alpha',0),('beta',0);
    CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0,deleted_at TEXT,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',
      company_code TEXT NOT NULL DEFAULT '',assignee_name TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'inbox',
      priority TEXT NOT NULL DEFAULT 'normal',due_date TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','chat','pipeline')),created_by TEXT NOT NULL DEFAULT '');
    INSERT INTO tasks(id,created_at,updated_at,title,company_code) VALUES(10,'old','old','Исходная задача','alpha'),(11,'old','old','Чужая задача','beta');
    CREATE TABLE attachments(task_id INTEGER REFERENCES tasks(id),bytes BLOB);
    INSERT INTO attachments VALUES(10,x'0001ff');
    CREATE TABLE unrelated(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT);
    INSERT INTO unrelated(id,value) VALUES(400,'сохранить'); DELETE FROM unrelated;
    INSERT INTO unrelated(value) VALUES('следующий');`);
  createTaskCoordination(db);
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try {migrateTasksMcp(db);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
  db.exec('PRAGMA foreign_keys=ON');
  if(board){db.exec('BEGIN IMMEDIATE');try{migrateTasksBoard(db);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}}
  const api=createTaskCoordination(db,{now:()=>Date.parse('2026-11-03T12:00:00Z')});
  return {db,api,call:(name,args={},actor=owner)=>api.tool(name,args,actor)};
}
const create=(call,title,extra={})=>call('task_create',{title,project:'alpha',client_ref:`sample:${title}`, ...extra});

test('physical WAL backup preserves every table, BLOB, sequence and history before the atomic board migration',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'synapse-board-'));
  const file=path.join(dir,'test.sqlite'),{db,call}=fixture(t,{board:false,file});
  t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});});
  const marker=create(call,'Продукт · Контент',{client_ref:'product:alpha:content'}).task;
  const child=create(call,'Снять ролик',{parent_id:marker.id,description:'Старое описание',links:[{url:'https://example.test/asset',label:'Файл',kind:'image'}]}).task;
  call('task_comment',{task_id:marker.id,author:'Sample',text:'Сохранить историю продукта'});
  call('task_comment',{task_id:child.id,author:'Sample',text:'Сохранить ход работы'});
  const beforeTables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row=>row.name);
  const snapshot=Object.fromEntries(beforeTables.map(name=>[name,db.prepare(`SELECT * FROM "${name}"`).all()]));
  const backup=backupTasksBoard(db,file);assert.ok(fs.statSync(backup).size>0);
  const copy=new DatabaseSync(backup,{readOnly:true});
  try {for(const name of beforeTables)assert.deepEqual(copy.prepare(`SELECT * FROM "${name}"`).all(),snapshot[name]);}
  finally{copy.close();}
  db.exec('BEGIN IMMEDIATE');migrateTasksBoard(db);db.exec('COMMIT');
  const migrated=call('task_get',{task_id:child.id});
  assert.equal(migrated.parent_task_id,null);assert.equal(migrated.product_name,'Контент');
  assert.equal(migrated.comments[0].text,'Сохранить ход работы');assert.deepEqual(migrated.coordination.links,child.coordination.links);
  const legacy=call('task_get',{task_id:marker.id});assert.equal(legacy.product_placeholder,true);assert.equal(legacy.comments[0].text,'Сохранить историю продукта');
  assert.equal(call('tasks_list',{}).tasks.find(row=>row.id===marker.id).product_placeholder,true);
  assert.equal(db.prepare('SELECT parent_task_id FROM task_product_child_migration WHERE task_id=?').get(child.id).parent_task_id,marker.id);
  for(const name of ['attachments','unrelated','task_comments','task_coordination_history']) {
    const after=db.prepare(`SELECT * FROM "${name}"`).all();
    if(name==='task_coordination_history')for(const row of snapshot[name])assert.ok(after.some(item=>JSON.stringify(item)===JSON.stringify(row)));
    else assert.deepEqual(after,snapshot[name]);
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.throws(()=>db.exec('DELETE FROM task_product_migration'),/Immutable/);
  const schema=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get().sql;
  db.exec('BEGIN IMMEDIATE');migrateTasksBoard(db);db.exec('COMMIT');
  assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get().sql,schema);
  const raw=new DatabaseSync(file);try{assert.equal(raw.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(raw.prepare('SELECT length(bytes) n FROM attachments').get().n,3);}finally{raw.close();}
});

test('malformed legacy product rolls back all schema and data changes',t=>{
  const {db,call}=fixture(t,{board:false});
  create(call,'Продукт · Вложенный',{client_ref:'product:alpha:nested',parent_id:10});
  const before=db.prepare('SELECT * FROM tasks ORDER BY id').all();
  db.exec('BEGIN IMMEDIATE');assert.throws(()=>migrateTasksBoard(db),/прежняя задача продукта/);db.exec('ROLLBACK');
  assert.deepEqual(db.prepare('SELECT * FROM tasks ORDER BY id').all(),before);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='products'").get(),undefined);
  assert.equal(backupTasksBoard(db,':memory:'),null);
});

test('a preexisting partial product column cannot be marked as a completed migration',t=>{
  const {db}=fixture(t,{board:false});
  db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); ALTER TABLE tasks ADD COLUMN product_id INTEGER;');
  db.exec('BEGIN IMMEDIATE');
  assert.throws(()=>{
    migrateTasksBoard(db);
    db.exec('INSERT INTO schema_migrations VALUES(10)');
  },/Неполная схема продуктов доски/);
  db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT count(*) n FROM schema_migrations WHERE version=10').get().n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n,2);
});

test('duplicate preflight does not write products/tasks; force and client_ref retries are explicit and atomic',t=>{
  const {call,db}=fixture(t);
  const first=create(call,'Создать контент план',{new_product:'Контент',chat_url:'https://example.test/chat'}).task;
  const before=db.prepare('SELECT count(*) n FROM tasks').get().n;
  const duplicate=create(call,'Создать контент план',{client_ref:'second',new_product:'Новый продукт'});
  assert.equal(duplicate.created,false);assert.equal(duplicate.possible_duplicates[0].id,first.id);
  assert.equal(db.prepare('SELECT count(*) n FROM products').get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n,before);
  const productDup=create(call,'Снять другой материал',{new_product:'КОНТЕНТ'});
  assert.equal(productDup.created,false);assert.equal(productDup.possible_product_duplicates[0].id,first.product_id);
  const forced=create(call,'Снять другой материал',{new_product:'КОНТЕНТ',force:true}).task;assert.equal(forced.product_id,first.product_id);
  const retry=create(call,'Создать контент план',{new_product:'Другое'});assert.equal(retry.created,false);assert.equal(retry.task.id,first.id);
  assert.throws(()=>create(call,'Третья',{force:'yes'}),error=>error.status===400);
  assert.throws(()=>create(call,'Некорректная дата',{new_product:'Потом откат',due_date:'2026-02-31'}),error=>error.status===400);
  assert.equal(call('products_list',{}).products.some(row=>row.name==='Потом откат'),false);
  assert.equal(call('task_duplicates',{title:'Создать контент план',project:'alpha'}).possible_duplicates[0].id,first.id);
});

test('products and duplicate suggestions stay within allowed projects and preserve legacy productless clients',t=>{
  const {call,db}=fixture(t);
  const alpha=create(call,'Альфа работа',{new_product:'Сервис'}).task;
  const other=call('task_create',{title:'Бета работа',project:'beta',new_product:'Сервис',client_ref:'beta'},beta).task;
  assert.notEqual(alpha.product_id,other.product_id);assert.equal(call('products_list',{}).products.length,1);
  for(const invoke of [
    ()=>create(call,'Чужой продукт',{product_id:other.product_id}),
    ()=>call('task_update',{task_id:alpha.id,product_id:other.product_id}),
    ()=>call('tasks_list',{product:other.product_id}),
    ()=>call('task_duplicates',{project:'beta',title:'Бета работа'})
  ])assert.throws(invoke,error=>error.status===404);
  assert.equal(create(call,'Без продукта').task.product_id,null);
  assert.deepEqual(call('tasks_list',{product:alpha.product_id}).tasks.map(row=>row.id),[alpha.id]);
  assert.throws(()=>db.prepare('UPDATE tasks SET product_id=? WHERE id=?').run(other.product_id,alpha.id),/TASK_PRODUCT_INVALID/);
  assert.throws(()=>db.prepare(`INSERT INTO tasks(created_at,updated_at,title,company_code,product_id)
    VALUES('now','now','Invalid raw product','alpha',?)`).run(other.product_id),/TASK_PRODUCT_INVALID/);
  assert.throws(()=>db.prepare("UPDATE products SET company_code='beta' WHERE id=?").run(alpha.product_id),/TASK_PRODUCT_INVALID/);
  assert.throws(()=>call('products_list',{}, {role:'editor',userId:7}),error=>error.status===403);
});

test('a second raw connection sees the same canonical products and idempotent task IDs',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'synapse-board-connection-'));
  const file=path.join(dir,'test.sqlite'),{call}=fixture(t,{file});
  const second=new DatabaseSync(file);t.after(()=>second.close());
  t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});});
  const secondApi=createTaskCoordination(second),invoke=(tool,args)=>secondApi.tool(tool,args,owner);
  const first=create(call,'Один запрос',{new_product:'Общий продукт'}).task;
  const retry=invoke('task_create',{title:'Повтор запроса',project:'alpha',client_ref:'sample:Один запрос',new_product:'Несозданный продукт'});
  assert.equal(retry.created,false);assert.equal(retry.task.id,first.id);
  assert.equal(invoke('products_list',{}).products.length,1);
  const canonical=invoke('task_create',{title:'Другая работа',project:'alpha',client_ref:'second-connection',new_product:'Общий продукт',force:true}).task;
  assert.equal(canonical.product_id,first.product_id);
  assert.throws(()=>second.prepare('INSERT INTO products(company_code,name,slug) VALUES(?,?,?)').run('ALPHA','Raw duplicate','общий-продукт'),/UNIQUE/);
});

test('plan changes, parent validation and raw legacy product/chat writes share revision protection',t=>{
  const {call,db}=fixture(t);
  const first=create(call,'Родитель',{new_product:'Сайт'}).task;
  const second=create(call,'Вторая задача').task;
  const updated=call('task_update',{task_id:second.id,revision:second.coordination.revision,parent_id:first.id,product_id:first.product_id,
    priority:'high',chat_url:'https://example.test/discussion'}).task;
  assert.equal(updated.parent_task_id,first.id);assert.equal(updated.product_name,'Сайт');assert.equal(updated.priority,'high');
  assert.throws(()=>call('task_update',{task_id:first.id,parent_id:second.id}),error=>error.status===400);
  assert.throws(()=>call('task_update',{task_id:second.id,parent_id:second.id}),error=>error.status===400);
  assert.throws(()=>call('task_update',{task_id:second.id,parent_id:11}),error=>error.status===404);
  db.prepare("UPDATE tasks SET product_id=NULL,chat_url='https://example.test/new-chat' WHERE id=?").run(second.id);
  const current=call('task_get',{task_id:second.id});assert.equal(current.coordination.revision,updated.coordination.revision+1);
  assert.throws(()=>call('task_update',{task_id:second.id,revision:updated.coordination.revision,next_step:'Устаревший план'}),error=>error.status===409);
  assert.equal(current.chat_url,'https://example.test/new-chat');
  for(const value of ['javascript:alert(1)','http://example.test/chat','https://user:pass@example.test/chat']) {
    assert.throws(()=>call('task_update',{task_id:second.id,chat_url:value}),error=>error.status===400);
  }
  assert.equal(call('task_update',{task_id:second.id,parent_id:null,product_id:null}).task.parent_task_id,null);
});

test('chat links preserve legacy compatibility and agent scope hides chat_url as well as chat',t=>{
  const {call}=fixture(t);
  const linked=create(call,'Со старой ссылкой',{links:[{url:'https://example.test/legacy',label:'Чат исполнителя',kind:'link'}]}).task;
  assert.equal(linked.chat_url,'https://example.test/legacy');
  const report=call('agent_report',{agent:'Sample agent',kind:'codex',state:'work',chat:'https://example.test/agent'}).agent;
  assert.equal(report.chat_url,'https://example.test/agent');
  const explicit=call('agent_report',{agent:'Sample agent',chat_url:'https://example.test/explicit'}).agent;
  assert.equal(explicit.chat,explicit.chat_url);
  const concealed=call('agents_list',{},beta).agents[0];assert.equal(concealed.chat,'');assert.equal(concealed.chat_url,'');
  assert.throws(()=>call('agent_report',{agent:'Sample agent',chat_url:'javascript:1'}),error=>error.status===400);
  assert.equal(call('agents_list',{}).agents[0].chat_url,'https://example.test/explicit');
});
