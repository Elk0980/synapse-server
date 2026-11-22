'use strict';
// specs/238: только производная копия уже сохранённого MP4. Исходник и БД не меняются.
const fs=require('node:fs'),path=require('node:path'),{execFile}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const PROFILE='mobile-v1',MAX_SOURCE=60*1024*1024;
function run(command,args,{signal,timeout=120000}={}){
 return new Promise((resolve,reject)=>execFile(command,args,{signal,timeout,killSignal:'SIGKILL',maxBuffer:32768,windowsHide:true},
  (error,stdout)=>error?reject(Error('PREVIEW_PROCESS_FAILED')):resolve(stdout)));
}
async function probe(file,options,execute=run){
 const data=JSON.parse(await execute('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-enable_drefs','0','-f','mov','-show_entries',
  'format=duration:stream=codec_type,codec_name,width,height,pix_fmt,level,profile,avg_frame_rate','-of','json',file],{...options,timeout:15000}));
 const duration=Number(data.format?.duration),video=data.streams?.find(s=>s.codec_type==='video');
 if(!Number.isFinite(duration)||duration<=0||duration>600||!video
   ||![video.width,video.height].every(n=>Number.isSafeInteger(n)&&n>=2&&n<=3840)
   ||video.width*video.height>3840*2160)throw Error('PREVIEW_INVALID_MEDIA');
 return {duration,video,audio:data.streams.find(s=>s.codec_type==='audio')};
}
async function transcode(source,target,{signal}={},execute=run){
 const input=await probe(source,{signal},execute);
 const [frames,seconds]=String(input.video.avg_frame_rate).split('/').map(Number),fps=frames/seconds;
 // Старые лёгкие MP4 уже пригодны для просмотра: не увеличиваем их размер перекодированием.
 if((fs.statSync(source).size<=10*1024*1024||fs.statSync(source).size*8/input.duration<=1200000)
   &&input.video.width<=1080&&input.video.height<=1920&&input.video.level<=40&&input.video.codec_name==='h264'&&input.video.pix_fmt==='yuv420p'
   &&['Constrained Baseline','Baseline','Main','High'].includes(input.video.profile)&&Number.isFinite(fps)&&fps>0&&fps<=30
   &&(!input.audio||input.audio.codec_name==='aac')){fs.copyFileSync(source,target);return;}
 await execute('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-y','-protocol_whitelist','file,pipe',
  '-threads','1','-filter_threads','1','-enable_drefs','0','-f','mov','-i',source,
  '-map','0:v:0','-map','0:a:0?','-map_metadata','-1','-map_chapters','-1',
  '-vf','scale=720:1280:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30,setsar=1',
  '-c:v','libx264','-preset','veryfast','-threads','1','-profile:v','main','-level:v','3.1','-pix_fmt','yuv420p',
  '-b:v','900k','-maxrate','1100k','-bufsize','2200k','-refs','2','-bf','2','-g','60',
  '-c:a','aac','-ac','2','-ar','48000','-b:a','96k','-movflags','+faststart','-f','mp4',target],{signal});
 const output=await probe(target,{signal},execute);
 if(Math.abs(input.duration-output.duration)>.15||output.video.codec_name!=='h264'||output.video.pix_fmt!=='yuv420p'
   ||output.video.width>720||output.video.height>1280||input.audio&&output.audio?.codec_name!=='aac')throw Error('PREVIEW_INVALID_RESULT');
}
function createReelPreviews({assetsDir,convert=transcode,now=Date.now,maxQueue=8,retryMs=300000}={}){
 const base=path.resolve(assetsDir),jobs=new Map(),queue=[];let active=null,closed=false;
 const root=path.join(base,'publishing-previews',PROFILE);
 const valid=(company,name)=>/^[a-z0-9_-]{1,64}$/.test(company)&&/^[a-f0-9]{32}\.mp4$/.test(name);
 const status=job=>({state:job.state});
 function pump(){
  if(active||closed||!queue.length)return;
  const job=queue.shift();active=job;job.state='preparing';job.controller=new AbortController();
  const temporary=job.target+'.'+randomUUID()+'.tmp';
  job.promise=(async()=>{
   try{
    fs.mkdirSync(path.dirname(job.target),{recursive:true});
    await convert(job.source,temporary,{signal:job.controller.signal});
    if(closed)throw Error('CLOSED');
    const size=fs.statSync(temporary).size;if(!size||size>100*1024*1024)throw Error('INVALID_SIZE');
    fs.renameSync(temporary,job.target);job.state='ready';
   }catch{job.state='failed';job.failedAt=now();}
   finally{try{fs.unlinkSync(temporary);}catch{}active=null;pump();}
  })();
 }
 function inspect(company,name,{start=true}={}){
  if(!valid(company,name))throw Object.assign(Error('Материал не найден'),{status:404});
  const source=path.join(base,'publishing',company,name),target=path.join(root,company,name);
  const sourceStat=fs.statSync(source,{throwIfNoEntry:false});
  if(!sourceStat?.isFile())throw Object.assign(Error('Материал не найден'),{status:404});
  if(sourceStat.size>MAX_SOURCE)return {state:'failed'};
  // Производные сохраняются между рестартами, но никогда не подменяют исходный путь.
  const cached=fs.statSync(target,{throwIfNoEntry:false});if(cached?.isFile()&&cached.size>0)return {state:'ready',file:target};
  const key=company+'/'+name;let job=jobs.get(key);
  if(job?.state==='ready'){jobs.delete(key);job=null;}
  if(job?.state==='failed'&&now()-job.failedAt>=retryMs){jobs.delete(key);job=null;}
  if(job)return status(job);
  if(!start||closed||queue.length>=maxQueue)return {state:'busy'};
  // Ограничиваем также память завершённых ошибок; готовые файлы живут в отдельном кеше.
  if(jobs.size>=256)for(const [key,item]of jobs)if(['failed','ready'].includes(item.state)){jobs.delete(key);if(jobs.size<256)break;}
  if(jobs.size>=256)return {state:'busy'};
  job={source,target,state:'queued'};jobs.set(key,job);queue.push(job);pump();return status(job);
 }
 async function close(){closed=true;queue.length=0;const running=active;running?.controller.abort();await running?.promise;}
 return {inspect,close,profile:PROFILE};
}
module.exports={createReelPreviews,transcode,PROFILE};
