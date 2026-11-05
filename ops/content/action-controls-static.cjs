'use strict';
const fs=require('node:fs'),path=require('node:path');
// Two public, non-personal assets only. No sessions, API proxy, directory listing or write.
function create(publicDir){
 const allowed={'/content/ui/palitra-action-icons.js':['palitra-action-icons.js','application/javascript; charset=utf-8'],'/content/ui/palitra-action-icons.css':['palitra-action-icons.css','text/css; charset=utf-8']};
 return function handle(req,res){const url=new URL(req.url,'https://synapse.synapsebusiness.ru'),entry=allowed[url.pathname];if(!entry)return false;
  const host=String(req.headers.host||'').toLowerCase();if(!['synapse.synapsebusiness.ru','palitra-love.ru','synapse.synapsebusiness.ru:443','palitra-love.ru:443'].includes(host)){res.writeHead(404,{'cache-control':'no-store'});res.end();return true;}
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{allow:'GET, HEAD','cache-control':'no-store'});res.end();return true;}
  const dir=fs.realpathSync(publicDir),file=fs.realpathSync(path.join(dir,entry[0]));if(path.dirname(file)!==dir)throw Error('ACTION_ASSET_PATH');const data=fs.readFileSync(file);res.writeHead(200,{'content-type':entry[1],'content-length':data.length,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(req.method==='HEAD'?undefined:data);return true;
 };
}
module.exports={create};
