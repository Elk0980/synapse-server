/* Background music starts only with the visitor's permission. */
(function(root,factory){
 'use strict';
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 if(root&&root.document)api.start(root,root.document);
})(typeof window==='undefined'?null:window,function(){
 'use strict';
 const preferenceKey='alvi.background-music';
 function start(win,doc){
  const audio=doc.getElementById('alvi-background-music');
  const button=doc.getElementById('alvi-music-toggle');
  const floating=doc.getElementById('alvi-music-toggle-floating');
  const hero=doc.getElementById('hero');
  const status=doc.getElementById('alvi-music-status');
  if(!audio||!button)return;
  const buttons=[button,floating].filter(Boolean);
  let wanted=false,pending=false,request=0;
  function remember(value){try{win.localStorage.setItem(preferenceKey,value);}catch(_){}}
  function positionControl(){
   if(floating)floating.hidden=!(wanted&&(pending||!audio.paused)&&hero&&hero.getBoundingClientRect().bottom<=0);
  }
  function render(message){
   const playing=wanted&&!pending&&!audio.paused;
   buttons.forEach(function(control){
    control.setAttribute('aria-pressed',String(playing));
    control.setAttribute('aria-busy',String(pending));
    control.dataset.state=pending?'loading':playing?'playing':'off';
    control.title=wanted&&(pending||!audio.paused)?'Выключить музыку':'Включить музыку';
   });
   positionControl();
   if(status&&message)status.textContent=message;
  }
  function off(save){
   wanted=false;pending=false;request+=1;
   audio.pause();
   if(save)remember('off');
   render(save?'Музыка выключена':'');
  }
  function failed(id,error){
   if(id!==request)return;
   wanted=false;pending=false;audio.pause();
   render(error&&error.name==='NotAllowedError'
    ?'Нажмите «Музыка», чтобы включить звук.'
    :'Не удалось включить музыку. Нажмите «Музыка», чтобы попробовать снова.');
  }
  function play(){
   wanted=true;pending=true;
   const id=++request;
   audio.volume=0.14;
   render('');
   let attempt;
   // Call play synchronously inside the click to retain browser user activation.
   try{attempt=audio.play();}catch(error){failed(id,error);return;}
   Promise.resolve(attempt).then(function(){
    if(id!==request){if(!wanted)audio.pause();return;}
    if(audio.paused){failed(id);return;}
    pending=false;remember('on');render('Музыка включена');
   },function(error){failed(id,error);});
  }
  buttons.forEach(function(control){control.addEventListener('click',function(){
   if(wanted&&(pending||!audio.paused))off(true);
   else play();
  });});
  if(floating){
   win.addEventListener('scroll',positionControl,{passive:true});
   win.addEventListener('resize',positionControl,{passive:true});
  }
  // A late media event must never undo a visitor's explicit mute.
  audio.addEventListener('play',function(){if(!wanted)audio.pause();});
  audio.addEventListener('pause',function(){render('');});
  audio.addEventListener('error',function(){if(wanted)failed(request,audio.error);});
  button.hidden=false;
  render('');
  let preference;
  try{preference=win.localStorage.getItem(preferenceKey);}catch(_){}
  // Remembered opt-in gets one attempt. A browser refusal requires the button.
  if(preference==='on')play();
 }
 return {start,preferenceKey};
});
