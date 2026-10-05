(function(root){
  'use strict';
  function validate(p){
    if(!p||typeof p!=='object'||Array.isArray(p))throw Error('Файл не содержит параметры работы.');
    const ranges={length:[.5,30],width:[.5,30],height:[1,10]};
    const result={};
    for(const [key,[lo,hi]] of Object.entries(ranges)){
      if(p[key]===''||p[key]===null||typeof p[key]==='boolean')throw Error('Укажите длину, ширину и высоту.');
      const v=Number(p[key]);if(!Number.isFinite(v)||v<lo||v>hi)throw Error('Проверьте размеры: длина и ширина 0,5–30 м, высота 1–10 м.');result[key]=v;
    }
    if(!['gable','flat','shed'].includes(p.roof))throw Error('Выберите форму крыши.');
    result.roof=p.roof;result.rise=p.roof==='flat'?0:Number(p.rise);
    if(!Number.isFinite(result.rise)||(p.roof!=='flat'&&(result.rise<.1||result.rise>5)))throw Error('Укажите подъём крыши от 0,1 до 5 м.');
    for(const [key,max] of Object.entries({material:100,region:120,notes:5000}))result[key]=typeof p[key]==='string'?p[key].slice(0,max):'';
    return result;
  }
  function gazebo(raw){
    const p=validate(raw),l=p.length/2,w=p.width/2,h=p.height;
    const vertices=[[-l,0,-w],[l,0,-w],[l,0,w],[-l,0,w],[-l,h,-w],[l,h,-w],[l,h,w],[-l,h,w]];
    const faces=[{v:[0,1,2,3],color:'#dad8c7'}];
    const edges=[[0,4],[1,5],[2,6],[3,7],[4,5],[5,6],[6,7],[7,4]];
    if(p.roof==='gable'){
      vertices.push([-l,h+p.rise,0],[l,h+p.rise,0]);
      faces.push({v:[4,5,9,8],color:'#788777'},{v:[8,9,6,7],color:'#556e5b'});
      edges.push([4,8],[8,7],[5,9],[9,6],[8,9]);
    }else if(p.roof==='shed'){
      vertices[4][1]+=p.rise;vertices[5][1]+=p.rise;
      faces.push({v:[4,5,6,7],color:'#657e65'});
    }else faces.push({v:[4,5,6,7],color:'#657e65'});
    return {vertices,faces,edges};
  }
  function obj(mesh){return '# Gazebo sketch, units: metres\n'+mesh.vertices.map(v=>'v '+v.join(' ')).join('\n')+'\n'+mesh.faces.map(f=>'f '+f.v.map(i=>i+1).join(' ')).join('\n')+'\n'+(mesh.edges||[]).map(e=>'l '+e.map(i=>i+1).join(' ')).join('\n')+'\n';}
  function parseObj(text){
    const vertices=[],faces=[],edges=[];
    for(const line of text.split(/\r?\n/)){
      const t=line.trim().split(/\s+/);
      if(t[0]==='v'){const v=t.slice(1,4).map(Number);if(v.length!==3||!v.every(Number.isFinite))throw Error('Некорректные координаты OBJ.');vertices.push(v);}
      else if(t[0]==='f'||t[0]==='l'){
        const ids=t.slice(1).map(x=>{const n=Number(x.split('/')[0]);return n<0?vertices.length+n:n-1;});
        if(ids.some(i=>!Number.isInteger(i)||i<0||i>=vertices.length))throw Error('Некорректные индексы OBJ.');
        if(t[0]==='f'&&ids.length>=3)faces.push({v:ids,color:'#8eab99'});
        if(t[0]==='l')for(let i=1;i<ids.length;i++)edges.push([ids[i-1],ids[i]]);
      }
      if(vertices.length>60000||faces.length>60000||edges.length>60000)throw Error('Модель слишком сложная. Используйте до 60 000 вершин и граней.');
    }
    if(!vertices.length||(!faces.length&&!edges.length))throw Error('В OBJ не найдены грани или линии.');
    return {vertices,faces,edges};
  }
  function parseStl(buffer){
    const view=new DataView(buffer),vertices=[],faces=[];
    const count=buffer.byteLength>=84?view.getUint32(80,true):0;
    if(count>0&&84+count*50===buffer.byteLength){
      if(count>20000)throw Error('STL слишком сложный: максимум 20 000 треугольников.');
      for(let i=0;i<count;i++){const ids=[];for(let j=0;j<3;j++){const off=84+i*50+12+j*12;ids.push(vertices.length);vertices.push([0,4,8].map(d=>view.getFloat32(off+d,true)));}faces.push({v:ids,color:'#8eab99'});}
    }else{
      const text=new TextDecoder().decode(buffer);const matches=text.matchAll(/\bvertex\s+([+\-\d.eE]+)\s+([+\-\d.eE]+)\s+([+\-\d.eE]+)/g);
      for(const m of matches){vertices.push(m.slice(1).map(Number));if(vertices.length>60000)throw Error('STL слишком сложный.');}
      if(vertices.length%3!==0)throw Error('Некорректные треугольники STL.');
      for(let i=0;i<vertices.length;i+=3)faces.push({v:[i,i+1,i+2],color:'#8eab99'});
    }
    if(!vertices.length||vertices.some(v=>!v.every(Number.isFinite)))throw Error('Некорректный STL.');
    return {vertices,faces,edges:[]};
  }
  const api={validate,gazebo,obj,parseObj,parseStl};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.BesedkaGeometry=api;
})(typeof window!=='undefined'?window:globalThis);
