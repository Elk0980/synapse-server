/* Hero autopilot: one wheel notch / swipe / arrow key moves exactly one hero stop.
   The scroll-driven hero video then plays on its own up to the next text scene and
   holds there until the visitor swipes again. Swiping up plays back to the previous
   stop. Past the last stop the page scrolls normally into the content sections. */
(function(root,factory){
 'use strict';
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 if(root&&root.document)api.start(root,root.document);
})(typeof window==='undefined'?null:window,function(){
 'use strict';
 const SPEED=1.6;          // hero video plays 1.6x faster than real time between stops
 const MIN_MS=1400,MAX_MS=5200,LOCK_MS=350;
 // Stops in hero progress units (same scale as data-range-* on .hero-scene):
 // the opening, the middle of each text scene, and just inside the final scene.
 function stopsFrom(scenes){
  const out=[0];
  scenes.forEach(scene=>{
   if(scene.classList.contains('hero-scene--breath'))return;
   const a=Number(scene.dataset.rangeStart),b=Number(scene.dataset.rangeEnd);
   if(!Number.isFinite(a)||!Number.isFinite(b)||a===0)return;
   out.push(b>=1?a+0.035:(a+b)/2);   // final scene: just after its fade-in
  });
  return out;
 }
 function ease(t){return t<0.5?2*t*t:1-Math.pow(-2*t+2,2)/2;}
 function start(win,doc){
  const hero=doc.getElementById('hero');
  if(!hero)return;
  const stops=stopsFrom([...hero.querySelectorAll('.hero-scene[data-range-start]')]);
  if(stops.length<2)return;
  const reduce=win.matchMedia&&win.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const heroTop=()=>hero.getBoundingClientRect().top+win.scrollY;
  const last=stops.length-1;
  // Compact mode (phones, iOS): text scenes are ordinary full-screen sections without
  // scroll-scrubbed video, so a stop is simply the top of the next scene.
  const compact=()=>hero.classList.contains('is-compact-mode');
  const sceneEls=()=>[...hero.querySelectorAll('.hero-scene[data-range-start]')].filter(s=>!s.classList.contains('hero-scene--breath'));
  function positions(){
   if(compact())return sceneEls().map(s=>Math.round(s.getBoundingClientRect().top+win.scrollY));
   const top=heroTop(),h=hero.offsetHeight;
   return stops.map(p=>Math.round(top+h*p));
  }
  let anim=null,lockUntil=0,touch=null;
  const now=()=>win.performance.now();
  function videoSeconds(){
   const v=doc.getElementById('hero-video');
   return v&&Number.isFinite(v.duration)&&v.duration>0?v.duration:52;
  }
  function inHero(){
   const pos=positions(),y=win.scrollY;
   return y>=pos[0]-win.innerHeight*0.05&&y<=pos[pos.length-1]+4;
  }
  function blocked(event){
   if(doc.querySelector('dialog[open],.promo.is-open'))return true;
   const editable='form,input,textarea,select,[contenteditable]:not([contenteditable="false"])';
   return [event&&event.target,doc.activeElement].some(el=>el&&el.closest&&el.closest(editable));
  }
  function jump(y){win.scrollTo({top:y,left:0,behavior:'instant'});}
  function go(dir){
   if(anim)return true;
   if(now()<lockUntil)return true;
   const pos=positions(),y=win.scrollY,n=pos.length-1;
   // next stop strictly beyond the current position in the swipe direction
   let to=-1;
   if(dir>0){for(let i=0;i<=n;i++)if(pos[i]>y+3){to=i;break;}}
   else{for(let i=n;i>=0;i--)if(pos[i]<y-3){to=i;break;}}
   if(to<0)return false;                        // leave the hero: normal scrolling takes over
   const from=y,target=pos[to];
   if(reduce){jump(target);lockUntil=now()+LOCK_MS;return true;}
   const ms=compact()?750:Math.min(Math.max(Math.abs(target-from)/Math.max(hero.offsetHeight,1)*videoSeconds()*1000/SPEED,MIN_MS),MAX_MS);
   const t0=now();
   anim={to};
   const tick=()=>{
    if(!anim)return;
    const q=Math.min((now()-t0)/ms,1);
    jump(Math.round(from+(target-from)*ease(q)));
    if(q>=1){anim=null;lockUntil=now()+LOCK_MS;return;}
    win.requestAnimationFrame(tick);
   };
   win.requestAnimationFrame(tick);
   return true;
  }
  win.addEventListener('wheel',event=>{
   if(event.ctrlKey||Math.abs(event.deltaY)<4||Math.abs(event.deltaX||0)>Math.abs(event.deltaY))return;
   if(!inHero()||blocked(event))return;
   if(anim||now()<lockUntil){event.preventDefault();lockUntil=Math.max(lockUntil,now()+LOCK_MS);return;} // swallow trackpad momentum
   if(go(event.deltaY>0?1:-1))event.preventDefault();
  },{passive:false});
  win.addEventListener('touchstart',event=>{
   const t=event.touches.length===1?event.touches[0]:null;
   touch=t&&inHero()&&!blocked(event)?{y:t.clientY,x:t.clientX}:null;
  },{passive:true});
  win.addEventListener('touchmove',event=>{if(touch&&event.cancelable)event.preventDefault();},{passive:false});
  win.addEventListener('touchend',event=>{
   if(!touch)return;
   const t=event.changedTouches[0],dy=touch.y-t.clientY,dx=touch.x-t.clientX;touch=null;
   if(Math.abs(dy)<30||Math.abs(dy)<Math.abs(dx))return;
   if(!go(dy>0?1:-1))jump(win.scrollY+dy*2);   // at the ends: let the visitor leave the hero
  },{passive:true});
  win.addEventListener('keydown',event=>{
   if(event.repeat||event.ctrlKey||event.altKey||event.metaKey)return;
   if(!inHero()||blocked(event))return;
   if(event.target&&event.target.closest&&event.target.closest('a,button,summary,[role="button"]')&&event.key===' ')return;
   const dir=['ArrowDown','PageDown',' '].includes(event.key)?1:['ArrowUp','PageUp'].includes(event.key)?-1:0;
   if(dir&&go(dir))event.preventDefault();
  });
 }
 return {start,stopsFrom};
});
