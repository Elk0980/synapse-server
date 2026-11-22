'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync,spawnSync}=require('node:child_process'),{createHash}=require('node:crypto');
const {createReelPreviews,transcode,PROFILE}=require('./reel-previews');
const name=n=>n.repeat(32)+'.mp4',tick=()=>new Promise(r=>setTimeout(r,0));
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'reel-preview-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dir=path.join(root,'publishing','alpha');fs.mkdirSync(dir,{recursive:true});for(const n of ['a','b','c','d'])fs.writeFileSync(path.join(dir,name(n)),'SAMPLE source '+n);
 return {root,dir};}
test('preview: один исполнитель, очередь/повторы, атомарный кеш между рестартами, исходник не изменён',async t=>{
 const f=fixture(t),pending=[],calls=[];const convert=(source,target)=>new Promise(resolve=>{calls.push({source,target});pending.push(()=>{fs.writeFileSync(target,'SAMPLE preview');resolve();});});
 const worker=createReelPreviews({assetsDir:f.root,convert,maxQueue:1});t.after(()=>worker.close());
 assert.equal(worker.inspect('alpha',name('a')).state,'preparing');assert.equal(worker.inspect('alpha',name('a')).state,'preparing');assert.equal(calls.length,1);
 assert.equal(worker.inspect('alpha',name('c'),{start:false}).state,'busy');assert.equal(calls.length,1);
 assert.equal(worker.inspect('alpha',name('b')).state,'queued');assert.equal(worker.inspect('alpha',name('c')).state,'busy');
 assert.equal(worker.inspect('alpha',name('a'),{start:false}).state,'preparing');
 assert.equal(fs.existsSync(path.join(f.root,'publishing-previews',PROFILE,'alpha',name('a'))),false,'полуготовый файл не отдаётся');
 pending.shift()();await tick();assert.equal(calls.length,2);const ready=worker.inspect('alpha',name('a'));assert.equal(ready.state,'ready');assert.match(ready.file,/publishing-previews/);
 assert.equal(fs.readFileSync(path.join(f.dir,name('a')),'utf8'),'SAMPLE source a');
 pending.shift()();await tick();assert.equal(worker.inspect('alpha',name('b')).state,'ready');
 const second=createReelPreviews({assetsDir:f.root,convert:()=>{throw Error('не пересобирать');}});t.after(()=>second.close());assert.equal(second.inspect('alpha',name('a')).file,ready.file);
 for(const args of [['../alpha',name('a')],['alpha','../'+name('a')],['other',name('a')],['alpha','a.webm']])assert.throws(()=>worker.inspect(...args),{status:404});
});
test('preview: ошибка не печатается/не запускается по кругу, повтор ограничен; shutdown отменяет работу',async t=>{
 const f=fixture(t);let now=0,calls=0;
 const worker=createReelPreviews({assetsDir:f.root,now:()=>now,retryMs:100,convert:async()=>{calls++;throw Error('PRIVATE PATH/TEXT');}});
 worker.inspect('alpha',name('a'));await tick();assert.deepEqual(worker.inspect('alpha',name('a')),{state:'failed'});assert.equal(calls,1);
 now=101;worker.inspect('alpha',name('a'));await tick();assert.equal(calls,2);await worker.close();
 let cancelled=false;const second=createReelPreviews({assetsDir:f.root,convert:async(source,target,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{cancelled=true;reject(Error('STOP'));}))});
 second.inspect('alpha',name('b'));await second.close();assert.equal(cancelled,true);assert.equal(second.inspect('alpha',name('c')).state,'busy');
 assert.equal(fs.readdirSync(path.join(f.root,'publishing-previews',PROFILE,'alpha')).length,0);
});
const hasFfmpeg=spawnSync('ffmpeg',['-version'],{windowsHide:true}).status===0&&spawnSync('ffprobe',['-version'],{windowsHide:true}).status===0;
test('настоящий FFmpeg: лёгкая H.264/AAC копия, весь таймлайн, faststart, оригинальный SHA неизменен',{skip:!hasFfmpeg},async t=>{
 const f=fixture(t),source=path.join(f.dir,name('a')),target=path.join(f.root,'preview.mp4');
 execFileSync('ffmpeg',['-nostdin','-v','error','-y','-f','lavfi','-i','testsrc2=size=1080x1920:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000',
  '-t','2','-c:v','libx264','-preset','ultrafast','-crf','0','-c:a','aac','-movflags','+faststart',source],{windowsHide:true,timeout:30000});
 if(fs.statSync(source).size<=10*1024*1024){const free=Buffer.alloc(10*1024*1024+9-fs.statSync(source).size);free.writeUInt32BE(free.length);free.write('free',4);fs.appendFileSync(source,free);}
 const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex'),before=hash(source);
 await transcode(source,target);assert.equal(hash(source),before);assert.ok(fs.statSync(target).size<fs.statSync(source).size);
 const data=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',target],{windowsHide:true,encoding:'utf8'}));
 const v=data.streams.find(s=>s.codec_type==='video'),a=data.streams.find(s=>s.codec_type==='audio');
 assert.equal(v.codec_name,'h264');assert.equal(v.profile,'Main');assert.equal(v.level,31);assert.equal(v.width,720);assert.equal(v.height,1280);assert.equal(v.pix_fmt,'yuv420p');assert.equal(a.codec_name,'aac');assert.ok(Math.abs(Number(data.format.duration)-2)<.15);
 const bytes=fs.readFileSync(target);assert.ok(bytes.indexOf(Buffer.from('moov'))<bytes.indexOf(Buffer.from('mdat')));
 const second=path.join(f.root,'already-light.mp4');await transcode(target,second);assert.equal(hash(second),hash(target),'лёгкая совместимая копия сохраняется без повторного кодирования');
});
