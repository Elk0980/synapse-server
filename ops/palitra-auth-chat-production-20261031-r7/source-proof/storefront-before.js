/* PALITRA-CHECKOUT 13.10.2026: тестовый мост сайта с приложением удалён — обычная заявка идёт в штатный POST /api/orders. */
(function () {
  'use strict';
  // Existing site-wide entry also covers old pages. Failure never blocks browsing or checkout.
  if (!window.PalitraAttribution && document.head && !document.querySelector('script[data-palitra-attribution]')) {
    const trackingScript = document.createElement('script');
    trackingScript.src = '/assets/palitra-attribution.js?v=20261021-orders-unified-r1';
    trackingScript.defer = true; trackingScript.dataset.palitraAttribution = '1'; document.head.append(trackingScript);
  }
  const doc = document, CFG = window.PALITRA_CONFIG || {};
  const FAVORITES = 'palitra-draft-wishlist-v1';
  const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon = '<svg class="sf-icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 21S2 14.7 2 8.3a5.6 5.6 0 0 1 10-3.4 5.6 5.6 0 0 1 10 3.4C22 14.7 12 21 12 21Z"/></svg>';
  let session = { user: null, csrf: '' }, dataPromise;
  /* PALITRA_ACCOUNT_VIEW_BEGIN: readonly presentation data; never an authorization grant. */
  const accountView = (() => {
    const listeners = new Set();
    let generation = 0, activeMutation = 0, channel = null;
    let snapshot = Object.freeze({ generation, status: 'loading', reason: 'initial', user: null });
    const sanitize = value => {
      if (value === null) return null;
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string'
        || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id) || typeof value.firstName !== 'string' || value.firstName.length > 80
        || typeof value.phone !== 'string' || value.phone.length > 32 || typeof value.address !== 'string' || value.address.length > 500) return undefined;
      return Object.freeze({ id: value.id, firstName: value.firstName, phone: value.phone, address: value.address });
    };
    const publish = (status, reason, user = null) => {
      snapshot = Object.freeze({ generation, status, reason, user });
      for (const listener of [...listeners]) { try { listener(snapshot); } catch (_) { /* a consumer cannot stop auth */ } }
    };
    const invalidate = reason => { activeMutation = 0; generation++; publish('unavailable', reason); };
    const ping = () => { try { channel?.postMessage({ version: 1, type: 'invalidate' }); } catch (_) {} };
    const api = Object.freeze({ version: 1, purpose: 'checkout-prefill',
      getSnapshot: () => snapshot,
      subscribe(listener) { if (typeof listener !== 'function') return () => {}; listeners.add(listener); return () => listeners.delete(listener); }
    });
    if (Object.prototype.hasOwnProperty.call(window, 'PalitraAccountView')) {
      // Unknown owner/collision: do not overwrite a global or claim it is a verified publisher.
      return { readStart: () => null, authStart: () => null, finish() {}, fail() {}, invalidate() {} };
    }
    Object.defineProperty(window, 'PalitraAccountView', { value: api, writable: false, configurable: false });
    try {
      if (typeof window.BroadcastChannel === 'function') {
        channel = new window.BroadcastChannel('palitra-account-invalidation-v1');
        channel.addEventListener('message', event => {
          if (!event.data || event.data.version !== 1 || event.data.type !== 'invalidate') return;
          invalidate('external-invalidate');
          window.queueMicrotask(() => refreshMyOrdersAccount());
        });
      }
    } catch (_) { channel = null; }
    window.dispatchEvent(new window.Event('palitra:account-view-ready'));
    return {
      readStart() {
        if (activeMutation) return null;
        generation++; publish('loading', 'session-loading'); return { generation, kind: 'read' };
      },
      authStart(reason = 'auth-mutation-start') {
        generation++; activeMutation = generation; publish('changing', reason); ping();
        return { generation, kind: 'auth' };
      },
      finish(ticket, value, reason = 'snapshot-ready') {
        if (!ticket || ticket.generation !== generation || ticket.kind === 'auth' && activeMutation !== ticket.generation) return;
        if (ticket.kind === 'auth') activeMutation = 0;
        const user = sanitize(value);
        if (user === undefined) publish('unavailable', 'invalid-snapshot');
        else publish('ready', reason, user);
        if (ticket.kind === 'auth') ping();
      },
      fail(ticket) {
        if (!ticket || ticket.generation !== generation || snapshot.status === 'ready') return;
        if (ticket.kind === 'auth') activeMutation = 0;
        publish('unavailable', 'session-unavailable');
        if (ticket.kind === 'auth') ping();
      },
      invalidate
    };
  })();
  /* PALITRA_ACCOUNT_VIEW_END */

  function readFavorites() {
    try { const v=JSON.parse(localStorage.getItem(FAVORITES)||'[]'); return Array.isArray(v)?[...new Set(v.filter(id=>typeof id==='string'&&ID.test(id)))].slice(0,100):[]; } catch (_) { return []; }
  }
  let favorites = readFavorites();
  // Authenticated favorites stay on the server; do not leak them to the next account on a shared browser.
  function saveFavorites() { try { if(session.user)localStorage.removeItem(FAVORITES);else localStorage.setItem(FAVORITES, JSON.stringify(favorites)); } catch (_) {} }
  async function api(path, method='GET', body) {
    const authMutation = method === 'POST' && ['/register','/login','/logout'].includes(path);
    const accountRead = method === 'GET' && path === '/session';
    const profileMutation = method === 'PUT' && path === '/profile';
    const viewTicket = authMutation || profileMutation ? accountView.authStart(profileMutation ? 'profile-mutation-start' : 'auth-mutation-start') : accountRead ? accountView.readStart() : null;
    try {
    const response = await fetch('/api/draft-account' + path, {
      method, credentials:'same-origin', headers:{'Content-Type':'application/json', ...(method==='GET'?{}:{'X-CSRF-Token':session.csrf})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})
    });
    let result; try { result=await response.json(); } catch (_) { throw new Error('Сервис личного кабинета пока недоступен.'); }
    if (!response.ok) throw new Error(result.message || 'Не удалось выполнить действие. Попробуйте позже.');
    if (viewTicket) accountView.finish(viewTicket, path === '/logout' ? null : result.user, path === '/logout' ? 'logout' : 'snapshot-ready');
    return result;
    } catch (error) { accountView.fail(viewTicket); throw error; }
  }
  // Navigation hint only. Orders and messages remain protected by the app's server session/grants.
  const MY_ORDERS_HISTORY = 'palitra-chat-last-v1', MY_ORDERS_HINT = 'palitra-has-conversation-v1';
  const MY_ORDERS_URL = '/love-app/shop.html#K_CURRENT_ORDER_CHAT';
  let myOrdersLoggedIn = false, myOrdersAccountEpoch = 0, myOrdersAccountRead = null;
  let myOrdersHasHistory = false, myOrdersHistoryEpoch = 0, myOrdersHistoryRead = null;
  function myOrdersHistoryHint() {
    let history = false;
    try {
      const raw = window.sessionStorage.getItem(MY_ORDERS_HISTORY);
      if (typeof raw === 'string' && raw.length <= 256) {
        const value = JSON.parse(raw);
        history = Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === 'orderId,threadId'
          && Number.isSafeInteger(value.threadId) && value.threadId > 0
          && (value.orderId === null || Number.isSafeInteger(value.orderId) && value.orderId > 0));
      }
    } catch (_) { /* Storage is optional; it never proves identity. */ }
    if (history) { try { window.localStorage.setItem(MY_ORDERS_HINT, '1'); } catch (_) {} return true; }
    try { return window.localStorage.getItem(MY_ORDERS_HINT) === '1'; } catch (_) { return false; }
  }
  function refreshMyOrdersLink() {
    const navigation = doc.getElementById('mobile-navigation') || doc.querySelector('.sf-links');
    if (!navigation) return;
    let link = navigation.querySelector('[data-my-orders-link]');
    if (!link) {
      link = doc.createElement('a'); link.setAttribute('data-my-orders-link', ''); link.textContent = 'Мои заказы';
      const close = navigation.querySelector('.menu-close');
      navigation.insertBefore(link, close && close.parentNode === navigation ? close.nextSibling : navigation.firstChild);
    }
    link.href = MY_ORDERS_URL;
    const history = myOrdersHistoryHint(), visible = myOrdersLoggedIn || myOrdersHasHistory || history;
    link.hidden = !visible; link.style.display = visible ? '' : 'none';
  }
  function cancelMyOrdersAccountRead() {
    myOrdersAccountEpoch += 1;
    if (myOrdersAccountRead) { myOrdersAccountRead.controller.abort(); window.clearTimeout(myOrdersAccountRead.timer); myOrdersAccountRead = null; }
  }
  function cancelMyOrdersHistoryRead() {
    myOrdersHistoryEpoch += 1;
    if (myOrdersHistoryRead) { myOrdersHistoryRead.controller.abort(); window.clearTimeout(myOrdersHistoryRead.timer); myOrdersHistoryRead = null; }
  }
  function refreshMyOrdersHistory() {
    if (doc.hidden || myOrdersHistoryRead) return;
    const controller = new AbortController(), pending = { controller, epoch: ++myOrdersHistoryEpoch };
    myOrdersHistoryRead = pending;
    pending.timer = window.setTimeout(() => controller.abort(), 8000);
    const live = () => myOrdersHistoryRead === pending && myOrdersHistoryEpoch === pending.epoch && !controller.signal.aborted;
    (async () => {
      try {
        // This read never bootstraps a chat or grants access. The destination rechecks its own server scope.
        const response = await fetch('/api/customer-chat/history-status', { method:'GET', credentials:'same-origin', cache:'no-store', redirect:'error', signal:controller.signal, headers:{Accept:'application/json'} });
        if (!live()) return;
        if (response.status === 401 || response.status === 403) { myOrdersHasHistory = false; refreshMyOrdersLink(); return; }
        if (response.status !== 200) return;
        const value = await response.json();
        if (!live() || !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'hasHistory,ok' || value.ok !== true || typeof value.hasHistory !== 'boolean') return;
        myOrdersHasHistory = value.hasHistory;
        if (myOrdersHasHistory) { try { window.localStorage.setItem(MY_ORDERS_HINT, '1'); } catch (_) { /* Navigation remains available for this page. */ } }
        refreshMyOrdersLink();
      } catch (_) { /* Old servers, offline and blocked storage do not erase a legitimate navigation hint. */ }
      finally { window.clearTimeout(pending.timer); if (myOrdersHistoryRead === pending) myOrdersHistoryRead = null; }
    })();
  }
  function acceptMyOrdersLogin(loggedIn) {
    cancelMyOrdersAccountRead(); cancelMyOrdersHistoryRead(); myOrdersHasHistory = false; myOrdersLoggedIn = loggedIn === true; refreshMyOrdersLink(); refreshMyOrdersHistory();
  }
  function refreshMyOrdersAccount() {
    refreshMyOrdersLink(); refreshMyOrdersHistory();
    if (doc.hidden || myOrdersAccountRead) return;
    const controller = new AbortController(), pending = { controller, epoch: ++myOrdersAccountEpoch };
    myOrdersAccountRead = pending;
    const viewTicket = accountView.readStart();
    pending.timer = window.setTimeout(() => controller.abort(), 8000);
    const live = () => myOrdersAccountRead === pending && myOrdersAccountEpoch === pending.epoch && !controller.signal.aborted;
    (async () => {
      try {
        const response = await fetch('/api/draft-account/session', { method:'GET', credentials:'same-origin', cache:'no-store', redirect:'error', signal:controller.signal, headers:{Accept:'application/json'} });
        if (!live()) return;
        if (response.status === 401 || response.status === 403) { accountView.fail(viewTicket); myOrdersLoggedIn = false; refreshMyOrdersLink(); return; }
        const value = await response.json();
        if (live() && response.status === 200 && value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'user')
          && (value.user === null || typeof value.user === 'object' && !Array.isArray(value.user))) {
          accountView.finish(viewTicket, value.user);
          const shown = window.PalitraAccountView?.getSnapshot?.();
          if (viewTicket && shown?.generation === viewTicket.generation && shown.status === 'ready') session = value;
          myOrdersLoggedIn = Boolean(value.user); refreshMyOrdersLink();
        }
      } catch (_) { /* A network error does not grant access or replace a confirmed navigation hint. */ }
      finally { accountView.fail(viewTicket); window.clearTimeout(pending.timer); if (myOrdersAccountRead === pending) myOrdersAccountRead = null; }
    })();
  }
  refreshMyOrdersLink(); refreshMyOrdersHistory();
  window.addEventListener('storage', () => { refreshMyOrdersLink(); refreshMyOrdersAccount(); });
  window.addEventListener('pageshow', refreshMyOrdersAccount);
  window.addEventListener('focus', refreshMyOrdersAccount);
  window.addEventListener('pagehide', () => { accountView.invalidate('pagehide'); cancelMyOrdersAccountRead(); cancelMyOrdersHistoryRead(); });
  doc.addEventListener('visibilitychange', () => { if (doc.hidden) { accountView.invalidate('hidden'); cancelMyOrdersAccountRead(); cancelMyOrdersHistoryRead(); } else refreshMyOrdersAccount(); });
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
      totalNode.textContent='Итого: '+new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(total)+' ₽';
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
  const myOrdersInitialAccountEpoch = myOrdersAccountEpoch;
  const ready=(async()=>{
    try {
      session=await api('/session');
      if (myOrdersInitialAccountEpoch === myOrdersAccountEpoch) { myOrdersLoggedIn = Boolean(session && session.user); refreshMyOrdersLink(); }
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
  // One exact reviewed app entry; other return paths keep the existing restrictive policy.
  function safeAuthReturn(value) {
    if (value === '/love-app/shop.html') return value;
    return typeof value === 'string' && /^\/(?!\/)[a-z0-9_/?=&%-]*$/i.test(value) ? value : '/account';
  }
  const requestedAuthReturn = new URL(location.href).searchParams.get('next');
  if (requestedAuthReturn === '/love-app/shop.html') {
    for (const link of doc.querySelectorAll('a[href="/account/login"],a[href="/account/register"]')) {
      const destination = new URL(link.getAttribute('href'), location.origin);
      destination.searchParams.set('next', requestedAuthReturn);
      link.setAttribute('href', destination.pathname + destination.search);
    }
  }
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
      acceptMyOrdersLogin(Boolean(session && session.user));
      const stored=await api('/wishlist');favorites=[...new Set([...stored.ids,...guestFavorites])].slice(0,100);
      if(favorites.length!==stored.ids.length)await api('/wishlist','PUT',{ids:favorites});saveFavorites();
      form.querySelectorAll('input[type=password]').forEach(input=>input.value='');
      // Only internal destinations are allowed; no return-URL redirects to third-party sites.
      const next=new URL(location.href).searchParams.get('next');
      location.assign(safeAuthReturn(next));
    }catch(error){status(node,error.message||'Сервис личного кабинета недоступен.',true);}
    finally{delete form.dataset.pending;button.disabled=false;}
  });
  /* PALITRA_PROFILE_SESSION_PANEL_BEGIN */
  function bindProfileSessionPanel(container, userId) {
    const view = window.PalitraAccountView;
    let current = false, dirty = false;
    const knownId = typeof userId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(userId);
    const previousDisplay = [container.style.getPropertyValue('display'), container.style.getPropertyPriority('display')];
    const notice = doc.createElement('section');
    notice.className = 'sf-box sf-account-session-notice';
    notice.setAttribute('role', 'status');
    const message = doc.createElement('p');
    const retry = doc.createElement('button');
    retry.type = 'button'; retry.className = 'pill'; retry.textContent = 'Проверить вход';
    const login = doc.createElement('a');
    login.className = 'button pill'; login.href = '/account/login?next=%2Faccount';
    login.target = '_blank'; login.rel = 'noopener'; login.textContent = 'Войти снова';
    const reload = doc.createElement('button');
    reload.type = 'button'; reload.className = 'pill'; reload.textContent = 'Открыть текущий аккаунт';
    notice.append(message, retry, login, reload); container.before(notice);
    const hide = (element, hidden) => {
      element.hidden = hidden;
      if (hidden) element.style.setProperty('display', 'none', 'important');
      else element.style.removeProperty('display');
    };
    const render = snapshot => {
      current = knownId && snapshot?.status === 'ready' && snapshot.user?.id === userId;
      hide(container, !current); container.inert = !current;
      if (current) {
        container.removeAttribute('aria-hidden');
        if (previousDisplay[0]) container.style.setProperty('display', ...previousDisplay);
      } else container.setAttribute('aria-hidden', 'true');
      hide(notice, current);
      if (current) return;
      const loading = snapshot?.status === 'loading' || snapshot?.status === 'changing';
      const other = snapshot?.status === 'ready' && Boolean(snapshot.user);
      const signedOut = snapshot?.status === 'ready' && !snapshot.user;
      message.textContent = loading ? 'Проверяем вход. Несохранённые изменения остаются в этой вкладке.'
        : other ? 'Аккаунт изменился. Данные прежнего профиля скрыты; его несохранённый ввод не переносится в другой аккаунт.'
        : signedOut ? 'Вы вышли из аккаунта. Несохранённые изменения остаются в этой вкладке. После повторного входа в тот же аккаунт вернитесь сюда.'
        : 'Вход пока не подтверждён. Данные профиля скрыты, несохранённые изменения остаются в этой вкладке.';
      retry.disabled = loading; hide(login, loading || other); hide(reload, !other);
    };
    container.addEventListener('input', () => { dirty = true; });
    container.addEventListener('change', () => { dirty = true; });
    retry.addEventListener('click', () => { if (!retry.disabled) refreshMyOrdersAccount(); });
    reload.addEventListener('click', () => {
      if (dirty && !window.confirm('Открыть текущий аккаунт? Несохранённые изменения прежнего профиля будут потеряны.')) return;
      dirty = false; window.location.reload();
    });
    window.addEventListener('beforeunload', event => {
      if (dirty) { event.preventDefault(); event.returnValue = ''; }
    });
    if (view?.version === 1 && typeof view.subscribe === 'function' && typeof view.getSnapshot === 'function') {
      view.subscribe(render); render(view.getSnapshot());
    } else render(null);
    return { isCurrent: () => current, markSaved() { dirty = false; } };
  }
  /* PALITRA_PROFILE_SESSION_PANEL_END */

  if(location.pathname.replace(/\/$/,'')==='/account')ready.then(()=>{
    const container=doc.querySelector('[data-account-content]');if(!container)return;
    if(!session.user){container.innerHTML='<p>Войдите, чтобы открыть личный кабинет.</p><a class="button pill" href="/account/login">Войти</a>';return;}
    const u=session.user;
    container.innerHTML=`<section class="sf-box"><h2>Здравствуйте, ${esc(u.firstName)}</h2><p class="sf-authentication-status">Вы вошли в личный кабинет</p><p>${esc(u.email)}</p><div class="sf-account-actions"><a class="button pill" href="/wishlist">Избранное</a><a class="button pill" href="/cart">Корзина</a><button type="button" class="pill" data-logout>Выйти</button></div><h3>Мои данные</h3><form data-profile-form><label>Имя<input name="firstName" type="text" autocomplete="given-name" value="${esc(u.firstName)}" maxlength="80" required></label><label>Фамилия (необязательно)<input name="lastName" type="text" autocomplete="family-name" value="${esc(u.lastName)}" maxlength="80"></label><label>Телефон<input name="phone" type="tel" autocomplete="tel" value="${esc(u.phone)}" maxlength="32" required></label><label>Адрес (необязательно)<input name="address" type="text" autocomplete="street-address" value="${esc(u.address)}" maxlength="500"></label><button type="submit" class="pill">Сохранить данные</button><p data-profile-status role="status"></p></form><h3>Мои заказы</h3><a class="button pill" href="/love-app/shop.html#K_CURRENT_ORDER_CHAT">Открыть заказы и переписку</a></section>`;
    const profileUserId=session.user.id, profilePanel=bindProfileSessionPanel(container,profileUserId);
    const form=container.querySelector('[data-profile-form]');
    form.addEventListener('submit',async e=>{e.preventDefault();if(!profilePanel.isCurrent())return;const b=form.querySelector('button');b.disabled=true;try{const saved=await api('/profile','PUT',Object.fromEntries(new FormData(form)));if(!profilePanel.isCurrent()||saved.user?.id!==profileUserId)throw new Error('Вход изменился. Сохранение могло завершиться; проверьте данные после входа, прежде чем повторять.');session.user=saved.user;profilePanel.markSaved();status(form.querySelector('[data-profile-status]'),'Данные сохранены.');}catch(error){status(form.querySelector('[data-profile-status]'),error.message,true);}finally{b.disabled=false;}});
    container.querySelector('[data-logout]').addEventListener('click',async e=>{if(!profilePanel.isCurrent())return;e.target.disabled=true;try{await api('/logout','POST',{});acceptMyOrdersLogin(false);try{localStorage.removeItem(FAVORITES);}catch(_){}location.assign('/account/login');}catch(error){e.target.disabled=false;status(form.querySelector('[data-profile-status]'),error.message,true);}});
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


/* PALITRA-SITE-CHAT-WIDGET: lazy same-origin view; close/expand never replace its document. */
(function () {
  'use strict';
  const doc = document;
  function mount() {
    if (doc.getElementById('palitra-site-chat') || /^\/(?:chat(?:\/|$)|love-app(?:\/|$))/.test(location.pathname)) return;
    const element = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; };
    const sheet = element('link'); sheet.rel = 'stylesheet'; sheet.href = '/assets/palitra-chat-widget.css'; doc.head.append(sheet);
    const launch = element('button', 'pw-launch'); launch.type = 'button'; launch.id = 'palitra-site-chat'; launch.setAttribute('aria-label', 'Открыть чат с Palitra Love'); launch.setAttribute('aria-expanded', 'false'); launch.setAttribute('aria-controls', 'pw-panel');
    launch.title = 'Открыть чат';
    Object.assign(launch.style, { width:'56px', height:'56px', minWidth:'56px', padding:'0' });
    const chatIcon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chatIcon.setAttribute('viewBox', '0 0 24 24'); chatIcon.setAttribute('fill', 'none'); chatIcon.setAttribute('stroke', 'currentColor'); chatIcon.setAttribute('stroke-width', '1.8'); chatIcon.setAttribute('stroke-linecap', 'round'); chatIcon.setAttribute('stroke-linejoin', 'round'); chatIcon.setAttribute('aria-hidden', 'true'); chatIcon.setAttribute('focusable', 'false');
    const chatOutline = doc.createElementNS('http://www.w3.org/2000/svg', 'path'); chatOutline.setAttribute('d', 'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z');
    const chatLines = doc.createElementNS('http://www.w3.org/2000/svg', 'path'); chatLines.setAttribute('d', 'M8 9h8M8 13h5');
    chatIcon.append(chatOutline, chatLines); launch.append(chatIcon);
    const panel = element('section', 'pw-panel'); panel.id = 'pw-panel'; panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Чат с Palitra Love');
    const head = element('header', 'pw-head'), avatar = element('span', 'pw-avatar'), image = element('img');
    image.src = 'https://synapse.synapsebusiness.ru/content/publishing-assets/palitra-love/ec50ad5bcef0a3e0521fa0238cd68628.webp'; image.alt = ''; image.setAttribute('referrerpolicy', 'no-referrer'); image.loading = 'lazy'; avatar.setAttribute('aria-hidden', 'true'); avatar.append(image);
    const name = element('strong', 'pw-name', 'Palitra Love'), expand = element('button', 'pw-control', '⛶'), close = element('button', 'pw-control', '×');
    expand.type = close.type = 'button'; expand.setAttribute('aria-label', 'Развернуть чат'); expand.setAttribute('aria-pressed', 'false'); close.setAttribute('aria-label', 'Закрыть чат'); head.append(avatar, name, expand, close); panel.append(head); doc.body.append(launch, panel);
    const invitationBox = element('aside', 'pw-invitation'), invitationOpen = element('button', 'pw-invitation__open'), invitationClose = element('button', 'pw-invitation__close', '×');
    invitationBox.id = 'pw-invitation'; invitationBox.hidden = true; invitationBox.setAttribute('aria-label', 'Приглашение к диалогу');
    invitationOpen.type = invitationClose.type = 'button'; invitationClose.setAttribute('aria-label', 'Закрыть приглашение'); invitationBox.append(invitationOpen, invitationClose); doc.body.append(invitationBox);
    const invitationKey = 'palitra-site-chat-invitation-stopped-v1';
    let invitationStopped = false, invitationTimer = null;
    try { invitationStopped = window.sessionStorage.getItem(invitationKey) === '1'; } catch (_) { /* Per-visit memory still works when storage is unavailable. */ }
    let frame = null, appearance = { width: 360, height: 520, radius: 28, accent: '#69723e' }, settingsRevision = 0, settingsLoading = false, settingsVerified = false;
    let invitation = { enabled: true, text: 'Нужна помощь с выбором шаров? Напишите нам.', delaySeconds: 15 };
    const clearInvitation = () => { if (invitationTimer !== null) clearTimeout(invitationTimer); invitationTimer = null; invitationBox.hidden = true; };
    const stopInvitation = () => { invitationStopped = true; clearInvitation(); try { window.sessionStorage.setItem(invitationKey, '1'); } catch (_) { /* Memory remains authoritative for this page. */ } };
    const scheduleInvitation = () => {
      clearInvitation();
      if (!settingsVerified || invitationStopped || !invitation.enabled || !panel.hidden || doc.visibilityState !== 'visible') return;
      invitationTimer = setTimeout(() => {
        invitationTimer = null;
        if (invitationStopped || !invitation.enabled || !panel.hidden || doc.visibilityState !== 'visible') return;
        invitationOpen.textContent = invitation.text; invitationBox.hidden = false;
      }, invitation.delaySeconds * 1000);
    };
    const fit = () => {
      const viewport = window.visualViewport, height = viewport && viewport.height > 0 ? viewport.height : window.innerHeight, top = viewport && Number.isFinite(viewport.offsetTop) ? Math.max(0, viewport.offsetTop) : 0;
      const ownHeight = Math.min(appearance.height, Math.max(0, height - 24));
      panel.style.setProperty('--pw-top', `${top + height - ownHeight - 12}px`); panel.style.setProperty('--pw-height', `${ownHeight}px`);
      panel.style.setProperty('--pw-full-top', `${top}px`); panel.style.setProperty('--pw-full-height', `${height}px`);
    };
    const refreshSettings = async () => {
      if (settingsLoading) return;
      settingsLoading = true;
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch('/api/customer-chat/widget-settings', { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!response.ok) return;
        const data = await response.json(), object = value => value && typeof value === 'object' && !Array.isArray(value);
        if (!object(data) || data.ok !== true || !object(data.settings)) return;
        const value = data.settings, contact = value.contact, next = value.appearance, nextInvitation = value.invitation;
        const bounded = (number, min, max) => Number.isInteger(number) && number >= min && number <= max;
        if (!Number.isSafeInteger(value.revision) || value.revision < settingsRevision || typeof value.welcomeText !== 'string' || value.welcomeText.length > 1200
          || !object(contact) || typeof contact.enabled !== 'boolean' || typeof contact.text !== 'string' || contact.text.length > 300 || contact.enabled && !contact.text.trim()
          || !object(next) || !bounded(next.width, 280, 440) || !bounded(next.height, 360, 680) || !bounded(next.radius, 12, 40)
          || typeof next.accent !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(next.accent)
          || !object(nextInvitation) || typeof nextInvitation.enabled !== 'boolean' || typeof nextInvitation.text !== 'string' || nextInvitation.text.length > 300 || nextInvitation.enabled && !nextInvitation.text.trim()
          || !bounded(nextInvitation.delaySeconds, 0, 3600)) return;
        const invitationChanged = !settingsVerified || value.revision !== settingsRevision || nextInvitation.enabled !== invitation.enabled || nextInvitation.text !== invitation.text || nextInvitation.delaySeconds !== invitation.delaySeconds;
        settingsRevision = value.revision;
        settingsVerified = true;
        appearance = { width: next.width, height: next.height, radius: next.radius, accent: next.accent };
        invitation = { enabled: nextInvitation.enabled, text: nextInvitation.text, delaySeconds: nextInvitation.delaySeconds };
        panel.style.setProperty('--pw-width', `${appearance.width}px`); panel.style.setProperty('--pw-radius', `${appearance.radius}px`);
        panel.style.setProperty('--pw-accent', appearance.accent); launch.style.setProperty('--pw-accent', appearance.accent); invitationBox.style.setProperty('--pw-accent', appearance.accent);
        fit();
        if (invitationChanged) scheduleInvitation();
      } catch (_) { /* Defaults/last valid appearance stay available even while public settings are offline. */ }
      finally { clearTimeout(timer); settingsLoading = false; }
    };
    const hide = () => { panel.hidden = true; launch.hidden = false; launch.setAttribute('aria-expanded', 'false'); launch.focus(); };
    const escape = event => { if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); hide(); } };
    launch.addEventListener('click', () => {
      stopInvitation();
      if (!frame) {
        frame = element('iframe', 'pw-frame'); frame.title = 'Переписка с Palitra Love'; frame.src = '/chat/widget'; frame.setAttribute('referrerpolicy', 'same-origin');
        frame.addEventListener('load', () => { try { if (frame.contentDocument) frame.contentDocument.addEventListener('keydown', escape); } catch (_) { /* Only the fixed same-origin page is used. */ } }); panel.append(frame);
      }
      panel.hidden = false; launch.hidden = true; launch.setAttribute('aria-expanded', 'true'); fit(); close.focus(); refreshSettings();
    });
    close.addEventListener('click', hide);
    invitationOpen.addEventListener('click', () => launch.click()); invitationClose.addEventListener('click', () => { stopInvitation(); launch.focus(); });
    expand.addEventListener('click', () => { const active = panel.classList.toggle('is-expanded'); expand.setAttribute('aria-pressed', String(active)); expand.setAttribute('aria-label', active ? 'Свернуть чат' : 'Развернуть чат'); fit(); });
    doc.addEventListener('keydown', escape); window.addEventListener('resize', fit, { passive: true });
    if (window.visualViewport) { window.visualViewport.addEventListener('resize', fit, { passive: true }); window.visualViewport.addEventListener('scroll', fit, { passive: true }); }
    fit();
    scheduleInvitation();
    refreshSettings();
    setInterval(() => { if (doc.visibilityState === 'visible') refreshSettings(); }, 60000);
    doc.addEventListener('visibilitychange', () => { scheduleInvitation(); if (doc.visibilityState === 'visible') refreshSettings(); });
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
}());

/* PALITRA_CATEGORY_NAV_20261022: public menu follows the current shared catalog; no account or cart changes. */
(() => {
  'use strict';
  let running = false;
  async function sync() {
    if (running || document.hidden) return;
    const panels = [...document.querySelectorAll('.sf-mega')];
    if (!panels.length) return;
    running = true;
    try {
      const response = await fetch('/api/price', {credentials:'omit',cache:'no-store',headers:{Accept:'application/json'}});
      if (!response.ok) return;
      const data = await response.json(), catalog = data.publicCatalog || {};
      const sections = new Set((data.categories || []).map(section => section.id));
      const custom = (Array.isArray(catalog.categories) ? catalog.categories : []).filter(category => category
        && /^custom-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(category.key) && typeof category.title === 'string'
        && category.title.trim() && category.title.length <= 80 && Array.isArray(category.source)
        && category.source.length && category.source.every(id => sections.has(id)));
      for (const panel of panels) {
        const links = new Map();
        for (const a of panel.querySelectorAll('a[href]')) {
          const key = new URL(a.getAttribute('href'), location.origin).searchParams.get('cat');
          if (key) links.set(key,a);
        }
        for (const [key,a] of links) if (key.startsWith('custom-') && !custom.some(category => category.key === key)) {a.remove();links.delete(key);}
        for (const category of custom) {
          let a = links.get(category.key);
          if (!a) {a=document.createElement('a');a.href='/catalog?cat='+encodeURIComponent(category.key);links.set(category.key,a);}
          a.textContent=category.title;
        }
        const order = [...new Set([...(Array.isArray(catalog.home)?catalog.home:[]),...links.keys()])];
        for (const key of order) if (links.has(key)) panel.append(links.get(key));
      }
    } catch (_) { /* Keep the working existing menu on a transient network failure. */ }
    finally {running=false;}
  }
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',sync,{once:true}); else sync();
  window.addEventListener('pageshow',sync);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)sync();});
})();

/* PALITRA_PHONE_AUTH_BIND_BEGIN: mask only; demographic/auth required unchanged. */
(function(){
'use strict';
/* PALITRA_RU_PHONE_CORE_BEGIN */
const palitraRuPhone = (() => {
const digits = value => String(value ?? '').replace(/\D/g, '');
const allowed = value => /^[+\d\s().-]*$/.test(String(value ?? ''));

function parseWhole(value) {
  if (!allowed(value)) return { ok: false, code: 'NON_PHONE_TEXT' };
  if (String(value).trim().startsWith('+') && !String(value).trim().startsWith('+7')) return { ok: false, code: 'NOT_RU_PHONE' };
  let national = digits(value);
  if (national.length === 11 && /^[78]/.test(national)) national = national.slice(1);
  else if (String(value).trim().startsWith('+7')) national = national.slice(1);
  if (national.length > 10) return { ok: false, code: 'NOT_RU_PHONE' };
  return { ok: true, national, complete: national.length === 10,
    canonical: national.length === 10 ? '+7' + national : null };
}

function format(national) {
  if (!/^\d{0,10}$/.test(national)) throw new TypeError('national must contain 0..10 digits');
  if (!national) return '+7';
  let result = '+7 (' + national.slice(0, 3);
  if (national.length >= 3) result += ')';
  if (national.length > 3) result += ' ' + national.slice(3, 6);
  if (national.length > 6) result += '-' + national.slice(6, 8);
  if (national.length > 8) result += '-' + national.slice(8, 10);
  return result;
}

function digitIndex(text, selection) {
  // The one country-code digit is a protected prefix; all offsets are NATIONAL.
  return Math.max(0, Math.min(10, digits(String(text).slice(0, selection)).length - 1));
}

function caret(national, index) {
  const text = format(national);
  if (index <= 0) return national ? text.indexOf('(') + 1 : 2;
  let seen = 0;
  for (let i = 2; i < text.length; i++) if (/\d/.test(text[i]) && ++seen === index) return i + 1;
  return text.length;
}

function edit(national, start, end, data, inputType) {
  if (!/^\d{0,10}$/.test(national)) throw new TypeError('bad prior national');
  start = Math.max(0, Math.min(national.length, start));
  end = Math.max(start, Math.min(national.length, end));
  if (inputType === 'deleteContentBackward' && start === end) start = Math.max(0, start - 1);
  if (inputType === 'deleteContentForward' && start === end) end = Math.min(national.length, end + 1);
  let insert = '';
  if (!String(inputType).startsWith('delete')) {
    if (!allowed(data)) return { ok: false, national, selection: start, code: 'NON_PHONE_TEXT' };
    insert = digits(data);
    // A pasted complete number is a whole-field replacement. An 8 inside national digits is kept.
    if (inputType === 'insertFromPaste' && (insert.length === 11 && /^[78]/.test(insert) || String(data).trim().startsWith('+7'))) {
      const whole = parseWhole(data);
      return whole.ok ? { ...whole, selection: whole.national.length } : { ...whole, national, selection: start };
    }
  }
  const next = national.slice(0, start) + insert + national.slice(end);
  if (next.length > 10) return { ok: false, national, selection: start, code: 'TOO_MANY_DIGITS' };
  return { ok: true, national: next, selection: start + insert.length,
    complete: next.length === 10, canonical: next.length === 10 ? '+7' + next : null };
}
function bindMask(input, onValue) {
  if (!input || input.dataset.palitraRuMask === '1') return null;
  const initial = parseWhole(input.value);
  // Unknown existing international value is preserved, never silently reinterpreted.
  if (!initial.ok) return null;
  const prior = {type:input.type,inputmode:input.getAttribute('inputmode'),autocomplete:input.getAttribute('autocomplete')};
  input.dataset.palitraRuMask = '1';
  input.type = 'tel'; input.inputMode = 'tel'; input.autocomplete = 'tel';
  let national = initial.national, composing = false, selfInput = false;
  const listeners = [];
  const listen = (type, listener) => { input.addEventListener(type, listener); listeners.push([type, listener]); };
  const paint = (index, notify) => {
    input.value = format(national);
    input.setCustomValidity(national.length === 10 ? '' : 'Укажите номер телефона: +7 и 10 цифр.');
    if (index !== undefined) input.setSelectionRange(caret(national, index), caret(national, index));
    if (onValue) onValue(input.value);
    if (notify) {
      selfInput = true;
      input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true }));
      selfInput = false;
    }
  };
  const apply = (data, type) => {
    const start = digitIndex(input.value, input.selectionStart ?? input.value.length);
    const end = digitIndex(input.value, input.selectionEnd ?? input.value.length);
    const result = edit(national, start, end, data, type);
    if (result.ok) national = result.national;
    paint(result.selection, true);
  };
  listen('beforeinput', event => {
    if (composing || event.isComposing || !event.cancelable) return;
    const type = event.inputType || '';
    if (type.startsWith('delete') || type.startsWith('insert') && event.data !== null && type !== 'insertFromPaste') {
      event.preventDefault(); apply(event.data ?? '', type);
    }
  });
  listen('paste', event => {
    if (!event.clipboardData || !event.cancelable) return;
    event.preventDefault(); apply(event.clipboardData.getData('text'), 'insertFromPaste');
  });
  const fallback = () => {
    const offset = digitIndex(input.value, input.selectionStart ?? input.value.length);
    const result = parseWhole(input.value);
    if (result.ok) national = result.national;
    paint(offset, false);
  };
  listen('input', () => { if (!composing && !selfInput) fallback(); });
  listen('compositionstart', () => { composing = true; });
  listen('compositionend', () => { composing = false; fallback(); });
  paint(undefined, false);
  return { refresh: fallback, dispose() {
    for (const [type, listener] of listeners) input.removeEventListener(type, listener);
    delete input.dataset.palitraRuMask;
    input.setCustomValidity('');
    input.type = prior.type;
    for(const [name,value] of [['inputmode',prior.inputmode],['autocomplete',prior.autocomplete]]) { if(value===null) input.removeAttribute(name); else input.setAttribute(name,value); }
  } };
}

function bindConditional(input, onValue) {
  let binding = null, kind = null;
  const drafts = new Map();
  return { sync(phone) {
    const next = phone ? 'phone' : 'free';
    if(next === kind) { if(binding) binding.refresh(); else if(phone) binding=bindMask(input,onValue); return; }
    const priorKind=kind;
    if(kind !== null) drafts.set(kind,input.value);
    if(binding) { binding.dispose(); binding=null; }
    if(drafts.has(next)) input.value=drafts.get(next);
    else if(phone && priorKind==='free' && !parseWhole(input.value).ok) input.value='+7';
    kind=next;
    if(phone) binding=bindMask(input,onValue);
    else if(onValue) onValue(input.value);
  }, reset() { if(binding) binding.dispose(); binding=null; kind=null; drafts.clear(); }, dispose() { if(binding) binding.dispose(); binding=null; drafts.clear(); } };
}

return {bindMask,bindConditional};
})();
/* PALITRA_RU_PHONE_CORE_END */

function bindForms() {
  for(const form of document.querySelectorAll('[data-auth-form="register"], [data-profile-form]')) {
    const input=form.querySelector('input[name="phone"]');
    if(input) palitraRuPhone.bindMask(input);
  }
}
bindForms();
new MutationObserver(bindForms).observe(document.documentElement,{childList:true,subtree:true});
})();
/* PALITRA_PHONE_AUTH_BIND_END */
