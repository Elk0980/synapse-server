'use strict';const f=require('node:fs'),c=require('node:crypto');const ROOT='/app';
if(f.realpathSync(ROOT)!==ROOT)throw Error('APP_ROOT_ALIAS');let count=0,total=0;const out={};
const safe=n=>Number.isSafeInteger(n)&&n>=0,hash=x=>c.createHash('sha256').update(x).digest('hex');
function walk(p,rel){if(++count>50000||rel.length>2048)throw Error('TREE_BOUND');const s=f.lstatSync(p);
 if(![s.uid,s.gid,s.mode&511,s.nlink,s.size].every(safe))throw Error('STAT_TYPES');
 const row={uid:s.uid,gid:s.gid,mode:s.mode&4095};
 if(s.isSymbolicLink()){if(s.nlink!==1)throw Error('LINK_COUNT');const link=f.readlinkSync(p);if(link.length>4096)throw Error('LINK_BOUND');out[rel]={...row,type:'symlink',nlink:1,linkSha256:hash(link)};return;}
 if(s.isDirectory()){out[rel]={...row,type:'directory'};const names=f.readdirSync(p).sort();for(const n of names){if(n==='.'||n==='..'||n.includes('/')||n.includes('\\'))throw Error('ENTRY_NAME');walk(p+'/'+n,rel?rel+'/'+n:n);}return;}
 if(!s.isFile()||s.nlink!==1||s.size>67108864||(total+=s.size)>1073741824)throw Error('REGULAR_BOUNDED_FILE');
 let fd;try{fd=f.openSync(p,f.constants.O_RDONLY|f.constants.O_NOFOLLOW|f.constants.O_NONBLOCK);const a=f.fstatSync(fd);
  if(!a.isFile()||a.dev!==s.dev||a.ino!==s.ino||a.size!==s.size||a.nlink!==1)throw Error('OPEN_RACE');
  const h=c.createHash('sha256'),buf=Buffer.alloc(65536);let bytes=0,n;while((n=f.readSync(fd,buf,0,buf.length,null))>0){bytes+=n;if(bytes>s.size)throw Error('READ_BOUND');h.update(buf.subarray(0,n));}
  const z=f.fstatSync(fd),q=f.lstatSync(p);for(const k of ['dev','ino','size','mtimeMs','ctimeMs','uid','gid','mode','nlink'])if(s[k]!==z[k]||s[k]!==q[k])throw Error('FILE_CHANGED');
  if(bytes!==s.size)throw Error('READ_SIZE');out[rel]={...row,type:'file',nlink:1,bytes,sha256:h.digest('hex')};
 }finally{if(fd!==undefined)f.closeSync(fd);}}
walk(ROOT,'');process.stdout.write(JSON.stringify(out));