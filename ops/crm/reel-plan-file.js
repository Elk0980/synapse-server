'use strict';
const {inflateRawSync}=require('node:zlib');
const {zipSync}=require('fflate');
const {readSheet}=require('read-excel-file/node');
const {Parser}=require('saxen');
const {fail,object}=require('./company-information');
const MAX_FILE=1024*1024,MAX_ROWS=94,MAX_COLS=32,MAX_XML=2*1024*1024;
const invalid=()=>fail(400,'Нужен CSV/XLSX до 1 МиБ: до 93 строк плана и 32 колонок');

function checkXml(xml) {
  if(/<!DOCTYPE|<!ENTITY/i.test(xml))invalid();
  const parser=new Parser();let cells=0,rows=0;
  parser.on('openTag',(name,getAttributes,decode)=>{
    const tag=name.split(':').at(-1),attrs=Object.fromEntries(Object.entries(getAttributes()).map(([key,value])=>[key.split(':').at(-1),decode(value)]));
    if(tag==='f'||/externalLink/i.test(tag)||attrs.TargetMode==='External'||Object.values(attrs).some(value=>/macroEnabled/i.test(value)))invalid();
    if(tag==='c'&&++cells>MAX_ROWS*MAX_COLS||tag==='row'&&++rows>MAX_ROWS)invalid();
    if((tag==='c'||tag==='row')&&attrs.r!==undefined) {
      const ref=/^([A-Z]*)([1-9]\d*)$/.exec(attrs.r);
      if(!ref||Number(ref[2])>MAX_ROWS||ref[1]&&(ref[1].length>2||[...ref[1]].reduce((v,c)=>v*26+c.charCodeAt(0)-64,0)>MAX_COLS))invalid();
    }
  });
  parser.on('error',invalid);parser.on('warn',invalid);parser.parse(xml);
}

function csv(input) {
  const source=new TextDecoder('utf-8',{fatal:true}).decode(input).replace(/^\uFEFF/,'');
  let inQuotes=false,commas=0,semicolons=0;
  for(let i=0;i<source.length;i++) {
    if(source[i]==='"'){if(inQuotes&&source[i+1]==='"')i++;else inQuotes=!inQuotes;}
    else if(!inQuotes){if(/[\r\n]/.test(source[i]))break;if(source[i]===',')commas++;if(source[i]===';')semicolons++;}
  }
  const separator=semicolons>commas?';':',';
  const rows=[];let row=[],value='',quoted=false,closed=false;
  const cell=()=>{row.push(value);value='';closed=false;if(row.length>MAX_COLS)invalid();};
  const line=()=>{cell();rows.push(row);row=[];if(rows.length>MAX_ROWS)invalid();};
  for(let i=0;i<source.length;i++) {
    const char=source[i];
    if(quoted) {
      if(char==='"'&&source[i+1]==='"'){value+='"';i++;}
      else if(char==='"'){quoted=false;closed=true;}else value+=char;
    } else if(char==='"') {if(value||closed)invalid();quoted=true;}
    else if(char===separator)cell();
    else if(char==='\n'||char==='\r'){if(char==='\r'&&source[i+1]==='\n')i++;line();}
    else {if(closed)invalid();value+=char;}
    if(value.length>20000)invalid();
  }
  if(quoted)invalid();
  if(value||row.length||closed)line();
  return rows;
}

// Extract only bounded central-directory entries, then rebuild a canonical ZIP.
// The spreadsheet reader never receives hidden local entries or untrusted size headers.
function workbook(input) {
  let end=input.length-22;
  while(end>=Math.max(0,input.length-65557)&&input.readUInt32LE(end)!==0x06054b50)end--;
  if(end<0||input.readUInt32LE(end)!==0x06054b50||input.readUInt16LE(end+4)||input.readUInt16LE(end+6)||end+22+input.readUInt16LE(end+20)!==input.length)invalid();
  const count=input.readUInt16LE(end+10),start=input.readUInt32LE(end+16),files=Object.create(null);
  if(!count||count>128||input.readUInt16LE(end+8)!==count||start+input.readUInt32LE(end+12)!==end)invalid();
  let at=start,total=0;
  for(let n=0;n<count;n++) {
    if(at+46>end||input.readUInt32LE(at)!==0x02014b50)invalid();
    const flags=input.readUInt16LE(at+8),method=input.readUInt16LE(at+10),packed=input.readUInt32LE(at+20);
    const size=input.readUInt32LE(at+24),length=input.readUInt16LE(at+28),local=input.readUInt32LE(at+42);
    const name=input.subarray(at+46,at+46+length).toString('utf8');
    at+=46+length+input.readUInt16LE(at+30)+input.readUInt16LE(at+32);
    if(at>end||(flags&1)||![0,8].includes(method)||size>MAX_XML||(total+=size)>8*MAX_FILE||
      !/^[\w\[\]./ -]+$/.test(name)||name.split('/').includes('..')||Object.hasOwn(files,name)||/\.bin$/i.test(name))invalid();
    if(local+30>start||input.readUInt32LE(local)!==0x04034b50||input.readUInt16LE(local+8)!==method)invalid();
    const nameLength=input.readUInt16LE(local+26),offset=local+30+nameLength+input.readUInt16LE(local+28);
    if(input.subarray(local+30,local+30+nameLength).toString('utf8')!==name||offset+packed>start)invalid();
    const compressed=input.subarray(offset,offset+packed);
    const bytes=method===8?inflateRawSync(compressed,{maxOutputLength:MAX_XML}):compressed;
    if(bytes.length!==size)invalid();
    if(/\.(xml|rels)$/i.test(name)) {
      checkXml(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    }
    files[name]=new Uint8Array(bytes);
  }
  if(at!==end||!files['xl/workbook.xml'])invalid();
  return Buffer.from(zipSync(files,{level:0}));
}

async function preview(body) {
  object(body,['filename','base64']);
  if(typeof body.filename!=='string'||!/\.(csv|xlsx)$/i.test(body.filename)||typeof body.base64!=='string'||
    body.base64.length>Math.ceil(MAX_FILE/3)*4||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.base64))invalid();
  try {
    const input=Buffer.from(body.base64,'base64');
    if(!input.length||input.length>MAX_FILE)invalid();
    const rows=/\.csv$/i.test(body.filename)?csv(input):await readSheet(workbook(input),1,{trim:false});
    if(rows.length<2||rows.length>MAX_ROWS||rows.some(row=>row.length>MAX_COLS))invalid();
    let total=0;
    return rows.map(row=>row.map(value=>{
      const result=value instanceof Date?value.toISOString().slice(0,10):String(value??'');
      if(result.length>20000||(total+=Buffer.byteLength(result,'utf8'))>2*MAX_FILE)invalid();return result;
    }));
  } catch(error) {if(error.status===400)throw error;invalid();}
}
/* Импорт хранит «=…», «+…», «-…», «@…» как обычный текст. Любая будущая выгрузка плана в CSV/XLSX
   обязана пропускать ячейки через exportCell: иначе таблица выполнит их как формулу (ревью PR 496). */
function exportCell(value) {
  const text=String(value??'');
  const safe=/^[=+\-@\t\r]/.test(text)?`'${text}`:text;
  return /[",;\r\n]/.test(safe)?`"${safe.replace(/"/g,'""')}"`:safe;
}
module.exports={preview,exportCell};
