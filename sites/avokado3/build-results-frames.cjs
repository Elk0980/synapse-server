/* Display-only crop viewports. Uses existing public assets; creates no image files. */
const fs=require('node:fs');
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=n=>Number(n.toFixed(4));
function frame(photo,output,alt){
 const {width:w,height:h,gutter:gap,background}=output;
 const cw=photo.layout==='columns'?(w-gap)/2:w;
 const ch=photo.layout==='rows'?(h-gap)/2:h;
 const scale=Math.min(...photo.regions.flatMap(r=>[cw/r[2],ch/r[3]]));
 const views=photo.regions.map(([x,y,rw,rh],i)=>{
  if(x<0||y<0||x+rw>photo.sourceWidth||y+rh>photo.sourceHeight)throw Error('Invalid crop '+photo.id);
  const vw=rw*scale,vh=rh*scale;
  const left=(photo.layout==='columns'?i*(cw+gap):0)+(cw-vw)/2;
  const top=(photo.layout==='rows'?i*(ch+gap):0)+(ch-vh)/2;
  return `<svg x="${number(left)}" y="${number(top)}" width="${number(vw)}" height="${number(vh)}" viewBox="${x} ${y} ${rw} ${rh}" overflow="hidden"><image href="${esc(photo.source)}" width="${photo.sourceWidth}" height="${photo.sourceHeight}"/></svg>`;
 });
 return `<svg xmlns="http://www.w3.org/2000/svg" class="results-comparison" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(alt)}" focusable="false"><rect width="${w}" height="${h}" fill="${esc(background)}"/>${views.join('')}</svg>`;
}
if(require.main===module){
 const recipe=JSON.parse(fs.readFileSync('results-crop-recipe.json','utf8'));
 const path='index.html';let count=0;
 const html=fs.readFileSync(path,'utf8').replace(/<a class="results-photo"([^>]*)>[\s\S]*?<\/a>/g,(all,attrs)=>{
  const id=attrs.match(/result-(\d+)-(?:clean-)?20260915/)[1];
  const photo=recipe.images.find(p=>p.id===id);if(!photo)throw Error('Missing recipe '+id);
  const alt=attrs.match(/aria-label="([^"]+)"/)[1].replace(/^Увеличить фото: /,'');count++;
  return '<a class="results-photo"'+attrs.replace(/result-(\d+)-clean-20260915/g,'result-$1-20260915')+'>'+frame(photo,recipe.output,alt)+'</a>';
 });
 if(count!==14)throw Error('Expected 14 cards, got '+count);
 fs.writeFileSync(path,html);console.log('14 public-source comparison frames updated');
}
module.exports={frame};
