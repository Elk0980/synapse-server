(function(root){
  'use strict';
  const MAX_PARTS=400,MAX_GROUPS=200,MAX_FILE=2000000,DEG=Math.PI/180;
  const S=typeof module!=='undefined'&&module.exports?require('./solar.js'):root.BesedkaSolar;
  const clone=v=>JSON.parse(JSON.stringify(v));
  const text=(v,n=100)=>typeof v==='string'?v.slice(0,n):'';
  const uid=prefix=>prefix+'-'+(typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+'-'+Math.random().toString(36).slice(2));
  function number(v,lo,hi,message){if(typeof v!=='number'||!Number.isFinite(v)||v<lo||v>hi)throw Error(message);return v;}
  function vector(v,lo,hi,message){if(!Array.isArray(v)||v.length!==3)throw Error(message);return v.map(n=>number(n,lo,hi,message));}
  const palette={wood:'#b89569',metal:'#8d9ba5',roof:'#667e72',other:'#a6aa97'};
  function material(v={}){const kind=Object.hasOwn(palette,v.kind)?v.kind:'wood';return {kind,name:text(v.name)||({wood:'Древесина',metal:'Металл',roof:'Кровля',other:'Другой материал'}[kind]),color:/^#[0-9a-f]{6}$/i.test(v.color||'')?v.color:palette[kind]};}
  function validate(input){
    if(!input||input.version!==2||input.project!=='Беседка'||!Array.isArray(input.parts)||!Array.isArray(input.groups))throw Error('Это не файл редактора беседки.');
    if(input.parts.length>MAX_PARTS||input.groups.length>MAX_GROUPS)throw Error('Слишком много деталей или групп для телефона.');
    const ids=new Set(),parts=input.parts.map(p=>{
      if(!p||typeof p.id!=='string'||!p.id||p.id.length>100||ids.has(p.id))throw Error('Некорректные идентификаторы деталей.');ids.add(p.id);
      if(!['box','cylinder'].includes(p.shape))throw Error('Неизвестная форма детали.');
      return {id:p.id,name:text(p.name)||'Деталь',shape:p.shape,dimensions:vector(p.dimensions,.001,60,'Размер детали должен быть от 1 до 60 000 мм.'),position:vector(p.position,-100,100,'Положение детали выходит за пределы рабочей зоны.'),rotation:vector(p.rotation,-36000,36000,'Некорректный угол поворота.'),material:material(p.material),hidden:p.hidden===true,locked:p.locked===true};
    });
    const groupIds=new Set(),assigned=new Set(),groups=input.groups.map(g=>{
      if(!g||typeof g.id!=='string'||!g.id||g.id.length>100||groupIds.has(g.id)||ids.has(g.id)||!Array.isArray(g.members)||g.members.length<2)throw Error('Некорректная группа.');groupIds.add(g.id);
      for(const id of g.members){if(!ids.has(id)||assigned.has(id))throw Error('Деталь должна принадлежать только одной группе.');assigned.add(id);}
      return {id:g.id,name:text(g.name)||'Группа',members:g.members.slice()};
    });
    return {version:2,project:'Беседка',name:text(input.name)||'Беседка',notes:text(input.notes,5000),parts,groups,environment:S.settings(input.environment)};
  }
  function empty(){return {version:2,project:'Беседка',name:'Беседка',notes:'',parts:[],groups:[],environment:S.settings()};}
  function part(spec={}){return {id:uid('part'),name:spec.name||'Деталь',shape:spec.shape||'box',dimensions:spec.dimensions||[.1,2.5,.1],position:spec.position||[0,1.25,0],rotation:spec.rotation||[0,0,0],material:material(spec.material),hidden:false,locked:false};}
  function matrix(rotation){
    const [x,y,z]=rotation.map(a=>a*DEG),sx=Math.sin(x),cx=Math.cos(x),sy=Math.sin(y),cy=Math.cos(y),sz=Math.sin(z),cz=Math.cos(z);
    return [[cz*cy,cz*sy*sx-sz*cx,cz*sy*cx+sz*sx],[sz*cy,sz*sy*sx+cz*cx,sz*sy*cx-cz*sx],[-sy,cy*sx,cy*cx]];
  }
  const mv=(m,v)=>m.map(row=>row.reduce((s,n,i)=>s+n*v[i],0));
  const mm=(a,b)=>a.map(row=>[0,1,2].map(j=>row.reduce((s,n,k)=>s+n*b[k][j],0)));
  function angles(m){const y=Math.asin(Math.max(-1,Math.min(1,-m[2][0]))),normal=Math.abs(Math.cos(y))>1e-8;return [(normal?Math.atan2(m[2][1],m[2][2]):Math.atan2(-m[1][2],m[1][1]))/DEG,y/DEG,(normal?Math.atan2(m[1][0],m[0][0]):0)/DEG];}
  function beam(a,b,width,depth,name,mat){const d=b.map((n,i)=>n-a[i]),length=Math.hypot(...d);if(length<.001)throw Error('Начало и конец детали совпадают.');return part({name,dimensions:[width,length,depth],position:a.map((n,i)=>(n+b[i])/2),rotation:[Math.asin(Math.max(-1,Math.min(1,d[2]/length)))/DEG,0,Math.atan2(-d[0],d[1])/DEG],material:mat});}
  function example(raw){
    const G=typeof module!=='undefined'&&module.exports?require('./geometry.js'):root.BesedkaGeometry,p=G.validate(raw),work=empty(),l=p.length/2,w=p.width/2,t=p.section/1000,h=p.height;
    work.notes=p.notes;const mat={kind:'wood',name:p.material||'Древесина'},high=p.roof==='shed'?h+p.rise:h;
    function fittedBeam(a,b,width,depth,name,material,top){
      const base=beam(a,b,width,depth,name,material),m=matrix(base.rotation),d=b.map((n,i)=>n-a[i]);let begin=0,end=1;
      for(const [axis,half] of [[0,l],[2,w]]){const radius=Math.abs(m[axis][0])*width/2+Math.abs(m[axis][2])*depth/2;if(Math.abs(d[axis])<1e-10)continue;const low=(-half+radius-a[axis])/d[axis],up=(half-radius-a[axis])/d[axis];begin=Math.max(begin,Math.min(low,up));end=Math.min(end,Math.max(low,up));}
      const result=beam(a.map((n,i)=>n+d[i]*begin),a.map((n,i)=>n+d[i]*end),width,depth,name,material);if(top!==undefined)result.position[1]+=top-Math.max(...points(result).map(v=>v[1]));return result;
    }
    let no=0;for(const [x,z,top] of [[-l+t/2,-w+t/2,high],[l-t/2,-w+t/2,high],[-l+t/2,w-t/2,h],[l-t/2,w-t/2,h]])work.parts.push(beam([x,0,z],[x,top,z],t,t,'Стойка '+(++no),mat));
    for(const [z,top] of [[-w+t/2,high],[w-t/2,h]])work.parts.push(beam([-l,top-t/2,z],[l,top-t/2,z],t,t,'Продольная балка',mat));
    for(const x of [-l+t/2,l-t/2])work.parts.push(fittedBeam([x,high-t/2,-w],[x,h-t/2,w],t,t,'Поперечная балка',mat));
    if(p.cover==='pergola'){
      const count=Math.max(3,Math.ceil(p.width/.25));for(let i=0;i<=count;i++){const z=-w+.05+(p.width-.1)*i/count,y=h+(p.roof==='shed'?p.rise*(w-z)/p.width:0);work.parts.push(beam([-l,y,z],[l,y,z],.025,.1,'Доска перголы '+(i+1),mat));}
    }else if(p.roof==='gable'){
      for(const side of [-1,1])work.parts.push(fittedBeam([0,h+p.rise,0],[0,h,side*w],p.length,.025,'Скат крыши',{kind:'roof',name:'Кровля'},h+p.rise));
      for(const x of [-l+t/2,l-t/2])for(const side of [-1,1])work.parts.push(fittedBeam([x,h+p.rise,0],[x,h,side*w],t,t,'Стропило',mat,h+p.rise));
    }else work.parts.push(fittedBeam([0,high,-w],[0,h,w],p.length,.025,'Покрытие крыши',{kind:'roof',name:'Кровля'},high));
    return validate(work);
  }
  function points(p){
    const [w,h,d]=p.dimensions,m=matrix(p.rotation),local=[];
    if(p.shape==='box')for(const y of [-h/2,h/2])for(const [x,z] of [[-w/2,-d/2],[w/2,-d/2],[w/2,d/2],[-w/2,d/2]])local.push([x,y,z]);
    else for(const y of [-h/2,h/2])for(let i=0;i<16;i++){const a=i*Math.PI/8;local.push([w/2*Math.cos(a),y,d/2*Math.sin(a)]);}
    return local.map(v=>mv(m,v).map((n,i)=>n+p.position[i]));
  }
  function bounds(work,ids){const chosen=ids?new Set(ids):null,pts=work.parts.filter(p=>!chosen||chosen.has(p.id)).flatMap(points);if(!pts.length)return {min:[-.5,0,-.5],max:[.5,1,.5],centre:[0,.5,0],size:[1,1,1]};const min=[0,1,2].map(i=>Math.min(...pts.map(v=>v[i]))),max=[0,1,2].map(i=>Math.max(...pts.map(v=>v[i])));return {min,max,centre:min.map((n,i)=>(n+max[i])/2),size:min.map((n,i)=>max[i]-n)};}
  function selection(work,ids,includeGroups=true){const chosen=new Set(ids);for(const g of work.groups)if(chosen.has(g.id)||(includeGroups&&g.members.some(id=>chosen.has(id))))g.members.forEach(id=>chosen.add(id));return work.parts.filter(p=>chosen.has(p.id)).map(p=>p.id);}
  function mutable(work,ids,includeGroups=true){const selected=selection(work,ids,includeGroups);if(!selected.length)throw Error('Выберите деталь.');if(work.parts.some(p=>selected.includes(p.id)&&p.locked))throw Error('Сначала снимите защиту выбранной детали.');return selected;}
  function add(work,spec){const next=clone(work);next.parts.push(part(spec));return validate(next);}
  function update(work,ids,patch,includeGroups=true){const chosen=new Set(mutable(work,ids,includeGroups)),next=clone(work);for(const p of next.parts)if(chosen.has(p.id)){for(const k of ['name','shape','dimensions','position','rotation','hidden'])if(patch[k]!==undefined)p[k]=clone(patch[k]);if(patch.material)p.material=material({...p.material,...patch.material});}return validate(next);}
  function setFlags(work,ids,flags){const chosen=new Set(selection(work,ids)),next=clone(work);for(const p of next.parts)if(chosen.has(p.id))for(const k of ['hidden','locked'])if(typeof flags[k]==='boolean')p[k]=flags[k];return validate(next);}
  function transform(work,ids,change){const chosen=new Set(mutable(work,ids)),next=clone(work),shift=vector(change.translation||[0,0,0],-100,100,'Некорректное перемещение.'),turn=vector(change.rotation||[0,0,0],-36000,36000,'Некорректный поворот.'),pivot=bounds(work,[...chosen]).centre,m=matrix(turn);for(const p of next.parts)if(chosen.has(p.id)){p.position=mv(m,p.position.map((n,i)=>n-pivot[i])).map((n,i)=>n+pivot[i]+shift[i]);p.rotation=angles(mm(m,matrix(p.rotation)));}return validate(next);}
  function group(work,ids,name='Группа'){const chosen=mutable(work,ids);if(chosen.length<2)throw Error('Для группы выберите хотя бы две детали.');const next=clone(work);next.groups=next.groups.filter(g=>!g.members.some(id=>chosen.includes(id)));next.groups.push({id:uid('group'),name,members:chosen});return validate(next);}
  function ungroup(work,ids){const chosen=new Set(selection(work,ids)),next=clone(work);next.groups=next.groups.filter(g=>!g.members.some(id=>chosen.has(id)));return validate(next);}
  function remove(work,ids){const chosen=new Set(mutable(work,ids)),next=clone(work);next.parts=next.parts.filter(p=>!chosen.has(p.id));next.groups=next.groups.filter(g=>!g.members.some(id=>chosen.has(id)));return validate(next);}
  function duplicate(work,ids,offset=[.25,0,0]){const chosen=new Set(selection(work,ids)),shift=vector(offset,-100,100,'Некорректное смещение копии.'),next=clone(work),map=new Map();if(!chosen.size)throw Error('Выберите деталь.');for(const p of work.parts)if(chosen.has(p.id)){const c=clone(p);c.id=uid('part');c.name+=' — копия';c.locked=false;c.position=c.position.map((n,i)=>n+shift[i]);map.set(p.id,c.id);next.parts.push(c);}for(const g of work.groups)if(g.members.every(id=>chosen.has(id)))next.groups.push({id:uid('group'),name:g.name+' — копия',members:g.members.map(id=>map.get(id))});return validate(next);}
  function align(work,movingIds,targetId,axis,side='end',gap=0){if(![0,1,2].includes(axis)||!['start','centre','end'].includes(side))throw Error('Выберите сторону стыковки.');const moving=mutable(work,movingIds);if(moving.includes(targetId)||!work.parts.some(p=>p.id===targetId))throw Error('Выберите другую деталь для стыковки.');number(gap,-5,5,'Зазор должен быть от −5000 до 5000 мм.');const a=bounds(work,moving),b=bounds(work,[targetId]),delta=[0,0,0];delta[axis]=side==='centre'?b.centre[axis]-a.centre[axis]:side==='end'?b.max[axis]+gap-a.min[axis]:b.min[axis]-gap-a.max[axis];return transform(work,moving,{translation:delta});}
  function mesh(work,{includeHidden=false}={}){const vertices=[],faces=[],edges=[];for(const p of work.parts){if(p.hidden&&!includeHidden)continue;const start=vertices.length,v=points(p);vertices.push(...v);const n=p.shape==='box'?4:16,indices=[];for(let i=0;i<n;i++)indices.push([i,(i+1)%n,(i+1)%n+n,i+n]);indices.push(Array.from({length:n},(_,i)=>n-1-i),Array.from({length:n},(_,i)=>i+n));for(const f of indices)faces.push({v:f.map(i=>i+start),color:p.material.color,objectId:p.id});for(let i=0;i<n;i++)edges.push([start+i,start+(i+1)%n],[start+i+n,start+(i+1)%n+n],[start+i,start+i+n]);}return {vertices,faces,edges};}
  function bill(work){const rows=new Map();for(const p of work.parts){const mm=p.dimensions.map(n=>Math.round(n*10000)/10),key=JSON.stringify([p.shape,mm,p.material]);if(!rows.has(key))rows.set(key,{shape:p.shape,dimensions:mm,material:p.material.name,count:0,names:[],volume:0});const row=rows.get(key);row.count++;row.names.push(p.name);row.volume+=p.dimensions.reduce((a,n)=>a*n,1)*(p.shape==='cylinder'?Math.PI/4:1);}return [...rows.values()];}
  function load(source){if(typeof source!=='string'||source.length>MAX_FILE)throw Error('Файл слишком большой.');let raw;try{raw=JSON.parse(source);}catch{throw Error('Файл проекта повреждён.');}if(raw&&raw.version===1&&raw.project==='Беседка'&&raw.parameters){if(['length','width','height'].every(k=>raw.parameters[k]===''))return empty();return example(raw.parameters);}return validate(raw);}
  function history(initial){let current=validate(initial),past=[],future=[];return {get value(){return clone(current);},get canUndo(){return past.length>0;},get canRedo(){return future.length>0;},commit(next){next=validate(next);if(JSON.stringify(next)===JSON.stringify(current))return clone(current);past.push(current);if(past.length>40)past.shift();current=next;future=[];return clone(current);},undo(){if(past.length){future.push(current);current=past.pop();}return clone(current);},redo(){if(future.length){past.push(current);current=future.pop();}return clone(current);},reset(next){current=validate(next);past=[];future=[];return clone(current);}};}
  const api={MAX_PARTS,validate,empty,part,example,points,bounds,selection,add,update,setFlags,transform,group,ungroup,remove,duplicate,align,mesh,bill,load,history};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.BesedkaEditorModel=api;
})(typeof window!=='undefined'?window:globalThis);
