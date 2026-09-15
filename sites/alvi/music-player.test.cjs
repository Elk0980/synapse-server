const test=require('node:test'),assert=require('node:assert/strict');
const {start,preferenceKey}=require('./music-player.js');
function setup(preference,options={}){
 const stored=new Map(preference===undefined?[]:[[preferenceKey,preference]]),attempts=[];
 function element(){return {events:{},attrs:{},dataset:{},addEventListener(name,fn){this.events[name]=fn;},setAttribute(name,value){this.attrs[name]=value;},emit(name){this.events[name]?.();}};}
 const button=element(),floating=element(),hero={bottom:800,getBoundingClientRect(){return {bottom:this.bottom};}},events={},status={textContent:''},audio=Object.assign(element(),{
  paused:true,volume:1,calls:0,
  pause(){this.paused=true;this.emit('pause');},
  play(){
   this.calls+=1;
   if(options.throwPlay)throw options.throwPlay;
   return new Promise((resolve,reject)=>attempts.push({resolve:()=>{this.paused=false;this.emit('play');resolve();},reject}));
  }
 });
 const win={addEventListener:(name,fn)=>events[name]=fn,localStorage:{getItem(key){if(options.storageBlocked)throw Error('storage blocked');return stored.get(key);},setItem(key,value){if(options.storageBlocked)throw Error('storage blocked');stored.set(key,value);}}};
 const doc={getElementById:id=>({'alvi-background-music':audio,'alvi-music-toggle':button,'alvi-music-toggle-floating':floating,'hero':hero,'alvi-music-status':status}[id])};
 start(win,doc);
 return {audio,button,floating,hero,events,status,stored,attempts,click:()=>button.emit('click')};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('ALVI preference is separate from Avokado and the supplied loop is wired without eager loading',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
 const source='assets/konstantinpazuzustudio-forest-harp-harp-and-birds-525281.mp3';
 assert.equal(preferenceKey,'alvi.background-music');
 const audioTag=html.match(/<audio\b[^>]*id="alvi-background-music"[^>]*>/)?.[0];
 assert.ok(audioTag);assert.ok(audioTag.includes('src="'+source+'"'));
 assert.match(audioTag,/\bpreload="none"/);assert.match(audioTag,/\bloop\b/);assert.doesNotMatch(audioTag,/\bautoplay\b/);
 assert.ok(fs.statSync(path.join(__dirname,source)).size>0);
 assert.match(html,/<header class="hero__chrome">[\s\S]*?id="alvi-music-toggle"[\s\S]*?<\/header>/);
});

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

test('the floating mute appears only after the hero while music is active, and keeps both controls in sync',async()=>{
 const s=setup();assert.equal(s.floating.hidden,true);
 s.hero.bottom=-20;s.events.scroll();assert.equal(s.floating.hidden,true);
 s.hero.bottom=800;s.click();s.attempts[0].resolve();await settle();
 assert.equal(s.floating.hidden,true);assert.equal(s.floating.attrs['aria-pressed'],'true');
 s.hero.bottom=0;s.events.scroll();assert.equal(s.floating.hidden,false);
 assert.equal(s.floating.title,'Выключить музыку');
 s.hero.bottom=100;s.events.resize();assert.equal(s.floating.hidden,true);
 s.hero.bottom=-20;s.events.scroll();assert.equal(s.floating.hidden,false);
 s.floating.emit('click');assert.equal(s.audio.paused,true);assert.equal(s.floating.hidden,true);
 assert.equal(s.button.attrs['aria-pressed'],'false');assert.equal(s.floating.attrs['aria-pressed'],'false');
 assert.equal(s.stored.get(preferenceKey),'off');
});

test('the floating control can cancel loading after scrolling and never reappears on late playback or media failure',async()=>{
 const s=setup();s.click();s.hero.bottom=-20;s.events.scroll();
 assert.equal(s.floating.hidden,false);assert.equal(s.floating.attrs['aria-busy'],'true');
 s.floating.emit('click');s.attempts[0].resolve();await settle();
 assert.equal(s.audio.paused,true);assert.equal(s.floating.hidden,true);
 s.click();s.attempts[1].reject(Error('network failure'));await settle();
 assert.equal(s.floating.hidden,true);assert.equal(s.button.attrs['aria-busy'],'false');
});
