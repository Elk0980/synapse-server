const C=window.PALITRA_CONFIG||{};
/* Готовые решения главной — примеры, не позиции прайса: у них нет id в каталоге, поэтому нет «Купить»;
   единственное действие — заявка под повод через форму. Ссылки в Telegram в карточке нет (замечание Дарьи 20.09.2026).
   Цена показывается только из live-прайса по устойчивому priceId (пока не назначены — «Цена уточняется»);
   статических чисел здесь нет, чтобы старые цены не выглядели подтверждёнными. */
const products=[
 {occasion:'Выписка из роддома',n:'Выписка мальчика',d:'Украшаем встречу мамы и малыша: подбираем шары и цветы, берём на себя доставку. Выполняем эксклюзивные заказы под вашу историю.',priceId:'',c:'vypiska',img:'vypiska-malchik.jpg',alt:'Набор шаров на выписку мальчика — Palitra, Подольск'},
 {occasion:'День рождения ребёнка',n:'Шары на день рождения деток',d:'Собираем праздничное оформление для детского дня рождения: шары, цветы и доставка. Создаём эксклюзивные заказы с учётом возраста и темы праздника.',priceId:'',c:'den-rozhdeniya malysham',img:'shary-dr-detok.jpg',alt:'Шары на день рождения детей — Palitra, Подольск'},
 {occasion:'День рождения мужчине',n:'Мужской сет на день рождения',d:'Сердце с фото и надписью и шары на атласной ленте. Фото и надпись согласуем с вами заранее, доставим к нужному времени.',priceId:'',c:'muzhchinam den-rozhdeniya',img:'muzhskoy-set.jpg',alt:'Мужской сет на день рождения: сердце с надписью и шары — Palitra, Подольск'},
 {occasion:'День рождения женщине',n:'Хризантема в нежно-персиковом',d:'Подбираем нежное оформление дня рождения: цветы, шары и доставку к нужному времени. Собираем эксклюзивные заказы по вашим пожеланиям.',priceId:'',c:'bukety den-rozhdeniya',img:'hrizantema.jpg',alt:'Букет хризантем в нежно-персиковом цвете — Palitra, Подольск'}
];
if(C.FLOWERS_VISIBLE===false)products[3]={...products[3],n:'Шары для дня рождения',d:'Подберём оформление по вашим пожеланиям.',c:'den-rozhdeniya shary',img:'shary-dr-detok.jpg',alt:'Шары Palitra для дня рождения'};
if(C.FLOWERS_VISIBLE===false)products.forEach(product=>{product.d=product.d.replace(/шары и цветы/g,'шары').replace(/шары, цветы и доставка/g,'шары и доставка').replace(/цветы, шары/g,'шары')});
const PRICE_UNKNOWN='Цена уточняется';
const escText=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/* Та же структура карточки, что в price-render.js: медиа 4:5, тело, прижатый к низу блок цены и действий. */
function cards(list,home=false){
  if(home){
    const routes=['/catalog/vypiska','/catalog/malysham','/catalog/muzhchinam',C.FLOWERS_VISIBLE === false ? '/catalog/den-rozhdeniya' : '/catalog/bukety'];
    return list.map((x,i)=>`<article class="card product-card occasion-card" data-cat="${x.c}"><a href="${routes[i]}" class="occasion-card-link"><div class="product-media"><img class="photo" src="/assets/img/${x.img}" alt="${x.alt}" loading="lazy" decoding="async" width="800" height="1000"></div><div class="occasion-card-copy"><h3>${x.occasion}</h3><span>Выбрать <b aria-hidden="true">↗</b></span></div></a></article>`).join('');
  }
  return list.map(x=>`<article class="card product-card" data-cat="${x.c}"><div class="product-media"><img class="photo" src="/assets/img/${x.img}" alt="${x.alt}" loading="lazy" decoding="async" width="800" height="1000"></div><div class="price-card__body"><h3>${x.n}</h3><p class="price-card__description">${x.d}</p><p class="note">Стоимость подтвердит менеджер по заявке.</p><div class="product-footer"><div class="product-purchase"><p class="price" data-price-known="false"${x.priceId?` data-price-for="${escText(x.priceId)}"`:''}>${PRICE_UNKNOWN}</p><button class="button price-card__button" type="button" data-occasion="${x.occasion}">Заказать под Ваш повод</button></div></div></div></article>`).join('');
}
/* Подстановка live-цены по priceId, когда прайс загружен (price-render.js подключается после app.js). */
function applyLivePrices(){const nodes=[...document.querySelectorAll('[data-price-for]')];const api=window.PalitraPrice;if(!nodes.length||!api||!api.load)return;api.load(['/api/price','/data/price.json']).then(data=>{const index=new Map();for(const cat of (data&&data.categories)||[])for(const it of cat.items||[])if(it&&typeof it.id==='string')index.set(it.id,String(it.price??'').trim());for(const node of nodes){const price=index.get(node.dataset.priceFor);if(price){node.textContent=price;node.dataset.priceKnown='true';}}}).catch(()=>{});}
document.querySelectorAll('script[type="application/ld+json"]').forEach(script=>{const data=JSON.parse(script.textContent);const addImages=node=>{if(Array.isArray(node))return node.forEach(addImages);if(!node||typeof node!=='object')return;if(node['@type']==='LocalBusiness')node.logo=`${C.SITE_URL}/assets/img/logo-palitralove-dark.png`;Object.values(node).forEach(addImages)};addImages(data);script.textContent=JSON.stringify(data)});
const page=document.body.dataset.page;
const catalog=document.querySelector('[data-products]');
/* Витрина из live-прайса (главная, каталог, страницы разделов) рисует catalog-live.js; статичные карточки — только там, где её нет. */
if(catalog&&(page==='catalog'||catalog.hasAttribute('data-live-catalog')))catalog.innerHTML='<p class="catalog-empty" role="status">Загружаем каталог…</p>';
else if(catalog){let list=products;if(page==='vypiska')list=products.filter(x=>x.c.includes('vypiska')||x.c.includes('bukety'));if(page==='birthday')list=products.filter(x=>x.c.includes('den-rozhdeniya'));if(page==='men')list=products.filter(x=>x.c.includes('muzhchinam'));if(page==='dopamine')list=products.filter(x=>x.c.includes(C.FLOWERS_VISIBLE===false?'shary':'bukety'));if(page==='giants')list=products.filter(x=>x.c.includes('den-rozhdeniya'));catalog.innerHTML=cards(list,page==='home');if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',applyLivePrices,{once:true});else applyLivePrices();}
const menuButton=document.querySelector('[data-menu-toggle]');
const mobileMenu=document.querySelector('.navlinks');
function setMenu(open){if(!menuButton||!mobileMenu)return;mobileMenu.classList.toggle('is-open',open);menuButton.setAttribute('aria-expanded',String(open));}
document.addEventListener('click',e=>{const orderButton=e.target.closest('[data-occasion]');if(orderButton){const requestForm=document.querySelector('#zayavka form');const occasion=requestForm?.querySelector('[name=occasion]');if(occasion)occasion.value=orderButton.dataset.occasion;document.querySelector('#zayavka')?.scrollIntoView({behavior:'smooth'})}if(e.target.closest('[data-menu-toggle]'))setMenu(menuButton.getAttribute('aria-expanded')!=='true');if(e.target.closest('[data-menu-close]')||e.target.closest('.navlinks a'))setMenu(false);const f=e.target.closest('[data-filter]');if(f)document.querySelectorAll('[data-cat]').forEach(x=>x.classList.toggle('hidden',f.dataset.filter!=='all'&&!x.dataset.cat.includes(f.dataset.filter)));});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){const back=mobileMenu?.classList.contains('is-open')&&mobileMenu.contains(document.activeElement)&&menuButton?.getClientRects().length>0;setMenu(false);if(back)menuButton.focus();}});
/* Формы заявки и корзины обрабатывает assets/order.js: успех только после ответа сервера. */
const cookie=document.querySelector('.cookie');if(localStorage.getItem('palitra-cookie'))cookie?.remove();document.querySelectorAll('[data-cookie]').forEach(b=>b.onclick=()=>{localStorage.setItem('palitra-cookie',b.dataset.cookie);cookie.remove()});

if(C.FLOWERS_VISIBLE===false){
  document.querySelectorAll('body [data-flowers]').forEach(node=>node.hidden=true);
  if(/^\/uchitelyu(?:\/|$)/.test(location.pathname))document.querySelectorAll('script[type="application/ld+json"]').forEach(script=>script.remove());
  if(/^\/catalog\/(bukety|korziny)(?:\/|$)/.test(location.pathname)){
    document.querySelector('main h1').textContent='Этот раздел пока скрыт';
    const lead=document.querySelector('main .lead');if(lead)lead.innerHTML='Выберите шары и оформление в <a href="/catalog">каталоге</a> или <a href="/#zayavka">закажите индивидуальный подбор</a>.';
  }
}

/* «Ваши праздники» (Дарья 12.10.2026): сначала 4 фото (loading=lazy), ещё 2 получают src только при первом
   раскрытии. Клик по фото открывает оригинал целиком в своём окне; Escape, кнопка и клик по фону закрывают,
   фокус возвращается к фото. Окно товара, корзина и прочие обработчики не затрагиваются. Без JS ссылка
   открывает оригинал обычным переходом. */
(()=>{
  const root=document.querySelector('[data-palitra-stories]');
  if(!root)return;
  const toggle=root.querySelector('[data-stories-toggle]');
  const label=toggle&&toggle.querySelector('[data-stories-label]'),arrow=toggle&&toggle.querySelector('[data-stories-arrow]');
  const extra=[...root.querySelectorAll('[data-story-more]')];
  if(toggle&&label&&arrow&&extra.length){
    const setOpen=open=>{
      for(const item of extra){
        if(open)item.querySelectorAll('img[data-story-src]').forEach(img=>{img.src=img.dataset.storySrc;img.removeAttribute('data-story-src');});
        item.hidden=!open;
      }
      toggle.setAttribute('aria-expanded',String(open));
      label.textContent=open?'Скрыть':'Показать ещё';arrow.textContent=open?'↑':'→';
    };
    toggle.addEventListener('click',()=>{
      const open=toggle.getAttribute('aria-expanded')!=='true';
      // Фокус не остаётся внутри скрываемого фото.
      if(!open&&extra.some(item=>item.contains(document.activeElement)))toggle.focus({preventScroll:true});
      setOpen(open);
    });
    toggle.hidden=false;
  }
  const dialog=root.querySelector('[data-story-dialog]');
  const full=dialog&&dialog.querySelector('[data-story-full]'),closeButton=dialog&&dialog.querySelector('[data-story-close]');
  if(!dialog||!full||!closeButton)return;
  let opener=null;
  const restore=()=>{if(dialog.hasAttribute('open'))return;full.removeAttribute('src');full.alt='';const back=opener;opener=null;if(back&&document.contains(back))back.focus();};
  const isOpen=()=>dialog.hasAttribute('open');
  const close=()=>{
    if(!isOpen())return;
    if(typeof dialog.close==='function')dialog.close();else dialog.removeAttribute('open');
    restore();// повторный вызов из события close безопасен: opener уже сброшен
  };
  dialog.addEventListener('close',restore);
  closeButton.addEventListener('click',close);
  dialog.addEventListener('click',e=>{if(e.target===dialog)close();});
  dialog.addEventListener('keydown',e=>{if(e.key==='Escape'&&typeof dialog.showModal!=='function'){e.preventDefault();close();}});
  root.addEventListener('click',e=>{
    const link=e.target.closest('[data-story-open]');
    if(!link||!root.contains(link)||link.closest('[data-story-more][hidden]'))return;
    e.preventDefault();
    opener=link;
    full.src=link.getAttribute('href');
    full.alt=link.querySelector('img')?.alt||'';
    if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
    closeButton.focus();
  });
})();
