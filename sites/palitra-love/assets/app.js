const C=window.PALITRA_CONFIG||{};
const products=[
 {n:'Хризантема в нежно-персиковом',p:3290,c:'bukety'}, {n:'Белые гортензии',p:4590,c:'bukety'},
 {n:'Дембель 2026',p:4990,c:'muzhchinam'}, {n:'Шары на день рождения деток',p:5540,c:'den-rozhdeniya'},
 {n:'Дофаминовые шарики',p:6290,c:'dofaminovye'}, {n:'Мужской сет на день рождения',d:'сердце с фото и надписью + 20 шаров на атласной ленте',p:7990,c:'muzhchinam den-rozhdeniya'},
 {n:'Шары для деток',p:8390,c:'malysham den-rozhdeniya'}, {n:'Выписка мальчика',p:9270,c:'vypiska'},
 {n:'Корзина с розой Вегги',p:9990,c:'korziny'}, {n:'Летняя корзина ромашек',p:10990,c:'korziny'},
 {n:'Индивидуальное оформление шарами',d:'2 фонтана с печатью на сердце, баблс с фото именинника, цифры 102 см, шары в потолок',p:26870,c:'den-rozhdeniya',feature:true}
];
const money=n=>new Intl.NumberFormat('ru-RU').format(n)+' руб.';
const placeholder='<div class="photo" role="img" aria-label="Фотография будет добавлена">Фото из Telegram-канала<br>будет добавлено</div>';
let cart=JSON.parse(localStorage.getItem('palitra-cart')||'[]');
function save(){localStorage.setItem('palitra-cart',JSON.stringify(cart));drawCart();}
function add(i){cart.push(i);save();document.querySelector('.cart').classList.remove('hidden')}
function cards(list,feature=false){return list.map((x,i)=>`<article class="card ${feature&&x.feature?'feature':''}" data-cat="${x.c}">${placeholder}<div><h3>${x.n}</h3>${x.d?`<p>${x.d}</p>`:''}<p class="price">${money(x.p)}</p><p class="note">Цена на момент публикации, актуальную подтверждаем при заказе.</p><button data-add="${products.indexOf(x)}">В корзину</button></div></article>`).join('')}
function drawCart(){document.querySelectorAll('[data-cart-count]').forEach(x=>x.textContent=cart.length);const b=document.querySelector('[data-cart-items]');if(!b)return;b.innerHTML=cart.length?cart.map((i,k)=>`<div class="cart-row"><span>${products[i].n}</span><b>${money(products[i].p)}</b><button aria-label="Удалить" data-remove="${k}">×</button></div>`).join(''):'<p>Корзина пуста.</p>';document.querySelector('[data-total]').textContent=money(cart.reduce((s,i)=>s+products[i].p,0));}
const page=document.body.dataset.page;
const catalog=document.querySelector('[data-products]');if(catalog){let list=products;if(page==='vypiska')list=products.filter(x=>x.c.includes('vypiska')||x.c.includes('bukety'));if(page==='birthday')list=products.filter(x=>[5540,8390,26870,7990].includes(x.p));if(page==='men')list=products.filter(x=>[4990,7990].includes(x.p));catalog.innerHTML=cards(list,page==='birthday')}
document.addEventListener('click',e=>{const a=e.target.closest('[data-add]');if(a)add(+a.dataset.add);const r=e.target.closest('[data-remove]');if(r){cart.splice(+r.dataset.remove,1);save()}if(e.target.closest('[data-cart-open]'))document.querySelector('.cart').classList.toggle('hidden');if(e.target.closest('[data-cart-close]'))document.querySelector('.cart').classList.add('hidden');const f=e.target.closest('[data-filter]');if(f)document.querySelectorAll('[data-cat]').forEach(x=>x.classList.toggle('hidden',f.dataset.filter!=='all'&&!x.dataset.cat.includes(f.dataset.filter)));});
document.querySelectorAll('form').forEach(f=>f.addEventListener('submit',e=>{e.preventDefault();if(!f.querySelector('[name=consent]:checked'))return;const data=Object.fromEntries(new FormData(f));data.items=cart.map(i=>products[i]);data.utm={};new URLSearchParams(location.search).forEach((v,k)=>{if(k.startsWith('utm_'))data.utm[k]=v});data.referrer=document.referrer;localStorage.setItem('palitra-last-order',JSON.stringify(data));[C.ORDER_ENDPOINT,C.TELEGRAM_ENDPOINT].filter(Boolean).forEach(endpoint=>fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}));f.innerHTML='<h3>Заказ создан</h3><p>Подтвердим заказ и пришлём ссылку на оплату.</p>';cart=[];save()}));
const cookie=document.querySelector('.cookie');if(localStorage.getItem('palitra-cookie'))cookie?.remove();document.querySelectorAll('[data-cookie]').forEach(b=>b.onclick=()=>{localStorage.setItem('palitra-cookie',b.dataset.cookie);cookie.remove()});
drawCart();
