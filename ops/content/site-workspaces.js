'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TYPES = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8',
  '.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8',
  '.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.webp':'image/webp','.gif':'image/gif','.ico':'image/x-icon','.mp4':'video/mp4',
  '.webm':'video/webm','.woff':'font/woff','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8',
  '.webmanifest':'application/manifest+json','.xml':'application/xml; charset=utf-8',
  '.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.m4a':'audio/mp4',
  '.avif':'image/avif','.pdf':'application/pdf','.ttf':'font/ttf','.otf':'font/otf'};
const TEXT = new Set(['.html','.css','.js','.json','.svg','.txt','.webmanifest','.xml']);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (status,message) => {throw Object.assign(new Error(message),{status});};
const validPath = value => typeof value === 'string' && value.length > 0 && value.length <= 240 &&
  !value.includes('\\') && !value.includes('\0') && !value.startsWith('/') &&
  value.split('/').every(part => part && !part.startsWith('.') && /^[\w .@()\u0400-\u04ff-]+$/.test(part)) &&
  Boolean(TYPES[path.extname(value).toLowerCase()]);
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);

function createWorkspaceStore({db,root,sources={},companies,audit,snapshotExtras,maxBytes=512*1024*1024,maxFiles=4096}) {
  root = path.resolve(root);
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  if(fs.lstatSync(root).isSymbolicLink())throw new Error('Workspace root must not be a symbolic link');
  root = fs.realpathSync(root);
  db.exec(`CREATE TABLE IF NOT EXISTS site_workspaces(
    site_id TEXT PRIMARY KEY REFERENCES managed_sites(id), source_site_id TEXT NOT NULL,
    hostname TEXT NOT NULL UNIQUE, runtime TEXT NOT NULL, current_revision TEXT NOT NULL,
    clone_request_id TEXT NOT NULL, clone_actor_id INTEGER NOT NULL,
    clone_fingerprint TEXT NOT NULL, UNIQUE(clone_actor_id,clone_request_id));
    CREATE TABLE IF NOT EXISTS site_workspace_revisions(
      site_id TEXT NOT NULL REFERENCES site_workspaces(site_id), revision TEXT NOT NULL,
      version INTEGER NOT NULL, manifest_json TEXT NOT NULL, author_id INTEGER NOT NULL,
      created_at TEXT NOT NULL, message TEXT NOT NULL,
      PRIMARY KEY(site_id,revision), UNIQUE(site_id,version));`);
  const visible = (user,row) => user.role==='owner'||user.companyCodes.includes(row.company_code);
  const permission = (user,value) => user.role==='owner'||user.permissions.includes(value);
  const siteRow = (user,id) => {
    const row=db.prepare('SELECT * FROM managed_sites WHERE id=? AND deleted_at IS NULL').get(id);
    if(!row||!visible(user,row))fail(404,'Сайт не найден');
    return row;
  };
  const workspaceRow = (id) => db.prepare('SELECT * FROM site_workspaces WHERE site_id=?').get(id);
  const siteDir = row => path.join(root,row.company_code,'sites',row.id);
  const revisionDir = (row,revision) => path.join(siteDir(row),'versions',revision);
  const getRevision = (id,revision) => db.prepare('SELECT * FROM site_workspace_revisions WHERE site_id=? AND revision=?').get(id,revision);
  const sourceFor = row => {
    const workspace=workspaceRow(row.id);
    if(workspace)return {root:revisionDir(row,workspace.current_revision),runtime:workspace.runtime};
    const source=sources[row.id];
    if(!source||source.companyCode!==row.company_code)return null;
    return source;
  };
  const takeSnapshot = (source,target) => {
    const sourceRoot=fs.realpathSync(source);
    const manifest={};let total=0,count=0;
    const walk = (dir,prefix='') => {
      for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
        if(entry.name.startsWith('.')||['private','node_modules','backup'].includes(entry.name))continue;
        if(entry.isSymbolicLink())fail(409,'В источнике есть символическая ссылка; копия не создана');
        const relative=prefix+entry.name;
        if(entry.isDirectory()){walk(path.join(dir,entry.name),relative+'/');continue;}
        if(!entry.isFile()||!validPath(relative))continue;
        const sourceFile=path.join(sourceRoot,relative);
        const stat=fs.statSync(sourceFile);
        total+=stat.size;count++;
        if(total>maxBytes||count>maxFiles)fail(413,'Сайт превышает допустимый размер копии');
        const bytes=fs.readFileSync(sourceFile);
        if(bytes.length!==stat.size)fail(409,'Источник изменился; повторите клонирование');
        manifest[relative]={bytes:bytes.length,sha256:digest(bytes)};
        const destination=path.join(target,relative);
        fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
        fs.writeFileSync(destination,bytes,{mode:0o600,flag:'wx'});
      }
    };
    walk(sourceRoot);
    if(!manifest['index.html'])fail(409,'В исходном сайте нет главной страницы');
    // Recheck the complete source snapshot before accepting it; clients may be editing it.
    for(const [relative,entry]of Object.entries(manifest)) {
      if(digest(fs.readFileSync(path.join(sourceRoot,relative)))!==entry.sha256)
        fail(409,'Источник изменился; повторите клонирование');
    }
    return Object.fromEntries(Object.entries(manifest).sort(([a],[b])=>a.localeCompare(b)));
  };
  const copySource=(source,target)=>{
    const manifest=takeSnapshot(source.root,target);
    if(source.contentSiteId&&snapshotExtras) {
      const extras=snapshotExtras(source.contentSiteId);
      for(const [relative,value]of Object.entries(extras)) {
        if(!validPath(relative))throw new Error('Invalid trusted snapshot path');
        const bytes=Buffer.from(value),destination=path.join(target,relative);
        fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
        fs.writeFileSync(destination,bytes,{mode:0o600});
        manifest[relative]={bytes:bytes.length,sha256:digest(bytes)};
      }
    }
    if(Object.keys(manifest).length>maxFiles||Object.values(manifest).reduce((n,v)=>n+v.bytes,0)>maxBytes)
      fail(413,'Сайт превышает допустимый размер копии');
    return Object.fromEntries(Object.entries(manifest).sort(([a],[b])=>a.localeCompare(b)));
  };
  const requireWorkspace = (user,id,write=false) => {
    if(!permission(user,write?'site_editor.edit':'site_editor.view'))fail(403,'Нет доступа к редактору');
    const row=siteRow(user,id),workspace=workspaceRow(id);
    if(!workspace)fail(409,'Файлы этого сайта ещё не подключены к проекту');
    if(write&&row.publication_status!=='draft')fail(409,'Изменять можно только черновик');
    return {row,workspace};
  };
  const metadata = (row,workspace) => {
    const revision=getRevision(row.id,workspace.current_revision);
    return {revision:workspace.current_revision,version:revision.version,
      updatedAt:revision.created_at,sourceSiteId:workspace.source_site_id,
      hostname:workspace.hostname,runtime:workspace.runtime};
  };
  const enrich = (site,user) => {
    const row=siteRow(user,site.id),workspace=workspaceRow(site.id);
    const canClone=permission(user,'sites.create')&&permission(user,'site_editor.edit')&&Boolean(sourceFor(row));
    const result={...site,capabilities:{...site.capabilities,clone:canClone}};
    if(workspace) {
      result.workspace=metadata(row,workspace);
      result.editorUrls={...site.editorUrls,site:`/site-files.html?site=${encodeURIComponent(row.id)}`};
      result.capabilities.editSite=permission(user,'site_editor.edit');
      result.documents={...site.documents,site:true};
    }
    return result;
  };
  return {
    enrich,
    clone(user,{sourceSiteId,companyCode,name,requestId}) {
      if(!permission(user,'sites.create')||!permission(user,'site_editor.edit'))fail(403,'Нет доступа к клонированию');
      if(typeof name!=='string'||!name.trim()||name.length>120||
        !/^[a-z0-9][a-z0-9-]{0,39}$/.test(companyCode)||!companies[companyCode]||
        typeof requestId!=='string'||!/^[a-f0-9-]{36}$/i.test(requestId))fail(400,'Проверьте название и проект');
      const sourceRow=siteRow(user,sourceSiteId);
      if(sourceRow.company_code!==companyCode)fail(404,'Исходный сайт не относится к выбранному проекту');
      const source=sourceFor(sourceRow);
      if(!source)fail(409,'Для этого сайта ещё не подключены файлы для клонирования');
      const fingerprint=digest(JSON.stringify({sourceSiteId,companyCode,name:name.trim()}));
      const existing=db.prepare('SELECT * FROM site_workspaces WHERE clone_actor_id=? AND clone_request_id=?').get(user.id,requestId);
      if(existing) {
        if(existing.clone_fingerprint!==fingerprint)fail(409,'Этот запрос уже использован для другой копии');
        return siteRow(user,existing.site_id);
      }
      const id=`site-${crypto.randomBytes(10).toString('hex')}`;
      const row={id,company_code:companyCode};
      const folder=siteDir(row),staging=path.join(folder,'staging');
      fs.mkdirSync(staging,{recursive:true,mode:0o700});
      let committed=false;
      try {
        const manifest=copySource(source,staging),revision=digest(JSON.stringify(manifest));
        fs.mkdirSync(path.dirname(revisionDir(row,revision)),{recursive:true,mode:0o700});
        fs.renameSync(staging,revisionDir(row,revision));
        db.exec('BEGIN IMMEDIATE');
        try {
          let n=1,hostname;
          do {hostname=`${companyCode}-draft-${n++}.synapsebusiness.ru`;} while(db.prepare('SELECT 1 FROM site_workspaces WHERE hostname=?').get(hostname));
          const now=new Date().toISOString(),publicUrl=`https://${hostname}/`;
          db.prepare(`INSERT INTO managed_sites(id,company_code,name,source,is_active,publication_status,public_url,created_by,created_at,updated_at)
            VALUES(?,?,?,'managed',1,'draft',?,?,?,?)`).run(id,companyCode,name.trim(),publicUrl,user.id,now,now);
          db.prepare('INSERT INTO site_workspaces VALUES(?,?,?,?,?,?,?,?)')
            .run(id,sourceSiteId,hostname,source.runtime||'static',revision,requestId,user.id,fingerprint);
          db.prepare('INSERT INTO site_workspace_revisions VALUES(?,?,?,?,?,?,?)')
            .run(id,revision,1,JSON.stringify(manifest),user.id,now,'Клонирование сайта');
          audit(user.id,null,'SITE_CLONED',{siteId:id,companyCode,sourceSiteId,publicUrl,revision});
          db.exec('COMMIT');committed=true;
          return siteRow(user,id);
        } catch(error){db.exec('ROLLBACK');throw error;}
      } finally {
        if(!committed&&folder.startsWith(root+path.sep))fs.rmSync(folder,{recursive:true,force:true});
      }
    },
    adopt(user,id,{hostname}) {
      if(user.role!=='owner')fail(403,'Нет доступа');
      const row=siteRow(user,id);
      if(row.publication_status!=='draft')fail(409,'Подключать можно только черновик');
      if(workspaceRow(id))return this.workspace(user,id);
      if(!/^(?:[a-z0-9-]+-draft-\d+|palitra-draft)\.synapsebusiness\.ru$/.test(hostname))fail(400,'Некорректный адрес');
      const source=sourceFor(row);if(!source)fail(409,'Источник не подключён');
      const folder=siteDir(row),staging=path.join(folder,'staging');
      if(fs.existsSync(folder))fail(409,'Папка проекта уже существует');
      fs.mkdirSync(staging,{recursive:true,mode:0o700});let committed=false;
      try {
        const manifest=copySource(source,staging),revision=digest(JSON.stringify(manifest));
        fs.mkdirSync(path.dirname(revisionDir(row,revision)),{recursive:true,mode:0o700});
        fs.renameSync(staging,revisionDir(row,revision));
        db.exec('BEGIN IMMEDIATE');
        try {
          const stamp=new Date().toISOString(),requestId=crypto.randomUUID();
          db.prepare('INSERT INTO site_workspaces VALUES(?,?,?,?,?,?,?,?)')
            .run(id,id,hostname,source.runtime||'static',revision,requestId,user.id,digest(id+'\n'+hostname));
          db.prepare('INSERT INTO site_workspace_revisions VALUES(?,?,?,?,?,?,?)')
            .run(id,revision,1,JSON.stringify(manifest),user.id,stamp,'Подключение черновика к проекту');
          db.prepare('UPDATE managed_sites SET public_url=?,site_editor_url=?,updated_at=? WHERE id=?')
            .run('https://'+hostname+'/', '/site-files.html?site='+id,stamp,id);
          audit(user.id,null,'SITE_WORKSPACE_CONNECTED',{siteId:id,companyCode:row.company_code,hostname,revision});
          db.exec('COMMIT');committed=true;
        }catch(error){db.exec('ROLLBACK');throw error;}
        return this.workspace(user,id);
      }finally{if(!committed&&folder.startsWith(root+path.sep))fs.rmSync(folder,{recursive:true,force:true});}
    },
    workspace(user,id) {
      const {row,workspace}=requireWorkspace(user,id);
      const revision=getRevision(id,workspace.current_revision);
      const manifest=JSON.parse(revision.manifest_json);
      return {siteId:id,name:row.name,companyCode:row.company_code,publicUrl:row.public_url,
        ...metadata(row,workspace),files:Object.entries(manifest).map(([name,file])=>
          ({path:name,...file,editable:TEXT.has(path.extname(name).toLowerCase())&&file.bytes<=2*1024*1024}))};
    },
    file(user,id,filename) {
      const {row,workspace}=requireWorkspace(user,id);
      if(!validPath(filename))fail(400,'Некорректный путь файла');
      const manifest=JSON.parse(getRevision(id,workspace.current_revision).manifest_json);
      if(!manifest[filename])fail(404,'Файл не найден');
      if(!TEXT.has(path.extname(filename).toLowerCase())||manifest[filename].bytes>2*1024*1024)
        fail(415,'Этот файл нельзя редактировать как текст');
      const buffer=fs.readFileSync(path.join(revisionDir(row,workspace.current_revision),filename));
      if(digest(buffer)!==manifest[filename].sha256)fail(409,'Файл не соответствует сохранённой версии');
      const content=buffer.toString('utf8');
      if(!Buffer.from(content,'utf8').equals(buffer))fail(415,'Этот файл имеет другую кодировку и не поддерживает текстовое редактирование');
      return {path:filename,content,revision:workspace.current_revision};
    },
    save(user,id,{baseRevision,files,message}) {
      const {row,workspace}=requireWorkspace(user,id,true);
      if(baseRevision!==workspace.current_revision)fail(409,'Сайт уже изменён. Обновите редактор перед сохранением');
      if(!Array.isArray(files)||!files.length||files.length>100||typeof message!=='string'||message.length>240)
        fail(400,'Проверьте сохраняемые изменения');
      const baseManifest=JSON.parse(getRevision(id,baseRevision).manifest_json);
      const changes=new Map();let total=0;
      for(const file of files) {
        if(!file||Object.keys(file).sort().join(',')!=='content,path'||!validPath(file.path)||
          !TEXT.has(path.extname(file.path).toLowerCase())||typeof file.content!=='string'||changes.has(file.path))
          fail(400,'Некорректный файл');
        const bytes=Buffer.from(file.content,'utf8');total+=bytes.length;
        if(bytes.length>2*1024*1024||total>8*1024*1024)fail(413,'Изменения слишком большие');
        changes.set(file.path,bytes);
      }
      const manifest={...baseManifest};
      for(const [filename,bytes]of changes)manifest[filename]={bytes:bytes.length,sha256:digest(bytes)};
      const ordered=Object.fromEntries(Object.entries(manifest).sort(([a],[b])=>a.localeCompare(b)));
      if(same(ordered,baseManifest))return this.workspace(user,id);
      if(Object.keys(ordered).length>maxFiles||Object.values(ordered).reduce((sum,file)=>sum+file.bytes,0)>maxBytes)
        fail(413,'Сайт превышает допустимый размер');
      const revision=digest(JSON.stringify(ordered)+'\n'+baseRevision);
      const folder=siteDir(row),staging=path.join(folder,'staging-'+crypto.randomBytes(8).toString('hex'));
      fs.mkdirSync(staging,{mode:0o700});
      try {
        for(const filename of Object.keys(ordered)) {
          const target=path.join(staging,filename);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
          if(changes.has(filename))fs.writeFileSync(target,changes.get(filename),{mode:0o600,flag:'wx'});
          else {
            const bytes=fs.readFileSync(path.join(revisionDir(row,baseRevision),filename));
            if(digest(bytes)!==baseManifest[filename].sha256)fail(409,'Исходная версия повреждена');
            fs.writeFileSync(target,bytes,{mode:0o600,flag:'wx'});
          }
        }
        const target=revisionDir(row,revision);
        if(!fs.existsSync(target))fs.renameSync(staging,target);
        db.exec('BEGIN IMMEDIATE');
        try {
          const current=workspaceRow(id);
          if(current.current_revision!==baseRevision)fail(409,'Кто-то уже сохранил изменения. Обновите редактор');
          const stamp=new Date().toISOString();
          const previous=db.prepare('SELECT max(version) AS version FROM site_workspace_revisions WHERE site_id=?').get(id).version;
          if(!getRevision(id,revision))db.prepare('INSERT INTO site_workspace_revisions VALUES(?,?,?,?,?,?,?)')
            .run(id,revision,previous+1,JSON.stringify(ordered),user.id,stamp,message.trim()||'Сохранение изменений');
          db.prepare('UPDATE site_workspaces SET current_revision=? WHERE site_id=?').run(revision,id);
          db.prepare('UPDATE managed_sites SET updated_at=? WHERE id=?').run(stamp,id);
          audit(user.id,null,'SITE_FILES_SAVED',{siteId:id,companyCode:row.company_code,revision,files:[...changes.keys()]});
          db.exec('COMMIT');
        } catch(error){db.exec('ROLLBACK');throw error;}
        return this.workspace(user,id);
      } finally {if(fs.existsSync(staging))fs.rmSync(staging,{recursive:true,force:true});}
    },
    history(user,id) {
      requireWorkspace(user,id);
      return db.prepare('SELECT revision,version,created_at AS createdAt,message FROM site_workspace_revisions WHERE site_id=? ORDER BY version DESC').all(id);
    },
    publishedHost(hostname) {
      if(typeof hostname!=='string'||!hostname.endsWith('.synapsebusiness.ru'))return null;
      const row=db.prepare(`SELECT m.*,w.hostname,w.runtime,w.current_revision FROM managed_sites m JOIN site_workspaces w ON w.site_id=m.id
        WHERE w.hostname=? AND m.deleted_at IS NULL AND m.is_active=1`).get(hostname);
      return row ? {...row,root:revisionDir(row,row.current_revision)} : null;
    },
  };
}
module.exports={createWorkspaceStore,validPath,TYPES};
