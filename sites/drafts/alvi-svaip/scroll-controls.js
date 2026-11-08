/* A new downward gesture after reading the footer starts the page again. */
(function(root,factory){
 'use strict';
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 if(root&&root.document)api.start(root,root.document);
})(typeof window==='undefined'?null:window,function(){
 'use strict';
 function start(win,doc){
  const footerPause=350,wheelPause=280;
  let reachedEndAt=null,lastWheelAt=-Infinity,lockUntil=0,touch=null;
  function now(){return win.performance.now();}
  function atEnd(){
   const page=doc.scrollingElement||doc.documentElement;
   const end=page.scrollHeight-win.innerHeight;
   return end>win.innerHeight&&win.scrollY>=end-3;
  }
  function observeEnd(){
   if(!atEnd())reachedEndAt=null;
   else if(reachedEndAt===null)reachedEndAt=now();
  }
  function blocked(event){
   if(event.defaultPrevented)return true;
   if(doc.querySelector('dialog[open],.promo.is-open'))return true;
   const editable='form,input,textarea,select,[contenteditable]:not([contenteditable="false"])';
   return [event.target,doc.activeElement].some(element=>element&&element.closest&&element.closest(editable));
  }
  function ready(event){
   observeEnd();
   return reachedEndAt!==null&&now()-reachedEndAt>=footerPause&&now()>=lockUntil&&!blocked(event);
  }
  function restart(event){
   if(!ready(event))return false;
   if(event.cancelable&&event.type!=='touchend')event.preventDefault();
   lockUntil=now()+1200;
   reachedEndAt=null;
   if(win.location.hash)win.history.replaceState(win.history.state,'',win.location.pathname+win.location.search);
   win.scrollTo({top:0,left:0,behavior:'instant'});
   if(event.type==='keydown'){
    const hero=doc.getElementById('hero');
    if(hero){hero.setAttribute('tabindex','-1');hero.focus({preventScroll:true});}
   }
   return true;
  }
  function wheel(event){
   const freshGesture=now()-lastWheelAt>=wheelPause;
   lastWheelAt=now();
   // A trackpad's remaining momentum belongs to the gesture that reached the footer.
   if(freshGesture&&!event.ctrlKey&&event.deltaY>0&&Math.abs(event.deltaY)>Math.abs(event.deltaX||0))restart(event);
  }
  function touchStart(event){
   const point=event.touches.length===1?event.touches[0]:null;
   touch=point?{x:point.clientX,y:point.clientY,eligible:ready(event),downward:false}:null;
  }
  function touchMove(event){
   if(!touch||event.touches.length!==1){touch=null;return;}
   const point=event.touches[0],dy=touch.y-point.clientY,dx=touch.x-point.clientX;
   touch.downward=dy>24&&dy>Math.abs(dx);
  }
  function touchEnd(event){
   if(touch&&touch.eligible&&touch.downward)restart(event);
   touch=null;
  }
  function key(event){
   if(event.repeat||event.ctrlKey||event.altKey||event.metaKey||event.shiftKey)return;
   if(event.target&&event.target.closest&&event.target.closest('a,button,summary,[role="button"],[role="link"]'))return;
   if(['ArrowDown','PageDown',' '].includes(event.key))restart(event);
  }
  win.addEventListener('scroll',observeEnd,{passive:true});
  win.addEventListener('resize',observeEnd,{passive:true});
  win.addEventListener('wheel',wheel,{passive:false});
  win.addEventListener('touchstart',touchStart,{passive:true});
  win.addEventListener('touchmove',touchMove,{passive:true});
  win.addEventListener('touchend',touchEnd,{passive:true});
  win.addEventListener('touchcancel',()=>{touch=null;},{passive:true});
  win.addEventListener('keydown',key);
  observeEnd();
 }
 return {start};
});
