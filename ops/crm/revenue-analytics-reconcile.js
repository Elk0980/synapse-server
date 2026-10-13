'use strict';

// Сверка агрегатов уже полученного официального ответа и сохранённого отчёта.
// Не запрашивает API, не суммирует посетителей/средние и не включает значения в ошибки.
function compareMetrikaSnapshot(expected,actual) {
  const differences=[];let comparedValues=0;
  const difference=(path,kind='different')=>differences.push({path,kind});
  const equal=(path,a,b)=>{comparedValues++;if(a!==b)difference(path);};
  const numeric=(path,a,b,integer=false)=>{
    comparedValues++;
    if(!Number.isFinite(a)||!Number.isFinite(b)){difference(path,'missing_or_invalid');return;}
    if(integer ? !Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a!==b : Math.abs(a-b)>1e-7)difference(path);
  };
  const source=expected?.report,m=actual?.metrika;
  const binding=actual?.state?.providers?.find(p=>p.provider==='metrika');
  const validDay=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
  const samePeriod=(a,b)=>validDay(a?.from)&&validDay(a?.to)&&a.from<=a.to&&a.from===b?.from&&a.to===b?.to;
  if(!expected?.companyCode||expected.companyCode!==actual?.companyCode)difference('scope.company','scope');
  if(!expected?.counterId||String(expected.counterId)!==binding?.config?.externalId)difference('scope.counter','scope');
  if(!samePeriod(expected?.period,actual?.period)||!samePeriod(expected?.period,source?.period)||!samePeriod(expected?.period,m?.period))difference('scope.period','scope');
  if(!source?.timezone||source.timezone!==m?.timezone)difference('scope.timezone','scope');
  if(!source?.attribution||source.attribution!==m?.attribution)difference('scope.attribution','scope');
  if(!m?.current)difference('scope.revision','scope');
  if(differences.length)return {matches:false,scopeValid:false,comparedValues,differences};
  function table(name,a,b) {
    if(!a||!b||!Array.isArray(a.metrics)||!Array.isArray(b.metrics)||!Array.isArray(a.totals)||!Array.isArray(b.totals)||!Array.isArray(a.rows)||!Array.isArray(b.rows)){
      difference(name,'missing_or_invalid');return;
    }
    if(!a.metrics.length||!b.metrics.length||a.metrics.length!==a.totals.length||b.metrics.length!==b.totals.length||new Set(a.metrics).size!==a.metrics.length||new Set(b.metrics).size!==b.metrics.length){
      difference(name,'missing_or_invalid');return;
    }
    equal(name+'.metrics',JSON.stringify(a.metrics),JSON.stringify(b.metrics));
    equal(name+'.totals.length',a.totals.length,b.totals.length);
    a.totals.forEach((v,i)=>numeric(name+'.totals.'+i,v,b.totals[i],/:(visits|users)$/.test(a.metrics[i])));
    equal(name+'.sampled',a.sampled,b.sampled);
    equal(name+'.sampleShare',a.sampleShare,b.sampleShare);
    equal(name+'.dataLagSeconds',a.dataLagSeconds,b.dataLagSeconds);
    const rows=(values)=>{
      const map=new Map();
      for(const row of values){
        if(!Array.isArray(row?.dimensions)||!Array.isArray(row?.metrics)||row.metrics.length!==a.metrics.length||row.dimensions.some(d=>!d||typeof d!=='object')){difference(name+'.rows','missing_or_invalid');continue;}
        const key=JSON.stringify(row.dimensions.map(d=>[d.id??null,d.name??null]));
        if(map.has(key))difference(name+'.rows','duplicate');
        map.set(key,row);
      }
      return map;
    };
    const left=rows(a.rows),right=rows(b.rows);equal(name+'.rows.count',left.size,right.size);
    let index=0;
    for(const [key,row] of left){
      const other=right.get(key),path=name+'.rows.'+index++;
      if(!other){difference(path,'missing_dimension');continue;}
      equal(path+'.metrics.length',row.metrics.length,other.metrics.length);
      row.metrics.forEach((v,i)=>numeric(path+'.metrics.'+i,v,other.metrics[i],/:(visits|users)$/.test(a.metrics[i])));
    }
  }
  for(const name of ['overview','sources','utm'])table(name,source[name],m[name]);
  if(!Array.isArray(source.goals)||!Array.isArray(m.goals))difference('goals','missing_or_invalid');
  else {
    const goals=values=>{
      const map=new Map();for(const goal of values){
        if(!goal?.id){difference('goals','missing_id');continue;}
        const id=String(goal.id);if(map.has(id))difference('goals','duplicate');map.set(id,goal);
      }return map;
    };
    const left=goals(source.goals),right=goals(m.goals);equal('goals.count',left.size,right.size);
    let index=0;
    for(const [id,goal] of left){
      const other=right.get(id),path='goals.'+index++;
      if(!other){difference(path,'missing_goal');continue;}
      for(const metric of ['visits','reaches','conversionRate'])numeric(path+'.'+metric,goal[metric],other[metric],metric!=='conversionRate');
      equal(path+'.sampled',goal.sampled,other.sampled);
    }
  }
  return {matches:differences.length===0,scopeValid:true,comparedValues,differences};
}
module.exports={compareMetrikaSnapshot};
