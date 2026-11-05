/* PALITRA-CHECKOUT 13.10.2026: тестовый мост сайта с приложением удалён — обычная заявка идёт в штатный POST /api/orders. */
(function () {
  'use strict';
  const doc = document, CFG = window.PALITRA_CONFIG || {};
  const FAVORITES = 'palitra-draft-wishlist-v1';
  const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon = '<svg class="sf-icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 21S2 14.7 2 8.3a5.6 5.6 0 0 1 10-3.4 5.6 5.6 0 0 1 10 3.4C22 14.7 12 21 12 21Z"/></svg>';
  let session = { user: null, csrf: '' }, dataPromise;
  function readFavorites() {
    try { const v=JSON.parse(localStorage.getItem(FAVORITES)||'[]'); return Array.isArray(v)?[...new Set(v.filter(id=>typeof id==='string'&&ID.test(id)))].slice(0,100):[]; } catch (_) { return []; }
  }
  let favorites = readFavorites();
  // Authenticated favorites stay on the server; do not leak them to the next account on a shared browser.
  function saveFavorites() { try { if(session.user)localStorage.removeItem(FAVORITES);else localStorage.setItem(FAVORITES, JSON.stringify(favorites)); } catch (_) {} }
  async function api(path, method='GET', body) {
    const response = await fetch('/api/draft-account' + path, {
      method, credentials:'same-origin', headers:{'Content-Type':'application/json', ...(method==='GET'?{}:{'X-CSRF-Token':session.csrf})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})
    });
    let result; try { result=await response.json(); } catch (_) { throw new Error('Сервис личного кабинета пока недоступен.'); }
    if (!response.ok) throw new Error(result.message || 'Не удалось выполнить действие. Попробуйте позже.');
    return result;
  }
  function status(node, text, error=false) { if(node) {node.textContent=text; node.dataset.state=error?'error':'success';} }
  function count() {
    doc.querySelectorAll('[data-wishlist-count]').forEach(node=>{node.textContent=String(favorites.length);node.hidden=!favorites.length;});
    doc.querySelectorAll('[data-favorite-id]').forEach(button=>{
      const selected=favorites.includes(button.dataset.favoriteId); button.setAttribute('aria-pressed',String(selected));
      const title=button.dataset.favoriteTitle||'';button.setAttribute('aria-label',(selected?'Удалить из избранного: ':'В избранное: ')+title);
    });
  }
  function favoriteButtons(root=doc) {
    root.querySelectorAll('.product-card[data-id]').forEach(card=>{
      if(card.querySelector('[data-favorite-id]'))return;
      const media=card.querySelector('.product-media'); if(!media)return;
      const id=card.dataset.id;if(!ID.test(id))return;
      const button=doc.createElement('button');button.type='button';button.className='sf-wishlist-button';
      button.dataset.favoriteId=id;button.dataset.favoriteTitle=card.querySelector('h3')?.textContent||'';button.innerHTML=icon;
      media.append(button);
    }); count();
  }
  function getData() {
    if(!dataPromise)dataPromise=(async()=>{
      const api=window.PalitraPrice;if(!api)throw new Error('Каталог пока недоступен.');
      const raw=await api.load(['/api/price','/data/price.json']);if(!raw)throw new Error('Не удалось загрузить каталог.');
      const data=api.publicData?api.publicData(raw):raw;
      return (data.categories||[]).flatMap(cat=>(cat.items||[]).map(it=>({...it,category:cat.title})));
    })();return dataPromise;
  }
  async function miniCart() {
    const root=doc.querySelector('[data-mini-cart-items]'),totalNode=doc.querySelector('[data-mini-cart-total]');if(!root)return;
    try{
      let raw;try{raw=JSON.parse(localStorage.getItem('palitra-cart-v1')||'{}');}catch(_){raw={};}
      const lines=Array.isArray(raw.items)?raw.items.filter(i=>i&&ID.test(i.id)&&Number.isInteger(i.qty)&&i.qty>0&&i.qty<=20).slice(0,30):[];
      if(!lines.length){root.textContent='Корзина пуста';totalNode.textContent='Итого: 0 ₽';return;}
      const all=await getData(),index=new Map(all.map(i=>[i.id,i]));let total=0,unknown=0;
      root.innerHTML=lines.map(line=>{
        const item=index.get(line.id);if(!item){unknown++;return '<p>Позиция пока недоступна в каталоге</p>';}
        const normalized=String(item.price||'').replace(/\s/g,'').replace(/(?:₽|руб\.?|р\.?)$/i,'');
        const numeric=/^\d+(?:[.,]\d{1,2})?$/.test(normalized)?Number(normalized.replace(',','.')):null;
        if(numeric===null)unknown++;else total+=numeric*line.qty;
        return `<p class="sf-mini-line"><span>${esc(item.title)}</span><b>× ${line.qty}</b></p>`;
      }).join('');
      totalNode.textContent=(unknown?'Итого по известным ценам: ':'Итого: ')+new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(total)+' ₽';
    }catch(_){root.textContent='Откройте корзину, чтобы посмотреть товары.';totalNode.textContent='';}
  }
  function renderCards(items) { return items.map(it=>window.PalitraPrice.productCard(it,{extraClass:'card'})).join(''); }
  async function renderFavorites() {
    const root=doc.querySelector('[data-wishlist-items]');if(!root)return;
    try {
      const all=await getData(), shown=all.filter(it=>favorites.includes(it.id));root.innerHTML=renderCards(shown);
      doc.querySelector('[data-wishlist-empty]').hidden=!!shown.length;favoriteButtons(root);
      const unavailable=favorites.length-shown.length;
      status(doc.querySelector('[data-wishlist-status]'),unavailable?'Некоторые сохранённые товары пока не показываются в каталоге.':'');
    } catch(error) {status(doc.querySelector('[data-wishlist-status]'),error.message,true);}
  }
  // PALITRA-CHECKOUT 13.10.2026: охрана черновика снята — форму заявки обрабатывает штатный order.js.
  // На внутренних страницах ссылка заявки возвращает к форме главной.
  if(!doc.getElementById('zayavka'))doc.querySelectorAll('a[href="#zayavka"]').forEach(link=>{link.href='/#zayavka';});
  const searchToggle=doc.querySelector('[data-search-toggle]'),search=doc.querySelector('#sf-search');
  function setSearch(open){if(!search)return;search.hidden=!open;searchToggle?.setAttribute('aria-expanded',String(open));if(open)search.querySelector('input')?.focus();else searchToggle?.focus();}
  const desktopCatalog=matchMedia('(min-width:1280px) and (hover:hover) and (pointer:fine)');
  const catalogs=[...doc.querySelectorAll('.sf-catalog')];
  let megaCloseTimer;
  function setMega(root,open){
    clearTimeout(megaCloseTimer);
    root.classList.toggle('is-open',open);
    root.querySelector('[data-mega-toggle]')?.setAttribute('aria-expanded',String(open));
  }
  function closeMega(){clearTimeout(megaCloseTimer);catalogs.forEach(root=>setMega(root,false));}
  // Delay closes across the small gap between the navigation row and the panel.
  for(const root of catalogs){
    const panel=root.querySelector('.sf-mega'),button=root.querySelector('[data-mega-toggle]');
    root.addEventListener('pointerenter',event=>{
      if(desktopCatalog.matches&&event.pointerType==='mouse')setMega(root,true);
    });
    root.addEventListener('pointerleave',event=>{
      if(desktopCatalog.matches&&event.pointerType==='mouse'){
        clearTimeout(megaCloseTimer);megaCloseTimer=setTimeout(()=>setMega(root,false),180);
      }
    });
    panel?.addEventListener('pointerenter',()=>clearTimeout(megaCloseTimer));
    root.addEventListener('focusout',event=>{
      if(!root.contains(event.relatedTarget))setMega(root,false);
    });
    button?.addEventListener('keydown',event=>{
      if(event.key==='ArrowDown'){
        event.preventDefault();setMega(root,true);panel?.querySelector('a')?.focus();
      }
    });
  }
  desktopCatalog.addEventListener('change',closeMega);
  let favoritesPending=false;
  doc.addEventListener('click', async event=>{
    if(event.target.closest('[data-search-toggle]'))setSearch(search.hidden);
    if(event.target.closest('[data-search-close]'))setSearch(false);
    const mega=event.target.closest('[data-mega-toggle]');if(mega){
      // Mouse uses hover; touch and keyboard retain an explicit toggle.
      if(!desktopCatalog.matches||event.detail===0){
        const parent=mega.closest('.sf-catalog');setMega(parent,!parent.classList.contains('is-open'));
      }
    }
    else if(!event.target.closest('.sf-catalog'))closeMega();
    const favorite=event.target.closest('[data-favorite-id]');if(!favorite||favoritesPending)return;
    const id=favorite.dataset.favoriteId; if(!ID.test(id))return;
    const next=favorites.includes(id)?favorites.filter(v=>v!==id):[...favorites,id].slice(0,100);
    if(session.user){
      favoritesPending=true;favorite.disabled=true;
      try {await api('/wishlist','PUT',{ids:next});favorites=next;saveFavorites();count();await renderFavorites();}
      catch(error){status(doc.querySelector('[data-wishlist-status]'),error.message,true);favorite.title=error.message;}
      finally{favoritesPending=false;favorite.disabled=false;}
    } else {favorites=next;saveFavorites();count();await renderFavorites();}
  });
  doc.addEventListener('keydown',event=>{if(event.key==='Escape'){const owner=catalogs.find(root=>root.classList.contains('is-open')&&root.querySelector('.sf-mega')?.contains(doc.activeElement));closeMega();if(search&&!search.hidden)setSearch(false);else owner?.querySelector('[data-mega-toggle]')?.focus();}});
  doc.addEventListener('click',event=>{if(search&&!search.hidden&&!event.target.closest('.sf-search,[data-search-toggle]')){search.hidden=true;searchToggle?.setAttribute('aria-expanded','false');}});
  const ready=(async()=>{
    try {
      session=await api('/session');
      if(session.user){
        const remote=await api('/wishlist');
        const merged=[...new Set([...remote.ids,...favorites])].slice(0,100);
        if(merged.length!==remote.ids.length)await api('/wishlist','PUT',{ids:merged});
        favorites=merged;saveFavorites();
        doc.querySelectorAll('[data-account-link]').forEach(a=>{a.href='/account';a.setAttribute('aria-label','Мой аккаунт');});
      }
    } catch(_) {session={user:null,csrf:''};}
    count();await renderFavorites();
  })();
  for(const form of doc.querySelectorAll('[data-auth-form]'))form.addEventListener('submit',async event=>{
    event.preventDefault();if(form.dataset.pending)return;
    const node=form.querySelector('[data-auth-status]'),button=form.querySelector('button[type=submit]');
    form.dataset.pending='true';button.disabled=true;status(node,'Проверяем данные…');
    try {
      await ready;
      const body=Object.fromEntries(new FormData(form));body.consent=form.elements.consent?.checked===true;body.newsletter=body.newsletter==='yes';
      if(form.dataset.authForm==='register'&&body.password!==body.passwordConfirm)throw new Error('Пароли не совпадают.');
      const guestFavorites=readFavorites();
      session=await api('/'+form.dataset.authForm,'POST',body);
      const stored=await api('/wishlist');favorites=[...new Set([...stored.ids,...guestFavorites])].slice(0,100);
      if(favorites.length!==stored.ids.length)await api('/wishlist','PUT',{ids:favorites});saveFavorites();
      form.querySelectorAll('input[type=password]').forEach(input=>input.value='');
      // Only internal destinations are allowed; no return-URL redirects to third-party sites.
      const next=new URL(location.href).searchParams.get('next');
      const safe=next&&/^\/(?!\/)[a-z0-9_/?=&%-]*$/i.test(next)?next:'/account';location.assign(safe);
    }catch(error){status(node,error.message||'Сервис личного кабинета недоступен.',true);}
    finally{delete form.dataset.pending;button.disabled=false;}
  });
  if(location.pathname.replace(/\/$/,'')==='/account')ready.then(()=>{
    const container=doc.querySelector('[data-account-content]');if(!container)return;
    if(!session.user){container.innerHTML='<p>Войдите, чтобы открыть личный кабинет.</p><a class="button pill" href="/account/login">Войти</a>';return;}
    const u=session.user;
    container.innerHTML=`<section class="sf-box"><h2>Здравствуйте, ${esc(u.firstName)}</h2><p class="sf-authentication-status">Вы вошли в личный кабинет</p><p>${esc(u.email)}</p><div class="sf-account-actions"><a class="button pill" href="/wishlist">Избранное</a><a class="button pill" href="/cart">Корзина</a><button type="button" class="pill" data-logout>Выйти</button></div><h3>Мои данные</h3><form data-profile-form><label>Имя<input name="firstName" value="${esc(u.firstName)}" maxlength="80" required></label><label>Фамилия<input name="lastName" value="${esc(u.lastName)}" maxlength="80" required></label><label>Телефон<input name="phone" type="tel" value="${esc(u.phone)}" maxlength="32" required></label><label>Адрес<input name="address" value="${esc(u.address)}" maxlength="500" required></label><button type="submit" class="pill">Сохранить данные</button><p data-profile-status role="status"></p></form><h3>История заказов</h3><p>История заказов в личном кабинете пока не показывается. Менеджер свяжется с вами по каждой заявке.</p></section>`;
    const form=container.querySelector('[data-profile-form]');
    form.addEventListener('submit',async e=>{e.preventDefault();const b=form.querySelector('button');b.disabled=true;try{session.user=(await api('/profile','PUT',Object.fromEntries(new FormData(form)))).user;status(form.querySelector('[data-profile-status]'),'Данные сохранены.');}catch(error){status(form.querySelector('[data-profile-status]'),error.message,true);}finally{b.disabled=false;}});
    container.querySelector('[data-logout]').addEventListener('click',async e=>{e.target.disabled=true;try{await api('/logout','POST',{});try{localStorage.removeItem(FAVORITES);}catch(_){}location.assign('/account/login');}catch(error){e.target.disabled=false;status(form.querySelector('[data-profile-status]'),error.message,true);}});
  });
  if(doc.querySelector('[data-search-results]'))(async()=>{
    const q=(new URL(location.href).searchParams.get('q')||'').trim().slice(0,120),input=doc.querySelector('#page-query'),summary=doc.querySelector('[data-search-summary]');input.value=q;
    if(!q){summary.textContent='Введите название, цвет или состав набора.';return;}
    try{const words=q.toLocaleLowerCase('ru').split(/\s+/);const all=await getData();const found=all.filter(it=>words.every(word=>[it.title,it.desc,it.category].join(' ').toLocaleLowerCase('ru').includes(word)));summary.textContent=found.length?`Найдено товаров: ${found.length}`:'По вашему запросу ничего не найдено. Попробуйте другое название.';const root=doc.querySelector('[data-search-results]');root.innerHTML=renderCards(found);favoriteButtons(root);}catch(error){status(summary,error.message,true);}
  })();
  favoriteButtons();
  const catalog=doc.querySelector('[data-products]');if(catalog)new MutationObserver(()=>favoriteButtons(catalog)).observe(catalog,{childList:true});
  const preview=doc.querySelector('.sf-cart-trigger');preview?.addEventListener('pointerenter',miniCart);preview?.addEventListener('focusin',miniCart);
  if(location.pathname.replace(/\/$/,'')==='/cart'){doc.querySelector('.sf-page [data-cart-open]')?.click();if(location.hash==='#checkout')doc.querySelector('#checkout')?.scrollIntoView();}
})();

/* Palitra — контроллер фона рамки одиночного фото (PHOTO_FILL_20261013). Фрагмент для добавления в КОНЕЦ
   storefront.js (основа 225). НЕ ОПУБЛИКОВАН.

   Делает одно: на контейнере одиночного фото задаёт собственную CSS-переменную --palitra-frame-photo =
   url("<адрес уже загруженного img>"). Её читает готовый CSS 225 (псевдоэлемент рамки); сам CSS здесь не меняется.
   - Контейнеры и их прямое фото: .product-media > img, .cart-photo > img.cart-photo__img,
     .palitra-stories__open > img, .budget-card__media > img. Ровно один прямой img и ни одного другого img
     внутри; контейнер с .product-gallery__track (галерея) не трогается.
   - Переменная ставится только после фактической загрузки: img.complete && naturalWidth > 0 либо событие load
     с той же проверкой. Ленивое фото до загрузки фона не получает: CSS-фон не вызывает раннего скачивания.
   - Адрес — только currentSrc (иначе src) этого img, разобранный через document.baseURI: https любого домена или
     http того же origin, без логина/пароля. file/data/javascript/blob и прочее — переменная снимается.
     Новые адреса не создаются, сеть не используется, HTML/CSS не разбираются, innerHTML нет.
   - Смена src/srcset: переменная снимается сразу, новая — после загрузки нового кадра; error — снимается.
   - Меняются только --palitra-frame-photo через style.setProperty/removeProperty; размеры, классы и другие
     атрибуты не трогаются. Без window/document — ничего не делает. Повторное подключение — без второго запуска. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const win = window, doc = document;
  if (win.__palitraFrameController) return;
  if (!doc.documentElement || typeof doc.querySelectorAll !== 'function' || typeof win.MutationObserver !== 'function' ||
    typeof win.WeakMap !== 'function' || typeof win.URL !== 'function') return;
  try { Object.defineProperty(win, '__palitraFrameController', { value: Object.freeze({ version: 1 }) }); } catch (_) { return; }

  const PROP = '--palitra-frame-photo';
  const SPECS = [['.product-media', 'img'], ['.cart-photo', 'img.cart-photo__img'], ['.palitra-stories__open', 'img'], ['.budget-card__media', 'img']];
  const SELECTOR = SPECS.map(spec => spec[0]).join(',');
  const UNSAFE = /[\u0000-\u001f\u007f"\\]/;
  const BATCH = 400; // контейнеров за кадр; остаток — в следующем кадре
  const records = new WeakMap(); // img → { container, load, error }
  const applied = new WeakSet(); // контейнеры, где переменную поставили мы
  const pending = new Set();
  let frame = 0;
  const nextFrame = typeof win.requestAnimationFrame === 'function' ? fn => win.requestAnimationFrame(fn) : fn => win.setTimeout(fn, 16);

  const isElement = node => Boolean(node) && node.nodeType === 1;
  const isLoaded = img => img.complete === true && img.naturalWidth > 0;

  function specOf(container) {
    for (const spec of SPECS) if (container.matches(spec[0])) return spec;
    return null;
  }
  /* Целевое фото контейнера или null: ровно один прямой img нужного вида, других img нет, галереи нет. */
  function targetOf(container) {
    if (!isElement(container) || !container.isConnected) return null;
    const spec = specOf(container);
    if (!spec || container.querySelector('.product-gallery__track')) return null;
    if (container.getElementsByTagName('img').length !== 1) return null;
    let found = null;
    for (const child of container.children) {
      if (child.tagName !== 'IMG') continue;
      if (found || !child.matches(spec[1])) return null;
      found = child;
    }
    return found;
  }

  function safeUrl(img) {
    const raw = img.currentSrc || img.getAttribute('src') || '';
    if (!raw) return null;
    let url;
    try { url = new win.URL(raw, doc.baseURI); } catch (_) { return null; }
    const sameOrigin = win.location && url.origin === win.location.origin;
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && sameOrigin))) return null;
    if (url.username || url.password || UNSAFE.test(url.href)) return null;
    return url.href;
  }

  function clear(container) {
    if (!applied.has(container)) return;
    applied.delete(container);
    container.style.removeProperty(PROP);
  }
  function apply(container, img) {
    const url = safeUrl(img);
    if (!url) { clear(container); return; }
    const value = 'url(' + JSON.stringify(url) + ')';
    if (container.style.getPropertyValue(PROP) !== value) container.style.setProperty(PROP, value);
    applied.add(container);
  }

  function unbind(img) {
    const record = records.get(img);
    if (!record) return;
    img.removeEventListener('load', record.load);
    img.removeEventListener('error', record.error);
    records.delete(img);
  }
  /* Один набор слушателей на img; при переносе в другой контейнер меняется только привязка. */
  function bind(img, container) {
    const known = records.get(img);
    if (known) { known.container = container; return; }
    const record = { container };
    record.load = () => {
      const owner = record.container;
      if (targetOf(owner) === img && isLoaded(img)) apply(owner, img); else if (targetOf(owner) !== img) release(img);
    };
    record.error = () => { if (targetOf(record.container) === img) clear(record.container); };
    img.addEventListener('load', record.load);
    img.addEventListener('error', record.error);
    records.set(img, record);
  }
  /* img больше не цель своего контейнера: слушатели снимаются, фон контейнера пересчитывается. */
  function release(img) {
    const record = records.get(img);
    if (!record) return;
    const container = record.container;
    unbind(img);
    if (targetOf(container) !== img) sync(container);
  }

  function sync(container) {
    if (!isElement(container)) return;
    const img = targetOf(container);
    for (const child of container.children) if (child !== img && records.has(child)) unbind(child);
    if (!img) { clear(container); return; }
    bind(img, container);
    if (isLoaded(img)) apply(container, img); else clear(container); // ленивое фото: ждём load, фон не ставим
  }

  function queue(container) {
    if (!isElement(container)) return;
    pending.add(container);
    if (!frame) frame = nextFrame(flush);
  }
  function flush() {
    frame = 0;
    let n = 0;
    for (const container of pending) {
      pending.delete(container);
      sync(container);
      if (++n >= BATCH) break;
    }
    if (pending.size && !frame) frame = nextFrame(flush);
  }

  const closestContainer = node => (isElement(node) ? node.closest(SELECTOR) : node && node.parentElement ? node.parentElement.closest(SELECTOR) : null);
  /* Только добавленный узел и его поддерево, а не весь документ. */
  function queueSubtree(node) {
    if (!isElement(node)) return;
    if (node.matches(SELECTOR)) queue(node);
    for (const inner of node.querySelectorAll(SELECTOR)) queue(inner);
  }
  /* Удалённое или перенесённое поддерево. Отсоединённые контейнеры теряют свой фон. Фото, которое больше не цель
     своего прежнего контейнера, теряет слушатели, а прежний контейнер пересчитывается. Новое место узла
     обрабатывается как добавленное. */
  function forgetSubtree(node) {
    if (!isElement(node)) return;
    if (!node.isConnected) {
      const containers = node.matches(SELECTOR) ? [node, ...node.querySelectorAll(SELECTOR)] : [...node.querySelectorAll(SELECTOR)];
      for (const container of containers) { clear(container); pending.delete(container); }
    }
    const imgs = node.tagName === 'IMG' ? [node] : [...node.getElementsByTagName('img')];
    for (const img of imgs) {
      const record = records.get(img);
      if (!record || (img.isConnected && targetOf(record.container) === img)) continue;
      const owner = record.container;
      unbind(img);
      if (owner && owner.isConnected) queue(owner);
    }
  }

  const observer = new win.MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        const img = mutation.target;
        if (!isElement(img) || img.tagName !== 'IMG') continue;
        const container = img.parentElement && img.parentElement.matches(SELECTOR) ? img.parentElement : null;
        const record = records.get(img);
        // Старый кадр больше не показывается: фон снимается сразу, новый — только после его загрузки.
        if (record) clear(record.container);
        if (container) {
          clear(container);
          queue(container); // проверка в следующем кадре: если новый кадр уже загружен (кеш, тот же кандидат srcset)
        }
        continue;
      }
      for (const node of mutation.removedNodes) forgetSubtree(node);
      for (const node of mutation.addedNodes) queueSubtree(node);
      const around = closestContainer(mutation.target);
      if (around) queue(around);
    }
  });

  function start() {
    observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] });
    for (const container of doc.querySelectorAll(SELECTOR)) queue(container); // один раз при запуске
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
