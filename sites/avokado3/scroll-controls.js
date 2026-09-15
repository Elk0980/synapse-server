/* Fixed action visibility and an intentional next lap after the page end. */
(function(root,factory){
 'use strict';
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 if(root&&root.document)api.start(root,root.document);
})(typeof window==='undefined'?null:window,function(){
 'use strict';
 function start(win,doc){
  const panel=doc.getElementById('cta');
  const mobile=win.matchMedia('(max-width:820px)');
  let idleTimer=0,lastY=win.scrollY,lockUntil=0,touch=null,pendingTouchLoop=false;
  function reveal(){if(panel)panel.classList.remove('is-scrolling');}
  function moving(){
   win.clearTimeout(idleTimer);
   const keyboardFocus=panel&&doc.activeElement&&panel.contains(doc.activeElement)&&doc.activeElement.matches(':focus-visible');
   if(panel&&!keyboardFocus)panel.classList.add('is-scrolling');
   idleTimer=win.setTimeout(reveal,220);
  }
  function scroll(){
   if(Math.abs(win.scrollY-lastY)<1)return;
   lastY=win.scrollY;moving();
  }
  function atEnd(){
   const page=doc.scrollingElement||doc.documentElement;
   const end=page.scrollHeight-win.innerHeight;
   return end>win.innerHeight&&win.scrollY>=end-3;
  }
  function blocked(event){
   if(doc.querySelector('dialog[open]'))return true;
   if(event.target&&event.target.closest&&event.target.closest('input,textarea,select,[contenteditable="true"]'))return true;
   return false;
  }
  function restart(event){
   if(!atEnd()||blocked(event)||win.performance.now()<lockUntil)return false;
   if(event.cancelable&&event.type!=='touchend')event.preventDefault();
   lockUntil=win.performance.now()+1200;
   if(win.location.hash)win.history.replaceState(win.history.state,'',win.location.pathname+win.location.search);
   win.scrollTo({top:0,left:0,behavior:'instant'});
   if(event.type==='keydown'){
    const top=doc.getElementById('top');
    if(top){top.setAttribute('tabindex','-1');top.focus({preventScroll:true});}
   }
   moving();
   return true;
  }
  function wheel(event){
   if(!event.ctrlKey&&event.deltaY>0&&Math.abs(event.deltaY)>Math.abs(event.deltaX||0))restart(event);
  }
  function touchStart(event){
   const point=event.touches.length===1?event.touches[0]:null;
   touch=point?{x:point.clientX,y:point.clientY}:null;pendingTouchLoop=false;
  }
  function touchMove(event){
   if(!touch||event.touches.length!==1)return;
   const point=event.touches[0],dy=touch.y-point.clientY,dx=touch.x-point.clientX;
   if(Math.abs(dy)>8||Math.abs(dx)>8){
    pendingTouchLoop=dy>8&&dy>Math.abs(dx)&&atEnd()&&!blocked(event);
    touch={x:point.clientX,y:point.clientY};
   }
  }
  function touchEnd(event){
   if(pendingTouchLoop)restart(event);
   touch=null;pendingTouchLoop=false;
  }
  function key(event){
   if(event.ctrlKey||event.altKey||event.metaKey||event.shiftKey)return;
   if(event.target&&event.target.closest&&event.target.closest('a,button,summary'))return;
   if(['ArrowDown','PageDown',' '].includes(event.key))restart(event);
  }
  win.addEventListener('scroll',scroll,{passive:true});
  win.addEventListener('wheel',wheel,{passive:false});
  win.addEventListener('touchstart',touchStart,{passive:true});
  win.addEventListener('touchmove',touchMove,{passive:true});
  win.addEventListener('touchend',touchEnd,{passive:true});
  win.addEventListener('touchcancel',()=>{touch=null;pendingTouchLoop=false;},{passive:true});
  win.addEventListener('keydown',key);
  mobile.addEventListener('change',()=>{win.clearTimeout(idleTimer);reveal();});
 }
 return {start};
});
