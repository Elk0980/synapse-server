(function(root){
  'use strict';
  const D=Math.PI/180,clamp=n=>Math.max(-1,Math.min(1,n));
  // Approximate NOAA fractional-year equations. No terrain, weather or refraction.
  // https://gml.noaa.gov/grad/solcalc/solareqns.PDF
  function calendar(date){
    if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('Выберите дату.');
    const t=new Date(date+'T12:00:00Z'),year=Number(date.slice(0,4));
    if(!Number.isFinite(t.getTime())||t.toISOString().slice(0,10)!==date||year<2000||year>2100)throw Error('Выберите дату с 2000 по 2100 год.');
    return {day:Math.round((t-Date.UTC(year,0,1,12))/86400000)+1,days:(Date.UTC(year+1,0,1)-Date.UTC(year,0,1))/86400000};
  }
  function settings(raw={}){
    const initial={date:new Date().getUTCFullYear()+'-06-21',latitude:53,longitude:104,timezone:8,north:0,northKnown:false,hour:13,ground:true,background:true,shadows:true};
    const v={...initial,...raw};calendar(v.date);
    for(const [key,lo,hi] of [['latitude',-89,89],['longitude',-180,180],['timezone',-12,14],['north',-360,360],['hour',0,24]])if(typeof v[key]!=='number'||!Number.isFinite(v[key])||v[key]<lo||v[key]>hi)throw Error('Некорректная настройка солнца: '+key);
    return {...Object.fromEntries(['date','latitude','longitude','timezone','north','hour'].map(k=>[k,v[k]])),...Object.fromEntries(['northKnown','ground','background','shadows'].map(k=>[k,v[k]===true]))};
  }
  function terms(date,hour){const c=calendar(date),g=2*Math.PI/c.days*(c.day-1+(hour-12)/24);return {equation:229.18*(.000075+.001868*Math.cos(g)-.032077*Math.sin(g)-.014615*Math.cos(2*g)-.040849*Math.sin(2*g)),declination:.006918-.399912*Math.cos(g)+.070257*Math.sin(g)-.006758*Math.cos(2*g)+.000907*Math.sin(2*g)-.002697*Math.cos(3*g)+.00148*Math.sin(3*g)};}
  function position(raw){
    const v=settings(raw),t=terms(v.date,v.hour),lat=v.latitude*D,h=(v.hour*60+t.equation+4*v.longitude-60*v.timezone)/4*D-Math.PI;
    const east=-Math.cos(t.declination)*Math.sin(h),north=Math.cos(lat)*Math.sin(t.declination)-Math.sin(lat)*Math.cos(t.declination)*Math.cos(h),up=Math.sin(lat)*Math.sin(t.declination)+Math.cos(lat)*Math.cos(t.declination)*Math.cos(h);
    const azimuth=((Math.atan2(east,north)/D)%360+360)%360,a=(azimuth+v.north)*D,altitude=Math.asin(clamp(up))/D,cos=Math.sqrt(Math.max(0,1-up*up));
    return {altitude,azimuth,direction:[Math.sin(a)*cos,up,-Math.cos(a)*cos],daylight:up>0};
  }
  function daylight(raw){
    const v=settings(raw),t=terms(v.date,12),lat=v.latitude*D,c=-Math.tan(lat)*Math.tan(t.declination),noon=(720-4*v.longitude-t.equation+60*v.timezone)/60;
    if(c>=1)return {sunrise:null,sunset:null,noon,polar:'night'};
    if(c<=-1)return {sunrise:0,sunset:24,noon,polar:'day'};
    const span=Math.acos(c)/D/15;return {sunrise:Math.max(0,noon-span),sunset:Math.min(24,noon+span),noon,polar:null};
  }
  function shadow(point,direction){if(direction[1]<=0)return null;const height=Math.max(0,point[1]);return [point[0]-direction[0]*height/direction[1],0,point[2]-direction[2]*height/direction[1]];}
  const api={settings,position,daylight,shadow};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.BesedkaSolar=api;
})(typeof window!=='undefined'?window:globalThis);
