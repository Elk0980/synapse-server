/* Background music starts only with the visitor's permission. */
(function(root,factory){
 'use strict';
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 if(root&&root.document)api.start(root,root.document);
})(typeof window==='undefined'?null:window,function(){
 'use strict';
 const preferenceKey='avokado.background-music';
 function start(win,doc){
  const audio=doc.getElementById('background-music');
  const button=doc.getElementById('music-toggle');
  const status=doc.getElementById('music-status');
  if(!audio||!button)return;
  let wanted=false,pending=false,request=0;
  function remember(value){try{win.localStorage.setItem(preferenceKey,value);}catch(_){}}
  function render(message){
   const playing=wanted&&!pending&&!audio.paused;
   button.setAttribute('aria-pressed',String(playing));
   button.setAttribute('aria-busy',String(pending));
   button.dataset.state=pending?'loading':playing?'playing':'off';
   button.title=wanted&&(pending||!audio.paused)?'Выключить музыку':'Включить музыку';
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
  button.addEventListener('click',function(){
   if(wanted&&(pending||!audio.paused))off(true);
   else play();
  });
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
