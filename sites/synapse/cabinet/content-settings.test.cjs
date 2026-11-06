const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{JSDOM}=require('jsdom');
test('№181: поле таблицы есть в прежних настройках, сохраняется существующим API и закрыто для читателя',async()=>{
 for(const canEdit of [true,false]){
  const dom=new JSDOM('<main id="root"></main>',{runScripts:'outside-only',url:'https://sample.test'}),w=dom.window;let def,saved;
  const data={settings:{approverUserIds:[],shootingWeekdays:[],deadlineDays:2,platforms:[],caption:{font:'Inter',size:'m',color:'#ffffff',uppercase:false}},canEdit,candidates:[],options:{fonts:['Inter'],sizes:['m'],platforms:['vk']},version:1};
  w.SynapseModules={register:(name,d)=>{def=d}};w.eval(fs.readFileSync(path.join(__dirname,'content-settings.js'),'utf8'));
  const root=w.document.querySelector('#root');await def.mount(root,{signal:new w.AbortController().signal,settings:{content:{get:async()=>data,save:async(settings,version)=>{saved={settings,version};return {...data,settings,version:2}}}}});
  const field=root.querySelector('[name="contentPlanSheetUrl"]');assert.equal(field.disabled,!canEdit);
  if(canEdit){field.value='https://docs.google.com/spreadsheets/d/sample/edit';root.querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await new Promise(setImmediate);assert.equal(saved.settings.contentPlanSheetUrl,field.value);assert.equal(saved.version,1);}
  w.close();
 }
});
