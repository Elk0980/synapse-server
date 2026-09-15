const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM,VirtualConsole}=require('jsdom');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

async function preview(site,{delayedLoad=false}={}) {
  const messages=[],errors=[];let release;
  const data={sections:[{id:'hero-0',fields:[{key:'hero-0.title',value:'Published text'}]}]};
  const vc=new VirtualConsole();vc.on('jsdomError',error=>errors.push(error.message));
  const dom=new JSDOM('<!doctype html><html><head></head><body><section id="hero-0"><h1 data-edit="hero-0.title">HTML fallback</h1></section></body></html>',{
    url:`https://${site}.synapsebusiness.ru/?edit=1`,runScripts:'outside-only',virtualConsole:vc,
  });
  const w=dom.window;
  Object.defineProperty(w,'parent',{value:{postMessage:(message,origin)=>messages.push({message,origin})}});
  w.CSS={escape:value=>value};w.matchMedia=()=>({matches:false});
  w.document.execCommand=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.fetch=()=>delayedLoad?new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>structuredClone(data)});}):Promise.resolve({ok:true,json:async()=>structuredClone(data)});
  w.eval(fs.readFileSync(path.join(__dirname,`../${site}/site-apply.js`),'utf8'));
  const settle=async()=>{for(let i=0;i<5;i++)await tick();};
  await settle();
  const send=message=>w.dispatchEvent(new w.MessageEvent('message',{origin:'https://synapse.synapsebusiness.ru',data:message}));
  const update=value=>send({type:'alvi-edit-doc',doc:{sections:[{id:'hero-0',fields:[{key:'hero-0.title',value}]}]}});
  return {w,element:w.document.querySelector('[data-edit]'),messages,errors,send,update,settle,release:()=>release(),close:()=>w.close()};
}

for(const site of ['alvi','avokado3']) {
  test(`${site}: selected text updates from the inspector while direct content editing preserves the caret`,async()=>{
    const f=await preview(site);try{
      assert.equal(f.element.textContent,'Published text');
      f.send({type:'alvi-edit-scroll',key:'hero-0.title'});
      assert.equal(f.element.getAttribute('contenteditable'),null);
      f.update('Changed in inspector');
      assert.equal(f.element.textContent,'Changed in inspector','selection alone must not suppress inspector preview');
      f.element.dispatchEvent(new f.w.MouseEvent('dblclick',{bubbles:true,cancelable:true}));
      assert.equal(f.element.getAttribute('contenteditable'),'true');
      f.element.textContent='Typing in the preview';
      const selection=f.w.getSelection(),range=f.w.document.createRange();
      range.selectNodeContents(f.element);range.collapse(false);selection.removeAllRanges();selection.addRange(range);
      const textNode=selection.anchorNode,offset=selection.anchorOffset;
      f.element.dispatchEvent(new f.w.Event('input',{bubbles:true}));
      f.update('Delayed editor echo');
      assert.equal(f.element.textContent,'Typing in the preview');
      assert.equal(selection.anchorNode,textNode);assert.equal(selection.anchorOffset,offset);
      assert.ok(f.messages.some(({message})=>message.type==='alvi-edit-change'&&message.value==='Typing in the preview'));
      f.element.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      f.update('Inspector after text mode');
      assert.equal(f.element.textContent,'Inspector after text mode');assert.deepEqual(f.errors,[]);
    }finally{f.close();}
  });

  test(`${site}: a slow initial public read cannot overwrite a newer editor draft`,async()=>{
    const f=await preview(site,{delayedLoad:true});try{
      f.update('Unsaved editor draft');assert.equal(f.element.textContent,'Unsaved editor draft');
      f.release();await f.settle();
      assert.equal(f.element.textContent,'Unsaved editor draft');assert.deepEqual(f.errors,[]);
    }finally{f.close();}
  });
}
