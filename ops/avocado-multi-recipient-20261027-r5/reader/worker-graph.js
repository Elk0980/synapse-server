const fs=require('node:fs'),c=require('node:crypto'),p=require('node:path');
const names=Object.freeze(["client-bot-bridge.js","client-bot-config.js","client-bot-registry.js","consent-texts.json","project-chat-bridge.js","quiet-hours.js","server.js","task-intake.js","telegram-binding.js","telegram-channel-stats.js"]),files={};
if(fs.realpathSync('/app')!=='/app'||!fs.lstatSync('/app').isDirectory()||fs.lstatSync('/app').isSymbolicLink()||process.cwd()!=='/app')throw Error('APP_BOUNDARY');
for(const name of names){const f=p.join('/app',name),limit=2*1024*1024;let fd=null;
 try{const s=fs.lstatSync(f);if(!s.isFile()||s.isSymbolicLink()||fs.realpathSync(f)!==f||s.size>limit)throw Error('FILE_BOUNDARY');
  fd=fs.openSync(f,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const first=fs.fstatSync(fd);if(first.dev!==s.dev||first.ino!==s.ino||first.size!==s.size)throw Error('FILE_RACE');
  let size=0,n;const buffer=Buffer.alloc(65536),h=c.createHash('sha256');while((n=fs.readSync(fd,buffer,0,Math.min(buffer.length,limit+1-size),null))>0){size+=n;if(size>limit)throw Error('FILE_LIMIT');h.update(buffer.subarray(0,n));}
  const end=fs.fstatSync(fd),last=fs.lstatSync(f);if(size!==s.size||end.size!==s.size||end.mtimeMs!==s.mtimeMs||end.ctimeMs!==s.ctimeMs||last.dev!==s.dev||last.ino!==s.ino||last.size!==s.size||last.mtimeMs!==s.mtimeMs||last.ctimeMs!==s.ctimeMs||last.isSymbolicLink()||fs.realpathSync(f)!==f)throw Error('FILE_RACE');
  files[name]={available:true,size,mode:s.mode&4095,sha256:h.digest('hex')};
 }catch{files[name]={available:false};}finally{if(fd!==null)fs.closeSync(fd);}}
console.log(JSON.stringify({schema:1,files}));