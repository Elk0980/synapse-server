'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {zipSync,strToU8}=require('fflate');
const {preview}=require('./reel-plan-file');
const NS='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const request=(filename,bytes)=>({filename,base64:Buffer.from(bytes).toString('base64')});
const csv=source=>preview(request('synthetic.csv',Buffer.from(source)));
const reject=body=>assert.rejects(preview(body),error=>error.status===400);
function xlsx({epoch1904=false,sheet,extra={}}={}) {
  const files={
    '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>',
    '_rels/.rels':`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="root" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml':`<workbook xmlns="${NS}" xmlns:r="${REL}"><workbookPr date1904="${epoch1904?1:0}"/><sheets><sheet name="Первый" sheetId="1" r:id="sheet"/><sheet name="Второй" sheetId="2" r:id="second"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="sheet" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="second" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="strings" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="styles" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    'xl/sharedStrings.xml':`<sst xmlns="${NS}"><si><t>Дата</t></si><si><r><t>Первая реплика</t></r><r><t> и вторая</t></r></si></sst>`,
    'xl/styles.xml':`<styleSheet xmlns="${NS}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml':sheet||`<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Сценарий</t></is></c></row><row r="2"><c r="A2" s="1"><v>${epoch1904?24107:25569}</v></c><c r="B2" t="s"><v>1</v></c></row></sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml':`<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Другой лист</t></is></c></row></sheetData></worksheet>`,...extra
  };
  return request('synthetic.xlsx',zipSync(Object.fromEntries(Object.entries(files).map(([name,text])=>[name,strToU8(text)]))));
}
test('CSV preserves UTF-8/BOM, escaped quotes and multiline scripts with either delimiter',async()=>{
  assert.deepEqual(await csv('\uFEFFДата;Сценарий\r\n2026-11-04;"Первая; реплика\nВторая ""цитата"""\r\n'),
    [['Дата','Сценарий'],['2026-11-04','Первая; реплика\nВторая "цитата"']]);
  assert.deepEqual(await csv('Дата,Тема\n2026-11-04,"Вопрос, ответ"'),[['Дата','Тема'],['2026-11-04','Вопрос, ответ']]);
  assert.deepEqual(await csv('"Что, где, когда";Дата\nСценарий;2026-11-04'),[['Что, где, когда','Дата'],['Сценарий','2026-11-04']]);
});
test('CSV rejects empty, broken quoting, invalid UTF-8 and oversized row/column/file input',async()=>{
  for(const value of ['', '\uFEFF', 'Только заголовок', 'Тема,Дата\n"Не закрыто,2026-11-04'])await reject(request('bad.csv',Buffer.from(value)));
  await reject(request('bad.csv',Buffer.from([0xff,0xfe,0x61])));
  assert.equal((await csv('Тема\n'+Array.from({length:93},(_,i)=>`Строка ${i}`).join('\n'))).length,94);
  await reject(request('bad.csv',Buffer.from('Тема\n'+Array.from({length:94},()=> 'Лишняя').join('\n'))));
  assert.equal((await csv(Array.from({length:32},()=> 'Колонка').join(',')+'\n'+Array.from({length:32},()=> 'Текст').join(',')))[0].length,32);
  await reject(request('bad.csv',Buffer.from(Array.from({length:33},()=> 'Колонка').join(',')+'\nТекст')));
  await reject(request('bad.csv',Buffer.alloc(1024*1024+1,65)));
});
test('XLSX reads first sheet, inline/shared rich strings and both Excel date epochs',async()=>{
  for(const epoch1904 of [false,true])assert.deepEqual(await preview(xlsx({epoch1904})),
    [['Дата','Сценарий'],['1970-01-01','Первая реплика и вторая']]);
});
test('XLSX rejects formulas, external relations, macros, DTD and excessive coordinates',async()=>{
  const sheet=body=>`<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Тема</t></is></c></row>${body}</sheetData></worksheet>`;
  for(const body of ['<row r="2"><c r="A2"><f>1+1</f><v>2</v></c></row>',
    '<row r="95"><c r="A95"><v>1</v></c></row>','<row r="2"><c r="AG2"><v>1</v></c></row>',
    '<x:row xmlns:x="urn:sample" r="95"><x:c r="A95"><v>1</v></x:c></x:row>',
    '<row r="2"><c note=">" r="A&#57;5"><v>1</v></c></row>'])await reject(xlsx({sheet:sheet(body)}));
  for(const extra of [
    {'xl/vbaProject.bin':'macro fixture'},
    {'xl/externalLinks/externalLink1.xml':'<externalLink/>'},
    {'xl/worksheets/_rels/sheet1.xml.rels':'<Relationships><Relationship Target="https://example.test/" TargetMode="External"/></Relationships>'},
    {'custom.xml':'<!DOCTYPE fixture [<!ENTITY value "x">]><fixture>&value;</fixture>'},
    {'xl/sheets/alternate.xml':'<worksheet><row r="10000"><c r="A10000"><v>1</v></c></row></worksheet>'}
  ])await reject(xlsx({extra}));
});
test('XLSX rejects compressed oversized XML and malformed archives without returning partial rows',async()=>{
  const repeated=Array.from({length:94},(_,i)=>`<row r="${i+1}"><c r="A${i+1}" t="s"><v>0</v></c><c r="B${i+1}" t="s"><v>0</v></c></row>`).join('');
  await reject(xlsx({sheet:`<worksheet xmlns="${NS}"><sheetData>${repeated}</sheetData></worksheet>`,
    extra:{'xl/sharedStrings.xml':`<sst xmlns="${NS}"><si><t>${'x'.repeat(20000)}</t></si></sst>`}}));
  const bomb=xlsx({extra:{'oversized.xml':'<fixture>'+ 'x'.repeat(2*1024*1024)+'</fixture>'}});
  await reject(bomb);
  const forged=Buffer.from(bomb.base64,'base64');
  for(let at=0;at+46<forged.length;at++)if(forged.readUInt32LE(at)===0x02014b50&&
    forged.subarray(at+46,at+46+forged.readUInt16LE(at+28)).toString()==='oversized.xml') {
    forged.writeUInt32LE(1,at+24);break; // False declared size must not bypass the inflate limit.
  }
  await reject(request('forged.xlsx',forged));
  for(const bytes of [Buffer.alloc(0),Buffer.from('not a workbook'),Buffer.from([0x50,0x4b,3,4])])await reject(request('bad.xlsx',bytes));
  const file=xlsx();await reject({...file,base64:file.base64.slice(0,-8)});
});

test('export escaping neutralises formula-looking cells kept as text by import',()=>{
  const {exportCell}=require('./reel-plan-file');
  assert.equal(exportCell('=HYPERLINK("x")'),`"'=HYPERLINK(""x"")"`);
  for(const value of ['+7 900','-1','@SUM(A1)'])assert.equal(exportCell(value),`'${value}`);
  assert.equal(exportCell('Обычная тема'),'Обычная тема');assert.equal(exportCell('a;b'),'"a;b"');
});
