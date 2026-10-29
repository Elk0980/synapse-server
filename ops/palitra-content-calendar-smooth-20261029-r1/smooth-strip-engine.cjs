'use strict';
function createSmoothDateStrip({document:d,window:w,element:strip,onChange,addDays,validDay}){
 let disposed=false,selected=null,today=null,dates=[],cell=0,timer=null,frame=null,drag=null,pending=null,ignoreClickUntil=0,observer=null;
 const listeners=[],touches=new Set(),physicalTouches=new Set();
 const shift=(value,delta)=>{try{const result=addDays(value,delta);return validDay(result)?result:null;}catch{return null;}};
 const label=value=>new Intl.DateTimeFormat('ru-RU',{timeZone:'UTC',day:'numeric',month:'long',year:'numeric'}).format(new Date(value+'T12:00:00Z'));
 const weekday=new Intl.DateTimeFormat('ru-RU',{timeZone:'UTC',weekday:'short'});
 const reduced=()=>Boolean(w.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
 const listen=(el,name,handler,options)=>{el.addEventListener(name,handler,options);listeners.push(()=>el.removeEventListener(name,handler,options));};
 const clearTimer=()=>{if(timer!==null){w.clearTimeout(timer);timer=null;}};
 const later=delay=>{clearTimer();timer=w.setTimeout(()=>{timer=null;settle();},delay);};
 const nearestIndex=()=>Math.max(0,Math.min(dates.length-1,Math.round(strip.scrollLeft/(cell||1))));
 const nearest=()=>dates[nearestIndex()]||selected;
 function align(left,smooth){if(typeof strip.scrollTo==='function')strip.scrollTo({left,top:0,behavior:smooth&&!reduced()?'smooth':'auto'});else strip.scrollLeft=left;}
 function mark(){for(const button of strip.querySelectorAll('[data-content-day]')){const value=button.getAttribute('data-content-day');button.setAttribute('aria-pressed',String(value===selected));button.tabIndex=value===selected?0:-1;if(value===today)button.setAttribute('aria-current','date');else button.removeAttribute('aria-current');}}
 function build(center){
  const focusValue=strip.contains(d.activeElement)?d.activeElement.getAttribute('data-content-day'):null;
  const spacer=()=>{const node=d.createElement('span');node.className='content-calendar__edge';node.setAttribute('aria-hidden','true');return node;};
  dates=[];const fragment=d.createDocumentFragment();fragment.append(spacer());for(let offset=-46;offset<=46;offset++){const value=shift(center,offset);dates.push(value);const node=d.createElement(value?'button':'span');node.className='content-calendar__day';if(value){node.type='button';node.setAttribute('data-content-day',value);node.setAttribute('aria-label',label(value));const name=d.createElement('span');name.className='content-calendar__weekday';name.textContent=weekday.format(new Date(value+'T12:00:00Z'));const number=d.createElement('span');number.className='content-calendar__number';number.textContent=String(new Date(value+'T12:00:00Z').getUTCDate());node.append(name,number);}else node.setAttribute('aria-hidden','true');fragment.append(node);}fragment.append(spacer());strip.replaceChildren(fragment);mark();if(focusValue)strip.querySelector(`[data-content-day="${focusValue}"]`)?.focus({preventScroll:true});
 }
 function measure(){if(disposed)return;const measured=strip.clientWidth||strip.getBoundingClientRect().width,width=Math.min(measured,strip.parentElement?.clientWidth||measured);if(!width)return;const before=pending||selected,next=width/7;if(Math.abs(next-cell)<.01)return;cell=next;strip.style.setProperty('--content-day-size',cell+'px');if(before&&dates.includes(before))align(dates.indexOf(before)*cell,false);if(pending)center(pending);}
 function requestMeasure(){if(frame!==null)return;const request=w.requestAnimationFrame||((fn)=>w.setTimeout(fn,0));frame=request(()=>{frame=null;measure();});}
 function rebase(value){const index=dates.indexOf(value);if(index>=21&&index<=dates.length-22)return;build(value);align(dates.indexOf(value)*cell,false);}
 function settle(){
  if(disposed||!cell||!dates.length||drag?.active||touches.size||physicalTouches.size)return;const value=nearest();if(!validDay(value))return;const left=dates.indexOf(value)*cell;
  if(Math.abs(strip.scrollLeft-left)>.75){align(left,true);later(180);return;}
  pending=null;const changed=value!==selected;selected=value;mark();rebase(value);if(changed)onChange(value);
 }
 function center(value){
  if(disposed||!validDay(value))return;clearTimer();pending=value;if(!dates.includes(value)){build(value);if(cell)align(Math.max(0,dates.indexOf(value)-3)*cell,false);}
  measure();if(!cell){requestMeasure();later(180);return;}
  align(dates.indexOf(value)*cell,true);later(reduced()?0:180);
 }
 function setDate(value,actualToday){if(disposed||!validDay(value))return;today=validDay(actualToday)?actualToday:value;const changed=selected!==value;selected=value;if(!dates.length||!dates.includes(value))build(value);mark();if(changed){pending=null;clearTimer();measure();if(cell)align(dates.indexOf(value)*cell,false);else requestMeasure();}}
 function move(delta){const value=shift(pending||nearest()||selected,delta);if(value)center(value);}
 function finishDrag(event){if(touches.delete(event.pointerId)){later(170);return;}if(!drag||event.pointerId!==drag.id)return;const wasActive=drag.active,id=drag.id;drag=null;strip.classList.remove('content-calendar__week--dragging');if(strip.hasPointerCapture?.(id))strip.releasePointerCapture(id);if(wasActive){ignoreClickUntil=Date.now()+400;event.preventDefault();const value=nearest();if(value)center(value);}}
 listen(strip,'scroll',()=>{if(!disposed&&!drag?.active)later(170);},{passive:true});
 listen(strip,'scrollend',()=>{if(!disposed&&!drag?.active){clearTimer();settle();}});
 listen(strip,'wheel',()=>{pending=null;},{passive:true});
 listen(strip,'touchstart',event=>{for(const touch of event.changedTouches)physicalTouches.add(touch.identifier);pending=null;},{passive:true});
 const touchFinish=event=>{for(const touch of event.changedTouches)physicalTouches.delete(touch.identifier);if(!physicalTouches.size){touches.clear();later(170);}};
 listen(strip,'touchend',touchFinish,{passive:true});listen(strip,'touchcancel',touchFinish,{passive:true});
 listen(strip,'pointerdown',event=>{if(disposed)return;if(event.pointerType==='touch'){touches.add(event.pointerId);pending=null;return;}if(event.pointerType!=='mouse'||event.button!==0||event.isPrimary===false)return;clearTimer();pending=null;drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:strip.scrollLeft,active:false};});
 listen(strip,'pointermove',event=>{if(!drag||event.pointerId!==drag.id)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(!drag.active){if(Math.abs(dy)>8&&Math.abs(dy)>Math.abs(dx)){drag=null;return;}if(Math.abs(dx)<7||Math.abs(dx)<Math.abs(dy)*1.2)return;drag.active=true;strip.classList.add('content-calendar__week--dragging');strip.setPointerCapture?.(event.pointerId);}event.preventDefault();strip.scrollLeft=Math.max(0,Math.min((dates.length-1)*cell,drag.left-dx));});
 listen(strip,'pointerup',finishDrag);listen(strip,'pointercancel',finishDrag);listen(strip,'lostpointercapture',event=>{if(drag?.active)finishDrag(event);});
 listen(strip,'click',event=>{if(disposed)return;if(Date.now()<ignoreClickUntil){event.preventDefault();event.stopImmediatePropagation();return;}const target=event.target.closest?.('[data-content-day]');if(target&&strip.contains(target))center(target.getAttribute('data-content-day'));},true);
 listen(strip,'keydown',event=>{const current=event.target.getAttribute?.('data-content-day');if(!current)return;let delta=null;if(event.key==='ArrowLeft')delta=-1;if(event.key==='ArrowRight')delta=1;if(event.key==='PageUp')delta=-7;if(event.key==='PageDown')delta=7;if(delta===null)return;const value=shift(current,delta);if(value){event.preventDefault();center(value);strip.querySelector(`[data-content-day="${value}"]`)?.focus({preventScroll:true});}});
 if(typeof w.ResizeObserver==='function'){observer=new w.ResizeObserver(measure);observer.observe(strip,{box:'border-box'});}else listen(w,'resize',requestMeasure);
 return Object.freeze({setDate,center,move,dispose(){if(disposed)return;disposed=true;clearTimer();if(frame!==null){(w.cancelAnimationFrame||w.clearTimeout).call(w,frame);frame=null;}observer?.disconnect();for(const remove of listeners)remove();drag=null;pending=null;physicalTouches.clear();touches.clear();strip.classList.remove('content-calendar__week--dragging');}});
}
module.exports={createSmoothDateStrip};
