'use strict';
// Узкий потоковый multipart: один файл, ограниченные текстовые поля, без сторонних пакетов.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
async function readSourceMultipart(request,{storage,maxFile,upload=false}) {
  const type=String(request.headers['content-type']||'');
  const parsed=/^multipart\/form-data\s*;\s*boundary=(?:"([a-zA-Z0-9'()+_,.\/:=? -]{1,70})"|([a-zA-Z0-9'()+_,.\/:=?-]{1,70}))\s*$/i.exec(type);
  if(!parsed)fail(415,upload?'Выберите файл для загрузки':'Выберите файл для ручного импорта');
  const maxBody=maxFile+65536;
  if(Number(request.headers['content-length'])>maxBody)fail(413,'Файл превышает предел ручного импорта');
  const boundary=parsed[1]||parsed[2], first=Buffer.from('--'+boundary+'\r\n'), marker=Buffer.from('\r\n--'+boundary);
  let buffer=Buffer.alloc(0),state='first',part=null,file=null,fd=null,tempDir=null,total=0;
  const fields={},seen=new Set(),allowed=new Set(upload?['file','caption','metadata']:['file','telegramUrl','sourceChatId','provenance','caption']);
  async function cleanup(){if(fd){await fd.close().catch(()=>{});fd=null;}if(file?.path)fs.rmSync(file.path,{force:true});if(tempDir)fs.rmdirSync(tempDir);}
  async function data(bytes){
    if(!bytes.length)return;
    part.size+=bytes.length;
    if(part.name==='file'){
      if(part.size>maxFile)fail(413,'Файл превышает предел ручного импорта');
      part.hash.update(bytes);if(part.head.length<32)part.head=Buffer.concat([part.head,bytes.subarray(0,32-part.head.length)]);
      await fd.writeFile(bytes);
    }else{
      if(part.size>(part.name==='caption'?48000:part.name==='metadata'?16000:4000))fail(400,'Текстовое поле слишком длинное');
      part.chunks.push(Buffer.from(bytes));
    }
  }
  async function endPart(){
    if(part.name==='file'){await fd.close();fd=null;file.size=part.size;file.sha256=part.hash.digest('hex');file.head=part.head;}
    else fields[part.name]=Buffer.concat(part.chunks).toString('utf8');
    part=null;
  }
  async function process(){
    while(true){
      if(state==='first'){
        if(buffer.length<first.length)return;
        if(!buffer.subarray(0,first.length).equals(first))fail(400,'Некорректное начало multipart');
        buffer=buffer.subarray(first.length);state='headers';
      }else if(state==='headers'){
        const end=buffer.indexOf('\r\n\r\n');
        if(end<0){if(buffer.length>8192)fail(400,'Слишком длинные заголовки файла');return;}
        if(end>8192)fail(400,'Слишком длинные заголовки файла');
        const headers={};
        for(const line of buffer.subarray(0,end).toString('utf8').split('\r\n')){
          const colon=line.indexOf(':');if(colon<1)fail(400,'Некорректный заголовок файла');
          const key=line.slice(0,colon).toLowerCase(),value=line.slice(colon+1).trim();
          if(Object.hasOwn(headers,key)||!['content-disposition','content-type'].includes(key))fail(400,'Недопустимый заголовок файла');
          headers[key]=value;
        }
        const disposition=/^form-data;\s*name="([A-Za-z]+)"(?:;\s*filename="([^"\r\n]*)")?$/.exec(headers['content-disposition']||'');
        const name=disposition?.[1];
        if(!allowed.has(name)||seen.has(name)||seen.size>=4)fail(400,upload?'Нужен один файл и необязательные сведения':'Нужны один файл и его происхождение');
        seen.add(name);part={name,size:0,chunks:[]};
        if(name==='file'){
          if(disposition[2]===undefined)fail(400,'Не выбран файл');
          fs.mkdirSync(storage,{recursive:true,mode:0o700});tempDir=fs.mkdtempSync(path.join(storage,'.upload-'));
          file={path:path.join(tempDir,'payload'),name:disposition[2],mime:headers['content-type']||''};
          fd=await fs.promises.open(file.path,'wx',0o600);part.hash=crypto.createHash('sha256');part.head=Buffer.alloc(0);
        }else if(disposition[2]!==undefined)fail(400,'Вместо текстового поля передан файл');
        buffer=buffer.subarray(end+4);state='data';
      }else if(state==='data'){
        let found=-1,search=0;
        while(true){
          const at=buffer.indexOf(marker,search);if(at<0)break;
          if(buffer.length<at+marker.length+2){await data(buffer.subarray(0,at));buffer=buffer.subarray(at);return;}
          const suffix=buffer.toString('ascii',at+marker.length,at+marker.length+2);
          if(suffix==='--'||suffix==='\r\n'){found=at;break;}search=at+1;
        }
        if(found<0){const keep=marker.length+2;if(buffer.length>keep){await data(buffer.subarray(0,buffer.length-keep));buffer=buffer.subarray(buffer.length-keep);}return;}
        await data(buffer.subarray(0,found));await endPart();
        const next=found+marker.length,closed=buffer.toString('ascii',next,next+2)==='--';
        buffer=buffer.subarray(next+2);state=closed?'closed':'headers';
      }else{
        if(buffer.length>2||(buffer.length&&buffer[0]!==13)||(buffer.length===2&&buffer[1]!==10))fail(400,'Некорректное окончание multipart');
        return;
      }
    }
  }
  try{
    for await(const chunk of request){total+=chunk.length;if(total>maxBody)fail(413,'Файл превышает предел ручного импорта');buffer=Buffer.concat([buffer,chunk]);await process();}
    if(state!=='closed'||!file||!file.size)fail(400,'Загрузка файла не завершена');
    if(buffer.length===1)fail(400,'Загрузка файла не завершена');
    return {file,fields,cleanup};
  }catch(error){await cleanup();throw error;}
}
module.exports={readSourceMultipart};
