const C=window.PALITRA_CONFIG||{};
const products=[
 {n:'Хризантема в нежно-персиковом',p:3290,c:'bukety',img:'hrizantema.jpg',alt:'Букет хризантем в нежно-персиковом цвете — Palitra Love, Подольск'}, {n:'Белые гортензии',p:4590,c:'bukety',img:'gortenzii.jpg',alt:'Букет белых гортензий — Palitra Love, Подольск'},
 {n:'Дембель 2026',p:4990,c:'muzhchinam',img:'dembel.jpg',alt:'Набор шаров «Дембель 2026» — Palitra Love, Подольск'}, {n:'Шары на день рождения деток',p:5540,c:'den-rozhdeniya',img:'shary-dr-detok.jpg',alt:'Шары на день рождения детей — Palitra Love, Подольск'},
 {n:'Дофаминовые шарики',p:6290,c:'dofaminovye',img:'dofaminovye.jpg',alt:'Набор дофаминовых шариков — Palitra Love, Подольск'}, {n:'Мужской сет на день рождения',d:'сердце с фото и надписью + 20 шаров на атласной ленте',p:7990,c:'muzhchinam den-rozhdeniya',img:'muzhskoy-set.jpg',alt:'Мужской сет из шаров на день рождения — Palitra Love, Подольск'},
 {n:'Шары для деток',p:8390,c:'malysham den-rozhdeniya',img:'shary-detkam.jpg',alt:'Праздничные шары для детей — Palitra Love, Подольск'}, {n:'Выписка мальчика',p:9270,c:'vypiska',img:'vypiska-malchik.jpg',alt:'Набор шаров на выписку мальчика — Palitra Love, Подольск'},
 {n:'Корзина с розой Вегги',p:9990,c:'korziny',img:'korzina-vegg.jpg',alt:'Корзина с розой Вегги — Palitra Love, Подольск'}, {n:'Летняя корзина ромашек',p:10990,c:'korziny',img:'letnyaya-korzina.jpg',alt:'Летняя корзина ромашек — Palitra Love, Подольск'},
 {n:'Индивидуальное оформление шарами',d:'2 фонтана с печатью на сердце, баблс с фото именинника, цифры 102 см, шары в потолок',p:26870,c:'den-rozhdeniya',feature:true,img:'individualnoe.jpg',alt:'Индивидуальное оформление праздника шарами — Palitra Love, Подольск'}
];
const money=n=>new Intl.NumberFormat('ru-RU').format(n)+' руб.';
let cart=JSON.parse(localStorage.getItem('palitra-cart')||'[]');
function save(){localStorage.setItem('palitra-cart',JSON.stringify(cart));drawCart();}
function add(i){cart.push(i);save();document.querySelector('.cart').classList.remove('hidden')}
function cards(list,feature=false){return list.map((x,i)=>`<article class="card ${feature&&x.feature?'feature':''}" data-cat="${x.c}"><img class="photo" src="/assets/img/${x.img}" alt="${x.alt}" loading="lazy" decoding="async" width="800" height="1000"><div><h3>${x.n}</h3>${x.d?`<p>${x.d}</p>`:''}<p class="price">${money(x.p)}</p><p class="note">Цена на момент публикации, актуальную подтверждаем при заказе.</p><button data-add="${products.indexOf(x)}">В корзину</button></div></article>`).join('')}
document.querySelectorAll('script[type="application/ld+json"]').forEach(script=>{const data=JSON.parse(script.textContent);const addImages=node=>{if(Array.isArray(node))return node.forEach(addImages);if(!node||typeof node!=='object')return;if(node['@type']==='Product'){const product=products.find(x=>x.n===node.name);if(product)node.image=`${C.SITE_URL}/assets/img/${product.img}`}if(node['@type']==='LocalBusiness')node.logo=`${C.SITE_URL}/assets/img/logo-dark.svg`;Object.values(node).forEach(addImages)};addImages(data);script.textContent=JSON.stringify(data)});
function drawCart(){document.querySelectorAll('[data-cart-count]').forEach(x=>x.textContent=cart.length);const b=document.querySelector('[data-cart-items]');if(!b)return;b.innerHTML=cart.length?cart.map((i,k)=>`<div class="cart-row"><span>${products[i].n}</span><b>${money(products[i].p)}</b><button aria-label="Удалить" data-remove="${k}">×</button></div>`).join(''):'<p>Корзина пуста.</p>';document.querySelector('[data-total]').textContent=money(cart.reduce((s,i)=>s+products[i].p,0));}
const page=document.body.dataset.page;
const catalog=document.querySelector('[data-products]');if(catalog){let list=products;if(page==='home')list=[products[7],products[6],products[10]];if(page==='vypiska')list=products.filter(x=>x.c.includes('vypiska')||x.c.includes('bukety'));if(page==='birthday')list=products.filter(x=>[5540,8390,26870,7990].includes(x.p));if(page==='men')list=products.filter(x=>[4990,7990].includes(x.p));if(page==='dopamine')list=products.filter(x=>['bukety','korziny','dofaminovye'].some(category=>x.c.split(' ').includes(category)));if(page==='giants')list=products.filter(x=>[26870,8390].includes(x.p));catalog.innerHTML=cards(list,page==='birthday')}
const menuButton=document.querySelector('[data-menu-toggle]');
const mobileMenu=document.querySelector('.navlinks');
function setMenu(open){if(!menuButton||!mobileMenu)return;mobileMenu.classList.toggle('is-open',open);menuButton.setAttribute('aria-expanded',String(open));}
document.addEventListener('click',e=>{const a=e.target.closest('[data-add]');if(a)add(+a.dataset.add);const r=e.target.closest('[data-remove]');if(r){cart.splice(+r.dataset.remove,1);save()}if(e.target.closest('[data-cart-open]'))document.querySelector('.cart').classList.toggle('hidden');if(e.target.closest('[data-cart-close]'))document.querySelector('.cart').classList.add('hidden');if(e.target.closest('[data-menu-toggle]'))setMenu(menuButton.getAttribute('aria-expanded')!=='true');if(e.target.closest('[data-menu-close]')||e.target.closest('.navlinks a'))setMenu(false);const f=e.target.closest('[data-filter]');if(f)document.querySelectorAll('[data-cat]').forEach(x=>x.classList.toggle('hidden',f.dataset.filter!=='all'&&!x.dataset.cat.includes(f.dataset.filter)));});
document.addEventListener('keydown',e=>{if(e.key==='Escape')setMenu(false)});
document.querySelectorAll('form').forEach(f=>f.addEventListener('submit',e=>{e.preventDefault();if(!f.querySelector('[name=consent]:checked'))return;const data=Object.fromEntries(new FormData(f));data.items=cart.map(i=>products[i]);data.utm={};new URLSearchParams(location.search).forEach((v,k)=>{if(k.startsWith('utm_'))data.utm[k]=v});data.referrer=document.referrer;localStorage.setItem('palitra-last-order',JSON.stringify(data));[C.ORDER_ENDPOINT,C.TELEGRAM_ENDPOINT].filter(Boolean).forEach(endpoint=>fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}));f.innerHTML='<h3>Заказ создан</h3><p>Подтвердим заказ и пришлём ссылку на оплату.</p>';cart=[];save()}));
const cookie=document.querySelector('.cookie');if(localStorage.getItem('palitra-cookie'))cookie?.remove();document.querySelectorAll('[data-cookie]').forEach(b=>b.onclick=()=>{localStorage.setItem('palitra-cookie',b.dataset.cookie);cookie.remove()});
drawCart();
const povodyTrack=document.querySelector('[data-povody-track]');
if(povodyTrack){
 const povodCards=[...povodyTrack.children],dots=document.querySelector('[data-povody-dots]');
 const step=()=>povodCards[0].getBoundingClientRect().width+parseFloat(getComputedStyle(povodyTrack).gap||0);
 document.querySelector('[data-povod-prev]')?.addEventListener('click',()=>povodyTrack.scrollBy({left:-step(),behavior:'smooth'}));
 document.querySelector('[data-povod-next]')?.addEventListener('click',()=>povodyTrack.scrollBy({left:step(),behavior:'smooth'}));
 povodCards.forEach((card,index)=>{const dot=document.createElement('button');dot.type='button';dot.className='povody-dot';dot.setAttribute('aria-label',`Повод ${index+1}`);dot.addEventListener('click',()=>card.scrollIntoView({behavior:'smooth',block:'nearest',inline:'start'}));dots.append(dot)});
 const updateDots=()=>{const active=Math.round(povodyTrack.scrollLeft/step());[...dots.children].forEach((dot,index)=>dot.classList.toggle('is-active',index===active))};
 povodyTrack.addEventListener('scroll',updateDots,{passive:true});updateDots();

 const videoCards=povodCards.filter(card=>card.querySelector('[data-video-src]'));
 const disableVideo=matchMedia('(max-width: 767px), (prefers-reduced-motion: reduce)');
 let videoObserver,activeVideo;
 const unloadVideo=video=>{
  video.pause();
  video.currentTime=0;
  video.removeAttribute('src');
  video.load();
 };
 const stopVideos=()=>{
  videoObserver?.disconnect();
  videoObserver=null;
  videoCards.forEach(card=>unloadVideo(card.querySelector('video')));
  activeVideo=null;
 };
 const startVideoObserver=()=>{
  if(disableVideo.matches)return stopVideos();
  const visibleCards=new Map();
  videoObserver=new IntersectionObserver(entries=>{
   entries.forEach(entry=>visibleCards.set(entry.target,entry.intersectionRatio));
   const trackLeft=povodyTrack.getBoundingClientRect().left;
   const activeCard=videoCards
    .filter(card=>(visibleCards.get(card)||0)>=.6)
    .sort((a,b)=>Math.abs(a.getBoundingClientRect().left-trackLeft)-Math.abs(b.getBoundingClientRect().left-trackLeft))[0];
   const nextVideo=activeCard?.querySelector('video');
   if(nextVideo===activeVideo)return;
   if(activeVideo)unloadVideo(activeVideo);
   activeVideo=nextVideo||null;
   if(activeVideo){
    activeVideo.src=activeVideo.dataset.videoSrc;
    activeVideo.load();
    activeVideo.play().catch(()=>{});
   }
  },{root:povodyTrack,threshold:[0,.6,1]});
  videoCards.forEach(card=>videoObserver.observe(card));
 };
 disableVideo.addEventListener('change',startVideoObserver);
 startVideoObserver();
}
