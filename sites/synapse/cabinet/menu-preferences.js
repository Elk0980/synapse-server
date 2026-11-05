(() => {
  const api = window.SbCabinet ||= {};
  const defaultOrders = new WeakMap();
  // №139: старые и служебные разделы — в «Ещё» (переносятся, не удаляются). Ключ = data-view-link или editor:<вид>.
  // Ответ Влада «оставить X на месте» = убрать X из этого списка.
  const MORE_ITEMS = ['social-stats','platform-demand','hypotheses','competitors','calltracking','editor:site','editor:price','project-forms','actor-onboarding','actor-workspace','company-information','vk-community','reviews','campaigns','site-orders','system-settings','accounts','account','trademarks'];
  api.MENU_MORE_ITEMS = MORE_ITEMS;
  api.initMenuPreferences = ({identity, setDrawer}) => {
    api.destroyMenuPreferences?.();
    const sidebar = document.getElementById('sidebar');
    const nav = sidebar.querySelector('.nav');
    const keyOf = link => link.dataset.viewLink || `editor:${link.dataset.editorLink}`;
    const key = `sb-menu-v1:${identity.login}`;
    let prefs;
    try { prefs = JSON.parse(localStorage.getItem(key) || '{}'); } catch { prefs = {}; }
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) prefs = {};
    prefs.orders = prefs.orders && typeof prefs.orders === 'object' ? prefs.orders : {};
    prefs.open = prefs.open && typeof prefs.open === 'object' ? prefs.open : {};
    prefs.favorites = Array.isArray(prefs.favorites) ? prefs.favorites : [];
    const unifiedKey = id => ['autoposting','media-mentor-rollout','media-mentor'].includes(id) ? 'content-factory' : id;
    prefs.favorites = [...new Set(prefs.favorites.map(unifiedKey))];
    Object.keys(prefs.orders).forEach(group => {
      if (Array.isArray(prefs.orders[group])) prefs.orders[group] = [...new Set(prefs.orders[group].map(unifiedKey))];
    });
    const save = () => { try { localStorage.setItem(key, JSON.stringify(prefs)); } catch {} };
    const moreButton = document.createElement('button');
    moreButton.className = 'nav-category nav-more'; moreButton.id = 'more-category'; moreButton.type = 'button';
    moreButton.setAttribute('aria-expanded','false'); moreButton.setAttribute('aria-controls','more-menu'); moreButton.textContent = 'Ещё';
    const moreMenu = document.createElement('div');
    moreMenu.className = 'subnav'; moreMenu.id = 'more-menu'; moreMenu.hidden = true;
    moreMenu.innerHTML = '<p class="menu-more-note">Старые и служебные разделы. Вернуть их на прежние места: ⚙ над меню → «Показывать все разделы на прежних местах».</p>';
    nav.append(moreButton, moreMenu);
    const categories = [...nav.querySelectorAll('.nav-category')];
    const groups = categories.map(button => ({button, menu:document.getElementById(button.getAttribute('aria-controls'))}));
    groups.forEach(({menu}) => { if (!defaultOrders.has(menu)) defaultOrders.set(menu,[...menu.querySelectorAll('a.nav-link')]); });
    // Перенос: на месте пункта остаётся метка, по ней пункт возвращается. Права (hidden) по-прежнему ставит оболочка.
    const moved = [];
    if (!prefs.showAll) MORE_ITEMS.forEach(id => {
      const link = [...nav.querySelectorAll('a.nav-link')].find(item => keyOf(item) === id && !moreMenu.contains(item));
      if (!link) return;
      const mark = document.createComment(`sb-more:${id}`); link.before(mark); moreMenu.append(link); moved.push({link, mark});
    });
    const notice = document.getElementById('editor-link-notice');
    if (notice && moved.some(({link}) => link.dataset.editorLink)) { const mark = document.createComment('sb-more:notice'); notice.before(mark); moreMenu.append(notice); moved.push({link:notice, mark}); }
    const movedLinks = new Set(moved.map(({link}) => link));
    const emptied = groups.filter(({menu}) => menu !== moreMenu && moved.some(({mark}) => menu.contains(mark)));
    const links = groups.flatMap(({menu}) => [...menu.querySelectorAll('a.nav-link')]);
    const mobile = () => window.matchMedia('(max-width:760px)').matches;
    const controls = document.createElement('div');
    controls.className = 'menu-controls';
    controls.innerHTML = '<button type="button" data-menu-fold aria-controls="sidebar" title="Свернуть меню">☰<span>Свернуть</span></button><button type="button" data-menu-pin title="Закрепить меню" aria-label="Закрепить меню">◇</button><button type="button" data-menu-settings title="Настроить меню" aria-label="Настроить меню">⚙</button>';
    sidebar.prepend(controls);
    const fold = controls.querySelector('[data-menu-fold]');
    const pin = controls.querySelector('[data-menu-pin]');
    const settings = controls.querySelector('[data-menu-settings]');
    const favorites = document.createElement('div');
    favorites.className = 'menu-favorites'; favorites.setAttribute('aria-label','Быстрый доступ');
    nav.querySelector('[data-view-link="home"]').after(favorites);
    const dialog = document.createElement('dialog');
    dialog.className = 'menu-settings'; dialog.setAttribute('aria-labelledby','menu-settings-title');
    dialog.innerHTML = '<header><h2 id="menu-settings-title">Настройки меню</h2><button type="button" data-menu-close aria-label="Закрыть настройки меню">×</button></header><p>Отметьте разделы для быстрого доступа под «Главной». Стрелками меняйте порядок внутри категории.</p><p class="menu-settings-note">Настройки сохраняются автоматически для вашего аккаунта в этом браузере.</p><label class="menu-show-all"><input type="checkbox" data-menu-show-all> Показывать все разделы на прежних местах</label><p class="menu-settings-note">Выключено — старые и служебные разделы собраны в «Ещё» внизу меню. Ничего не удаляется.</p><div class="menu-bulk"><button type="button" data-menu-expand>Раскрыть все</button><button type="button" data-menu-collapse>Свернуть все</button></div><div data-menu-options></div>';
    document.body.append(dialog);
    const available = link => !link.hidden && !groups.find(g=>g.menu.contains(link))?.button.hidden;
    const renderFavorites = () => {
      favorites.replaceChildren();
      prefs.favorites.forEach(id => {
        const original = links.find(link=>keyOf(link)===id);
        if (!original || !available(original)) return;
        const copy = original.cloneNode(true);
        copy.removeAttribute('id'); copy.querySelectorAll('[id]').forEach(el=>el.removeAttribute('id'));
        copy.dataset.menuFavorite = id;
        favorites.append(copy);
      });
      favorites.hidden = !favorites.childElementCount;
    };
    // Пустые после переноса группы и «Ещё» без доступных пунктов не показываются; активный пункт из «Ещё» раскрывает её.
    const syncMore = () => {
      const shown = menu => [...menu.querySelectorAll('a.nav-link')].some(link => !link.hidden);
      emptied.forEach(({button, menu}) => { const empty = !shown(menu); button.classList.toggle('nav-empty',empty); menu.classList.toggle('nav-empty',empty); });
      // Только при изменении: наблюдатель следит за hidden кнопок групп, повторная запись дала бы бесконечный цикл.
      const noMore = !shown(moreMenu);
      if (moreButton.hidden !== noMore) moreButton.hidden = noMore;
      if (moreMenu.querySelector('a.nav-link[aria-current=page]') && moreMenu.hidden) { moreButton.setAttribute('aria-expanded','true'); moreMenu.hidden = false; }
    };
    const applyFold = () => {
      const collapsed = !mobile() && !!prefs.collapsed;
      document.body.classList.toggle('menu-collapsed',collapsed);
      fold.setAttribute('aria-expanded',String(!collapsed));
      fold.setAttribute('aria-label',mobile() ? 'Закрыть меню' : collapsed ? 'Развернуть меню' : 'Свернуть меню');
      fold.title = fold.getAttribute('aria-label');
      fold.querySelector('span').textContent = mobile() ? 'Закрыть' : collapsed ? 'Меню' : 'Свернуть';
      pin.setAttribute('aria-pressed',String(prefs.pinned !== false));
      pin.textContent = prefs.pinned !== false ? '◆' : '◇';
      pin.title = prefs.pinned !== false ? 'Открепить: меню будет сворачиваться после выбора раздела' : 'Закрепить меню';
    };
    const setExpanded = (group, open) => {
      group.button.setAttribute('aria-expanded',String(open)); group.menu.hidden = !open;
      prefs.open[group.menu.id] = open;
    };
    groups.forEach(group => {
      const order = Array.isArray(prefs.orders[group.menu.id]) ? prefs.orders[group.menu.id] : [];
      const items = group.menu === moreMenu ? [] : defaultOrders.get(group.menu).filter(item => !movedLinks.has(item));
      const sorted = [...order.map(id=>items.find(item=>keyOf(item)===id)).filter(Boolean)];
      items.forEach(item=>{if(!sorted.includes(item)) sorted.push(item);});
      sorted.reverse().forEach(item=>group.menu.prepend(item));
      setExpanded(group,prefs.open[group.menu.id] === true);
    });
    const renderOptions = () => {
      const root = dialog.querySelector('[data-menu-options]'); root.replaceChildren();
      groups.filter(group=>!group.button.hidden).forEach(group => {
        const section = document.createElement('section');
        const heading = document.createElement('h3'); heading.textContent = group.button.textContent.trim(); section.append(heading);
        const items = [...group.menu.querySelectorAll('a.nav-link')].filter(available);
        items.forEach((link,index) => {
          const row = document.createElement('div'); row.className = 'menu-option';
          const label = document.createElement('label');
          const checkbox = document.createElement('input'); checkbox.type='checkbox'; checkbox.checked=prefs.favorites.includes(keyOf(link));
          label.append(checkbox,document.createTextNode(link.textContent.trim())); row.append(label);
          checkbox.addEventListener('change',()=>{
            prefs.favorites=prefs.favorites.filter(id=>id!==keyOf(link));
            if(checkbox.checked) prefs.favorites.push(keyOf(link));
            save(); renderFavorites();
          });
          [-1,1].forEach(direction=>{
            const button=document.createElement('button'); button.type='button'; button.textContent=direction<0?'↑':'↓';
            button.setAttribute('aria-label',`${link.textContent.trim()}: ${direction<0?'выше':'ниже'}`);
            button.disabled=direction<0?index===0:index===items.length-1;
            button.addEventListener('click',()=>{
              const neighbor=items[index+direction];
              if(direction<0) neighbor.before(link); else neighbor.after(link);
              prefs.orders[group.menu.id]=[...group.menu.querySelectorAll('a.nav-link')].map(keyOf);
              save(); renderOptions();
              const updated=[...root.querySelectorAll('button')].find(el=>el.getAttribute('aria-label')===button.getAttribute('aria-label'));
              (updated?.disabled ? updated.parentElement.querySelector('input') : updated)?.focus();
            }); row.append(button);
          }); section.append(row);
        });
        if(items.length) root.append(section);
      });
    };
    fold.addEventListener('click',()=>{ if(mobile()) setDrawer(false,true); else {prefs.collapsed=!prefs.collapsed; save(); applyFold();} });
    pin.addEventListener('click',()=>{prefs.pinned=prefs.pinned===false; if(prefs.pinned) prefs.collapsed=false; save(); applyFold();});
    settings.addEventListener('click',()=>{renderOptions(); dialog.showModal();});
    const showAll = dialog.querySelector('[data-menu-show-all]'); showAll.checked = !!prefs.showAll;
    showAll.addEventListener('change',()=>{
      prefs.showAll = showAll.checked; save(); dialog.close();
      api.initMenuPreferences({identity, setDrawer});
      document.querySelector('[data-menu-settings]').click(); document.querySelector('[data-menu-show-all]')?.focus();
    });
    dialog.querySelector('[data-menu-close]').addEventListener('click',()=>dialog.close());
    dialog.addEventListener('close',()=>settings.focus());
    ['expand','collapse'].forEach(action=>dialog.querySelector(`[data-menu-${action}]`).addEventListener('click',()=>{
      groups.forEach(group=>setExpanded(group,action==='expand')); save();
    }));
    const onClick = event => {
      if(event.target.closest('.nav-category')) { groups.forEach(group=>{prefs.open[group.menu.id]=group.button.getAttribute('aria-expanded')==='true';}); save(); }
      const link = event.target.closest('a');
      if(link && link.getAttribute('aria-disabled')!=='true' && prefs.pinned===false && !mobile()) {prefs.collapsed=true;save();applyFold();fold.focus();}
    };
    // The shell prevents default for internal routes; navigation still counts as choosing a section.
    const onNavigate = () => { if(prefs.pinned===false && !mobile() && !dialog.open) {prefs.collapsed=true;save();applyFold();} };
    nav.addEventListener('click',onClick);
    window.addEventListener('hashchange',onNavigate);
    window.addEventListener('resize',applyFold);
    const observer = new MutationObserver(() => { renderFavorites(); syncMore(); });
    links.forEach(link=>observer.observe(link,{attributes:true,attributeFilter:['hidden','href','aria-current','aria-disabled','target']}));
    categories.forEach(button=>observer.observe(button,{attributes:true,attributeFilter:['hidden']}));
    renderFavorites(); syncMore(); applyFold();
    api.destroyMenuPreferences = () => { observer.disconnect();moved.forEach(({link,mark})=>mark.replaceWith(link));emptied.forEach(({button,menu})=>{button.classList.remove('nav-empty');menu.classList.remove('nav-empty');});moreButton.remove();moreMenu.remove();nav.removeEventListener('click',onClick);window.removeEventListener('hashchange',onNavigate);window.removeEventListener('resize',applyFold);controls.remove();favorites.remove();dialog.remove();document.body.classList.remove('menu-collapsed'); };
  };
})();
