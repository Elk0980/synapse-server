const test=require('node:test'),assert=require('node:assert/strict');
const {start,preferenceKey}=require('./music-player.js');
function setup(preference,options={}){
 const stored=new Map(preference===undefined?[]:[[preferenceKey,preference]]),attempts=[];
 function element(){return {events:{},attrs:{},dataset:{},addEventListener(name,fn){this.events[name]=fn;},setAttribute(name,value){this.attrs[name]=value;},emit(name){this.events[name]?.();}};}
 const button=element(),status={textContent:''},audio=Object.assign(element(),{
  paused:true,volume:1,calls:0,
  pause(){this.paused=true;this.emit('pause');},
  play(){
   this.calls+=1;
   if(options.throwPlay)throw options.throwPlay;
   return new Promise((resolve,reject)=>attempts.push({resolve:()=>{this.paused=false;this.emit('play');resolve();},reject}));
  }
 });
 const win={localStorage:{getItem(key){if(options.storageBlocked)throw Error('storage blocked');return stored.get(key);},setItem(key,value){if(options.storageBlocked)throw Error('storage blocked');stored.set(key,value);}}};
 const doc={getElementById:id=>({'background-music':audio,'music-toggle':button,'music-status':status}[id])};
 start(win,doc);
 return {audio,button,status,stored,attempts,click:()=>button.emit('click')};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('a new visitor and a saved mute do not start music or fetch it through play',()=>{
 for(const preference of [undefined,'off']){
  const s=setup(preference);assert.equal(s.audio.calls,0);assert.equal(s.audio.paused,true);
  assert.equal(s.button.attrs['aria-pressed'],'false');assert.equal(s.button.hidden,false);
 }
});

test('the toggle starts quietly, reports playback, and remembers an explicit mute',async()=>{
 const s=setup();s.click();assert.equal(s.audio.calls,1);assert.equal(s.audio.volume,0.14);
 assert.equal(s.button.attrs['aria-busy'],'true');
 s.attempts[0].resolve();await settle();
 assert.equal(s.button.attrs['aria-pressed'],'true');assert.equal(s.stored.get(preferenceKey),'on');
 s.click();assert.equal(s.audio.paused,true);assert.equal(s.button.attrs['aria-pressed'],'false');
 assert.equal(s.stored.get(preferenceKey),'off');
});

test('a remembered opt-in attempts once; autoplay rejection is caught and requires the button',async()=>{
 const s=setup('on');assert.equal(s.audio.calls,1);
 s.attempts[0].reject(Object.assign(Error('autoplay blocked'),{name:'NotAllowedError'}));await settle();
 assert.equal(s.audio.calls,1);assert.equal(s.button.attrs['aria-pressed'],'false');
 assert.match(s.status.textContent,/Нажмите/);assert.equal(s.button.attrs['aria-busy'],'false');
 s.click();s.attempts[1].resolve();await settle();assert.equal(s.button.attrs['aria-pressed'],'true');
});

test('muting while loading prevents late playback and a stale promise cannot undo a later choice',async()=>{
 const s=setup();s.click();s.click();s.attempts[0].resolve();await settle();
 assert.equal(s.audio.paused,true);assert.equal(s.stored.get(preferenceKey),'off');
 assert.equal(s.button.attrs['aria-pressed'],'false');
 s.click();s.click();s.click();s.attempts[1].reject(Error('cancelled request'));await settle();
 assert.equal(s.button.attrs['aria-busy'],'true');
 s.attempts[2].resolve();await settle();assert.equal(s.button.attrs['aria-pressed'],'true');
});

test('blocked storage leaves playback usable and a network error resets the visible state',async()=>{
 const s=setup(undefined,{storageBlocked:true});s.click();s.attempts[0].resolve();await settle();
 assert.equal(s.button.attrs['aria-pressed'],'true');
 s.audio.error={code:2};s.audio.emit('error');
 assert.equal(s.audio.paused,true);assert.equal(s.button.attrs['aria-pressed'],'false');
 assert.match(s.status.textContent,/Не удалось/);s.click();assert.equal(s.audio.calls,2);
 s.attempts[1].resolve();await settle();s.click();assert.equal(s.audio.paused,true);
});

test('a synchronous browser failure is handled without a stuck loading button',()=>{
 const s=setup(undefined,{throwPlay:Error('unavailable')});assert.doesNotThrow(()=>s.click());
 assert.equal(s.button.attrs['aria-busy'],'false');assert.equal(s.button.attrs['aria-pressed'],'false');
 assert.match(s.status.textContent,/Не удалось/);
});
