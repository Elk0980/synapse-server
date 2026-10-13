'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createWorkspaceStore,validPath}=require('./site-workspaces');
const {createWorkspaceRoutes}=require('./site-workspace-routes');
const {createDraftHostHandler}=require('./site-workspace-http');
const {AccountService}=require('./draft-account-service.cjs');
function createWorkspaceFeature({db,authStore,companies,siteStore,requirePermission,requireCsrf,readJson,databasePath,assetsDir,palitraShop=null}) {
  const root=path.join(path.dirname(databasePath),'projects');
  const configured={
    'palitra-love':{root:'/site-sources/palitra-love',companyCode:'palitra-love',contentSiteId:'palitra'},
    'site-44bbe13f1bad5e005b2a':{root:'/site-sources/palitra-draft',companyCode:'palitra-love',runtime:'palitra-draft'},
    alvi:{root:'/site-sources/alvi',companyCode:'alvi',contentSiteId:'alvi'},
    avokado:{root:'/site-sources/avokado',companyCode:'avokado',contentSiteId:'avokado'},
    avokado2:{root:'/site-sources/avokado2',companyCode:'avokado',contentSiteId:'avokado2'},
    avokado3:{root:'/site-sources/avokado3',companyCode:'avokado',contentSiteId:'avokado3'},
    taisabai:{root:'/site-sources/taisabai',companyCode:'taisabai'},
    vhod:{root:'/site-sources/vhod',companyCode:'synapse-business'}
  };
  const sources=Object.fromEntries(Object.entries(configured).filter(([,source])=>fs.existsSync(path.join(source.root,'index.html'))));
  const snapshotExtras=site=>{
    const result={};
    for(const kind of ['site','price']) {
      const doc=db.prepare('SELECT body FROM documents WHERE key=? ORDER BY version DESC LIMIT 1').get(site+'/'+kind);
      if(doc)result['data/'+kind+'.json']=Buffer.from(doc.body);
    }
    // These are the existing public product/background assets, not CRM attachments.
    const dir=path.join(assetsDir,site);
    if(fs.existsSync(dir))for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      const relative='data/assets/'+entry.name;
      if(entry.isFile()&&validPath(relative))result[relative]=fs.readFileSync(path.join(dir,entry.name));
    }
    return result;
  };
  const store=createWorkspaceStore({db,root,sources,companies,audit:authStore.audit,snapshotExtras});
  const routes=createWorkspaceRoutes({workspaces:store,siteStore,requirePermission,requireCsrf,readJson});
  // PALITRA: only the fixed shop workspace may use its explicitly approved shop origin (host config); all other drafts unchanged.
  const shop=palitraShop&&typeof palitraShop==='object'&&typeof palitraShop.origin==='string'?palitraShop:null;
  const isShop=draft=>Boolean(shop&&draft&&draft.id===shop.draftId&&draft.company_code===shop.companyCode&&draft.runtime==='palitra-draft');
  const publicHost=createDraftHostHandler(store,{accountFactory:draft=>{
    const folder=path.join(root,draft.company_code,'sites',draft.id,'private');
    fs.mkdirSync(folder,{recursive:true,mode:0o700});
    if(isShop(draft))return new AccountService({database:path.join(folder,'draft-accounts.sqlite'),origin:shop.origin,approvedOrigin:shop.origin});
    return new AccountService({database:path.join(folder,'draft-accounts.sqlite'),origin:'https://'+draft.hostname});
  },alias:shop&&shop.hostname!==shop.canonicalHostname?{hostname:shop.hostname,canonicalHostname:shop.canonicalHostname,draftId:shop.draftId,companyCode:shop.companyCode}:null});
  /* PALITRA: the existing AccountService of exactly the fixed shop workspace (same instance as /api/draft-account/*).
     No new database; passwords, cookies and the account file are not exposed beyond server-side session checks. */
  const draftAccount=()=>{
    if(!shop)return null;
    const draft=store.publishedHost(shop.canonicalHostname);
    return isShop(draft)?publicHost.accountFor(draft):null;
  };
  const setDraftHook=hook=>publicHost.setDraftHook(hook);
  return {store,routes,publicHost,draftAccount,setDraftHook};
}
module.exports={createWorkspaceFeature};
