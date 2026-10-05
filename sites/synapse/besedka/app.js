/* Single-project workshop. All user data stays in the browser. */
'use strict';
const G=window.BesedkaGeometry,$=id=>document.getElementById(id);
const fields=['length','width','height','roof','rise','material','region','notes'];
const storageKey='besedka-work-v1';let current=null,mesh=null,svgText='',fileUrl=null;
function raw(){return Object.fromEntries(fields.map(k=>[k,$(k).value]));}
function write(p){for(const k of fields)$(k).value=p[k]??'';}
function persist(){try{localStorage.setItem(storageKey,JSON.stringify({version:1,project:'Беседка',parameters:raw()}));}catch{$('feedback').textContent='Автосохранение недоступно. Сохраните работу в файл.';}}
function download(text,type,name){const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
function escapeXml(s){return String(s).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));}
function drawing(p){
  const scale=Math.min(610/p.length,200/p.width),l=p.length*scale,w=p.width*scale,x=(800-l)/2,y=110;
  const hs=Math.min(610/p.width,175/(p.height+p.rise)),fl=p.width*hs,fh=p.height*hs,fr=p.rise*hs,fx=(800-fl)/2,fy=640;
  const n=v=>Number(v.toFixed(2));
  const dim=(a,b,c,d,t)=>`<path d="M${a} ${b} L${c} ${d}" stroke="#567260" marker-start="url(#arrow)" marker-end="url(#arrow)"/><text x="${(a+c)/2}" y="${(b+d)/2-8}" text-anchor="middle">${t}</text>`;
  const front=p.roof==='shed'
    ? `<path d="M${fx} ${fy}V${fy-fh-fr}L${fx+fl} ${fy-fh}V${fy}" fill="none" stroke="#33553e" stroke-width="3"/>`
    : `<path d="M${fx} ${fy}V${fy-fh}H${fx+fl}V${fy}" fill="none" stroke="#33553e" stroke-width="3"/>${p.roof==='gable'?`<path d="M${fx} ${fy-fh}L400 ${fy-fh-fr}L${fx+fl} ${fy-fh}" fill="#e3eade" stroke="#33553e" stroke-width="2"/>`:''}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 740"><defs><marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10" fill="none" stroke="#567260"/></marker></defs><style>text{font-family:Arial,sans-serif;font-size:16px;fill:#26352f}path,rect{vector-effect:non-scaling-stroke}</style><text x="40" y="38" style="font-size:25px;font-weight:bold">Беседка — эскиз</text><text x="40" y="68">Вид сверху · размеры в метрах</text><rect x="${x}" y="${y}" width="${l}" height="${w}" fill="#f0f3ec" stroke="#33553e" stroke-width="2"/>${dim(x,y+w+35,x+l,y+w+35,n(p.length)+' м')}${dim(x-25,y,x-25,y+w,n(p.width)+' м')}${p.roof==='gable'?`<path d="M${x} ${y+w/2}H${x+l}" stroke="#33553e" stroke-dasharray="8 6"/>`:''}<text x="40" y="410">Вид с торца</text>${front}${dim(fx,fy+30,fx+fl,fy+30,n(p.width)+' м')}${dim(fx-30,fy,fx-30,fy-fh,n(p.height)+' м')}<text x="40" y="710">Материал: ${escapeXml(p.material||'не уточнён')} · Сечения и узлы не рассчитаны</text></svg>`;
}
function viewer(canvas){
  let data=null,yaw=.65,pitch=.45,zoom=1,drag=null,mode='design',dimensions=null;
  const ctx=canvas.getContext('2d');
  function render(){
    const r=canvas.getBoundingClientRect(),ratio=Math.min(devicePixelRatio||1,2);canvas.width=r.width*ratio;canvas.height=r.height*ratio;ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,r.width,r.height);
    const bg=ctx.createLinearGradient(0,0,0,r.height);bg.addColorStop(0,mode==='design'?'#f4f0e7':'#f8fbfc');bg.addColorStop(1,mode==='design'?'#e1e6d9':'#e7eff1');ctx.fillStyle=bg;ctx.fillRect(0,0,r.width,r.height);
    if(mode==='engineering'){ctx.strokeStyle='#d9e3e7';ctx.lineWidth=.5;for(let x=0;x<r.width;x+=25){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,r.height);ctx.stroke();}for(let y=0;y<r.height;y+=25){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(r.width,y);ctx.stroke();}}
    if(!data||!r.width)return;
    const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];data.vertices.forEach(v=>v.forEach((n,i)=>{lo[i]=Math.min(lo[i],n);hi[i]=Math.max(hi[i],n);}));
    const centre=lo.map((n,i)=>(n+hi[i])/2),size=Math.max(...hi.map((n,i)=>n-lo[i]));if(!size||!Number.isFinite(size))return;
    const s=Math.min(r.width*.62,r.height*.68)/size*zoom;
    const pts=data.vertices.map(v=>{const x=v[0]-centre[0],y=v[1]-centre[1],z=v[2]-centre[2];const a=x*Math.cos(yaw)+z*Math.sin(yaw),b=-x*Math.sin(yaw)+z*Math.cos(yaw);return [r.width/2+a*s,r.height/2-(y*Math.cos(pitch)-b*Math.sin(pitch))*s,y*Math.sin(pitch)+b*Math.cos(pitch)];});
    const faces=data.faces.map(f=>({f,z:f.v.reduce((a,i)=>a+pts[i][2],0)/f.v.length})).sort((a,b)=>a.z-b.z);
    if(mode==='design'){ctx.save();ctx.filter='blur(18px)';ctx.fillStyle='rgba(55,64,44,.17)';ctx.beginPath();ctx.ellipse(r.width/2,r.height*.76,r.width*.26,22,0,0,Math.PI*2);ctx.fill();ctx.restore();}
    ctx.lineJoin='round';for(const {f} of faces){if(mode==='design'&&data.solidStart!==undefined&&f===data.faces[0])continue;ctx.beginPath();f.v.forEach((i,j)=>j?ctx.lineTo(pts[i][0],pts[i][1]):ctx.moveTo(pts[i][0],pts[i][1]));ctx.closePath();ctx.fillStyle=f.color;if(mode==='design')ctx.fill();ctx.strokeStyle=mode==='design'?'rgba(70,76,57,.3)':'#54728a';ctx.lineWidth=mode==='design'?.6:1;ctx.stroke();}
    ctx.strokeStyle=mode==='design'?'#86694b':'#35576d';ctx.lineWidth=mode==='design'?3:1.5;if(mode==='engineering'||data.solidStart===undefined)for(const e of data.edges||[]){ctx.beginPath();ctx.moveTo(pts[e[0]][0],pts[e[0]][1]);ctx.lineTo(pts[e[1]][0],pts[e[1]][1]);ctx.stroke();}
    if(mode==='engineering'&&dimensions){ctx.fillStyle='#27465d';ctx.font='14px system-ui';ctx.fillText(`${dimensions.length} × ${dimensions.width} м · нижний край ${dimensions.height} м`,20,r.height-24);ctx.fillText('Габаритный эскиз · размеры в метрах',20,28);}
  }
  canvas.addEventListener('pointerdown',e=>{drag=[e.clientX,e.clientY];canvas.setPointerCapture(e.pointerId);});
  canvas.addEventListener('pointermove',e=>{if(!drag)return;yaw+=(e.clientX-drag[0])*.01;pitch=Math.max(-.2,Math.min(1.3,pitch+(e.clientY-drag[1])*.008));drag=[e.clientX,e.clientY];render();});
  const release=()=>{drag=null;};canvas.addEventListener('pointerup',release);canvas.addEventListener('pointercancel',release);
  canvas.addEventListener('wheel',e=>{e.preventDefault();zoom=Math.max(.3,Math.min(3,zoom*Math.exp(-e.deltaY*.001)));render();},{passive:false});
  new ResizeObserver(render).observe(canvas);
  return {set(v){data=v;render();},params(p){dimensions=p;render();},mode(v){mode=v;render();},angle(v){const views={perspective:[.65,.45],front:[0,0],side:[Math.PI/2,0],top:[0,Math.PI/2]};[yaw,pitch]=views[v];zoom=1;render();},reset(){yaw=.65;pitch=.45;zoom=1;render();},render};
}
const scene=viewer($('scene'));
function build(){try{const p=G.validate(raw());mesh=G.gazebo(p);current=p;scene.set(mesh);scene.params(p);$('empty').hidden=true;$('model-caption').textContent=`Беседка ${p.length} × ${p.width} м · ${p.roof==='shed'?'односкатная':p.roof==='gable'?'двускатная':'плоская'} крыша · ${p.material||'материал уточняется'}`;svgText=drawing(p);$('drawing').innerHTML=svgText;for(const k of ['obj','png','svg','print'])$(k).disabled=false;$('feedback').textContent='Эскиз построен. Размеры указаны в метрах.';persist();}catch(e){$('feedback').textContent=e.message;}}
$('parameters').addEventListener('submit',e=>{e.preventDefault();build();});
$('parameters').addEventListener('input',()=>{current=null;mesh=null;svgText='';scene.set(null);$('empty').hidden=false;$('drawing').textContent='Параметры изменены. Постройте эскиз заново.';for(const k of ['obj','png','svg','print'])$(k).disabled=true;persist();});
$('reset').onclick=()=>scene.reset();
for(const k of ['perspective','front','side','top'])$('angle-'+k).onclick=()=>scene.angle(k);
function mode(value){scene.mode(value);document.body.dataset.view=value;$('design-mode').setAttribute('aria-pressed',String(value==='design'));$('engineering-mode').setAttribute('aria-pressed',String(value==='engineering'));document.querySelector('.engineering-note').hidden=value!=='engineering';}
$('design-mode').onclick=()=>mode('design');$('engineering-mode').onclick=()=>mode('engineering');
$('present').onclick=()=>{const active=document.body.classList.toggle('presentation');$('present').textContent=active?'Вернуться к работе':'Показать клиенту';scene.render();window.scrollTo({top:0,behavior:'smooth'});};
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.body.classList.contains('presentation'))$('present').click();});
$('save').onclick=()=>download(JSON.stringify({version:1,project:'Беседка',parameters:raw()},null,2),'application/json','besedka.json');
$('obj').onclick=()=>mesh&&download(G.obj(mesh),'text/plain','besedka.obj');
$('svg').onclick=()=>svgText&&download(svgText,'image/svg+xml','besedka.svg');
$('png').onclick=()=>{if(!current)return;scene.render();$('scene').toBlob(blob=>{if(blob)download(blob,'image/png','besedka.png');});};
$('print').onclick=()=>window.print();
function tab(which){for(const k of ['model','plan']){const selected=k===which;$('tab-'+k).setAttribute('aria-selected',String(selected));$('tab-'+k).tabIndex=selected?0:-1;$(k+'-panel').hidden=!selected;}if(which==='model')scene.render();}
for(const k of ['model','plan']){$('tab-'+k).onclick=()=>tab(k);$('tab-'+k).onkeydown=e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?'model':e.key==='End'?'plan':k==='model'?'plan':'model';tab(next);$('tab-'+next).focus();}};}
$('restore').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{if(f.size>100000)throw Error('Файл работы слишком большой.');const d=JSON.parse(await f.text());if(d.version!==1||d.project!=='Беседка'||!d.parameters||typeof d.parameters!=='object')throw Error('Это не файл работы «Беседка».');const p=d.parameters;const blank=['length','width','height'].every(k=>p[k]==='');if(!blank)G.validate(p);else if(fields.some(k=>p[k]!==undefined&&typeof p[k]!=='string'))throw Error('Неверные поля работы.');write(p);persist();if(!blank)build();else{current=null;mesh=null;scene.set(null);$('empty').hidden=false;$('drawing').textContent='Чертежи появятся после построения эскиза.';for(const k of ['obj','png','svg','print'])$(k).disabled=true;}$('feedback').textContent='Работа открыта.';}catch(err){$('feedback').textContent=err.message;}e.target.value='';};
$('reference').onchange=async e=>{
  const f=e.target.files[0];if(!f)return;const panel=$('reference-view');panel.replaceChildren();if(fileUrl){URL.revokeObjectURL(fileUrl);fileUrl=null;}
  try{if(f.size>20*1024*1024)throw Error('Откройте файл размером до 20 МБ.');const ext=f.name.split('.').pop().toLowerCase();
    if(['obj','stl'].includes(ext)){const model=ext==='obj'?G.parseObj(await f.text()):G.parseStl(await f.arrayBuffer());const c=document.createElement('canvas');c.setAttribute('aria-label','Ваша исходная 3D-модель');panel.append(c);viewer(c).set(model);}
    else if(['pdf','png','jpg','jpeg','webp'].includes(ext)){fileUrl=URL.createObjectURL(f);const el=document.createElement(ext==='pdf'?'iframe':'img');el.src=fileUrl;el.title='Ваш исходный файл';if(ext!=='pdf')el.alt='Исходное изображение';panel.append(el);}
    else throw Error('Поддерживаются OBJ, STL, PDF, PNG, JPG и WebP.');
    $('file-status').textContent=f.name+' · открыт на вашем устройстве. Исходная модель не изменяет параметры эскиза.';
  }catch(err){$('file-status').textContent=err.message;}e.target.value='';
};
try{const d=JSON.parse(localStorage.getItem(storageKey)||'null');if(d&&d.project==='Беседка'&&d.version===1){write(d.parameters);if(d.parameters.length&&d.parameters.width&&d.parameters.height&&d.parameters.roof)build();}else build();}catch{$('feedback').textContent='Не удалось восстановить работу. Откройте сохранённый файл.';}
