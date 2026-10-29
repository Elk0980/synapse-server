/*
 * Palitra — предпросмотр публикации (spec 049-palitra-content-calendar, Spec Kit 1.0.0).
 * Vanilla JS, UMD, без зависимостей и без сети. Компонент только показывает файлы,
 * которые форма уже выбрала: ничего не скачивает, не отправляет и не меняет.
 * Зоны интерфейса — ориентир, а не официальная разметка площадок.
 */
(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) module.exports = factory();
  else root.PalitraPlatformPreview = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PLATFORMS = {telegram: 'Telegram', vk: 'ВКонтакте', youtube_shorts: 'YouTube Shorts', instagram: 'Instagram', tiktok: 'TikTok', max: 'MAX'};
  var FORMATS = {post: 'Пост', story: 'История', reel: 'Ролик', carousel: 'Карусель'};
  var IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'];
  var VIDEO_MIME = ['video/mp4', 'video/webm'];
  var EXT = {jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', mp4: 'video', webm: 'video'};
  var NOTE = 'Зоны интерфейса — ориентир';
  var EMPTY = 'Добавьте фото или видео';
  var PUBLISHER_FALLBACK = 'Ваш аккаунт';
  var KNOWN_RATIOS = [[1, 1], [4, 5], [5, 4], [3, 4], [4, 3], [2, 3], [3, 2], [9, 16], [16, 9]];
  var P = 'palitra-preview';

  function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

  function layoutOf(platform, format) {
    if (platform === 'tiktok' || platform === 'youtube_shorts') return 'vertical';
    if (format === 'story') return 'vertical';
    if (format === 'reel' && (platform === 'instagram' || platform === 'vk')) return 'vertical';
    return 'card';
  }

  // Проценты от кадра 9:16. Ориентир для глаз, не измеренная официальная схема.
  function zonesOf(platform, format) {
    if (format === 'story') return {top: 12, right: 0, rightTop: 0, bottom: 13, story: true};
    if (platform === 'instagram') return {top: 9, right: 14, rightTop: 48, bottom: 22};
    if (platform === 'youtube_shorts') return {top: 9, right: 15, rightTop: 44, bottom: 22};
    return {top: 10, right: 15, rightTop: 40, bottom: 22};
  }

  function dim(value) {
    var n = Number(value);
    return isFinite(n) && n > 0 && n < 100000 ? n : null;
  }

  function ratioLabel(w, h) {
    if (!w || !h) return null;
    var r = w / h;
    for (var i = 0; i < KNOWN_RATIOS.length; i++) {
      var k = KNOWN_RATIOS[i][0] / KNOWN_RATIOS[i][1];
      if (Math.abs(r - k) / k < 0.01) return KNOWN_RATIOS[i][0] + ':' + KNOWN_RATIOS[i][1];
    }
    return (r >= 1 ? r.toFixed(2) + ':1' : '1:' + (1 / r).toFixed(2)).replace(/\./g, ',');
  }

  function extOf(text) {
    var m = /\.([a-z0-9]{2,5})$/i.exec(String(text || '').split(/[?#]/)[0]);
    return m ? m[1].toLowerCase() : '';
  }

  function kindOf(item, url) {
    var t = typeof item.type === 'string' ? item.type.trim().toLowerCase() : '';
    if (t === 'image' || t === 'video') return t;
    if (t) {
      if (IMAGE_MIME.indexOf(t) >= 0) return 'image';
      if (VIDEO_MIME.indexOf(t) >= 0) return 'video';
      return null;
    }
    var ext = extOf(item.name);
    if (!ext && url && url.toLowerCase().indexOf('blob:') !== 0) ext = extOf(url);
    return EXT[ext] || null;
  }

  // Возвращает {src} для допустимого адреса или {reason} для запрещённого.
  function checkUrl(url, win, allowedHosts) {
    if (typeof url !== 'string' || !url) return {reason: 'нет адреса файла'};
    if (url.length > 8192 || /[\u0000- \u007f]/.test(url)) return {reason: 'недопустимый адрес'};
    var loc = win.location, lower = url.toLowerCase(), parsed;
    try {
      if (lower.indexOf('blob:') === 0) {
        parsed = new win.URL(url.slice(5));
        return parsed.origin === loc.origin ? {src: url} : {reason: 'файл из чужого источника'};
      }
      if (url.charAt(0) === '/' && url.charAt(1) !== '/' && url.charAt(1) !== '\\') {
        parsed = new win.URL(url, loc.href);
        return parsed.protocol === 'https:' && parsed.origin === loc.origin ? {src: parsed.href} : {reason: 'нужен адрес HTTPS'};
      }
      if (lower.indexOf('https://') === 0) {
        parsed = new win.URL(url);
        if (parsed.username || parsed.password) return {reason: 'недопустимый адрес'};
        var host = parsed.hostname.toLowerCase();
        if (parsed.origin === loc.origin || allowedHosts.indexOf(host) >= 0) return {src: parsed.href};
        return {reason: 'файл с чужого домена'};
      }
    } catch (e) {
      return {reason: 'недопустимый адрес'};
    }
    return {reason: 'недопустимый адрес'};
  }

  function normalizeMedia(list, win, allowedHosts) {
    if (!Array.isArray(list)) return [];
    return list.map(function (raw, i) {
      var item = raw && typeof raw === 'object' ? raw : {};
      var name = typeof item.name === 'string' ? item.name.slice(0, 300) : '';
      var url = typeof item.url === 'string' ? item.url : '';
      var res = checkUrl(url, win, allowedHosts);
      var kind = kindOf(item, url);
      var out = {name: name, width: dim(item.width), height: dim(item.height), kind: kind, src: null, reason: null, index: i};
      if (res.reason) out.reason = res.reason;
      else if (!kind) out.reason = 'формат не поддерживается';
      else out.src = res.src;
      return out;
    });
  }

  function normalize(prev, next, win, allowedHosts) {
    next = next && typeof next === 'object' ? next : {};
    var platform = has(next, 'platform') ? next.platform : prev.platform;
    var format = has(next, 'format') ? next.format : prev.format;
    if (typeof platform !== 'string' || !has(PLATFORMS, platform)) throw new TypeError('PalitraPlatformPreview: неизвестная площадка ' + String(platform));
    if (typeof format !== 'string' || !has(FORMATS, format)) throw new TypeError('PalitraPlatformPreview: неизвестный формат ' + String(format));
    function str(key) {
      var v = has(next, key) ? next[key] : prev[key];
      return v == null ? '' : String(v);
    }
    return {
      platform: platform,
      format: format,
      title: str('title'),
      text: str('text'),
      publisherLabel: str('publisherLabel'),
      media: has(next, 'media') ? normalizeMedia(next.media, win, allowedHosts) : (prev.media || [])
    };
  }

  function mediaSignature(media) {
    return media.map(function (m) {
      return [m.src || '', m.kind || '', m.name, m.width || '', m.height || '', m.reason || ''].join('\u0001');
    }).join('\u0002');
  }

  function create(options) {
    var o = options && typeof options === 'object' ? options : {};
    var doc = o.document || (o.window && o.window.document);
    var win = o.window || (doc && doc.defaultView);
    if (!doc || !win || typeof doc.createElement !== 'function') throw new TypeError('PalitraPlatformPreview: нужны document и window');
    var allowedHosts = (Array.isArray(o.allowedHosts) ? o.allowedHosts : []).filter(function (h) {
      return typeof h === 'string' && /^[a-z0-9.-]+$/i.test(h);
    }).map(function (h) { return h.toLowerCase(); });

    var state = normalize({}, o, win, allowedHosts);
    var view = {fit: o.fit === 'cover' ? 'cover' : 'contain', zones: o.showZones !== false, index: 0};
    var disposed = false;
    var uiListeners = [], mediaListeners = [];
    var refs = {}, slides = [], layoutKey = null, mediaKey = null;

    var root = el('div', P);
    root.setAttribute('role', 'region');
    render();

    return {element: root, update: update, dispose: dispose};

    // ---- helpers ----
    function el(tag, cls, attrs) {
      var node = doc.createElement(tag);
      if (cls) node.className = cls;
      if (attrs) for (var k in attrs) if (has(attrs, k)) node.setAttribute(k, attrs[k]);
      return node;
    }
    function text(node, value) { if (node.textContent !== value) node.textContent = value; }
    function on(bucket, node, type, fn) { node.addEventListener(type, fn); bucket.push([node, type, fn]); }
    function off(bucket) {
      while (bucket.length) { var l = bucket.pop(); l[0].removeEventListener(l[1], l[2]); }
    }
    function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
    function setBool(node, attr, flag) { if (flag) node.setAttribute(attr, ''); else node.removeAttribute(attr); }
    function pauseVideos(except) {
      slides.forEach(function (s) {
        if (s.video && s.video !== except) { try { if (!s.video.paused) s.video.pause(); } catch (e) { /* jsdom */ } }
      });
    }
    function releaseMedia() {
      off(mediaListeners);
      slides.forEach(function (s) {
        if (s.video) { try { if (!s.video.paused) s.video.pause(); } catch (e) { /* jsdom */ } s.video.removeAttribute('src'); }
        if (s.img) s.img.removeAttribute('src');
      });
      slides = [];
    }

    // ---- structure ----
    function build() {
      releaseMedia();
      off(uiListeners);
      clear(root);
      refs = {};
      var layout = layoutOf(state.platform, state.format);
      var carousel = state.format === 'carousel';
      root.className = P + ' ' + P + '--' + layout;

      refs.meta = el('p', P + '__meta');
      refs.metaPlatform = el('span', P + '__meta-platform');
      refs.metaFormat = el('span', P + '__meta-format');
      refs.metaRatio = el('span', P + '__meta-ratio');
      refs.meta.appendChild(refs.metaPlatform);
      refs.meta.appendChild(el('span', P + '__meta-sep', {'aria-hidden': 'true'})).textContent = ' · ';
      refs.meta.appendChild(refs.metaFormat);
      refs.meta.appendChild(el('span', P + '__meta-sep', {'aria-hidden': 'true'})).textContent = ' · ';
      refs.meta.appendChild(refs.metaRatio);
      root.appendChild(refs.meta);

      refs.stage = el('div', P + '__stage');
      if (carousel) {
        refs.stage.setAttribute('tabindex', '0');
        refs.stage.setAttribute('role', 'group');
        refs.stage.setAttribute('aria-roledescription', 'карусель');
        on(uiListeners, refs.stage, 'keydown', onKey);
      }

      if (layout === 'vertical') buildVertical();
      else buildCard();

      if (carousel) {
        refs.pager = el('div', P + '__pager');
        refs.prev = el('button', P + '__btn', {type: 'button', 'aria-label': 'Предыдущий кадр'});
        refs.prev.textContent = '← Назад';
        refs.next = el('button', P + '__btn', {type: 'button', 'aria-label': 'Следующий кадр'});
        refs.next.textContent = 'Вперёд →';
        refs.counter = el('span', P + '__counter', {'aria-live': 'polite', 'aria-atomic': 'true'});
        refs.pager.appendChild(refs.prev);
        refs.pager.appendChild(refs.counter);
        refs.pager.appendChild(refs.next);
        on(uiListeners, refs.prev, 'click', function () { go(-1); });
        on(uiListeners, refs.next, 'click', function () { go(1); });
        root.appendChild(refs.pager);
      }

      refs.extra = el('p', P + '__extra');
      root.appendChild(refs.extra);
      refs.note = el('p', P + '__note');
      refs.note.textContent = NOTE;
      root.appendChild(refs.note);
    }

    function buildCard() {
      var card = el('article', P + '__card');
      var head = el('header', P + '__head');
      refs.avatar = el('span', P + '__avatar', {'aria-hidden': 'true'});
      var who = el('span', P + '__who');
      refs.publisher = el('span', P + '__publisher');
      refs.platformTag = el('span', P + '__platform');
      who.appendChild(refs.publisher);
      who.appendChild(refs.platformTag);
      head.appendChild(refs.avatar);
      head.appendChild(who);
      card.appendChild(head);
      card.appendChild(refs.stage);
      refs.caption = el('p', P + '__caption');
      card.appendChild(refs.caption);
      root.appendChild(card);
    }

    function buildVertical() {
      var z = zonesOf(state.platform, state.format);
      refs.controls = el('div', P + '__controls', {role: 'group', 'aria-label': 'Настройки предпросмотра'});
      refs.zonesBtn = el('button', P + '__btn ' + P + '__toggle', {type: 'button'});
      refs.zonesBtn.textContent = 'Подсветить зоны';
      var fitGroup = el('span', P + '__fit', {role: 'group', 'aria-label': 'Как показать файл в кадре'});
      refs.fitContain = el('button', P + '__btn ' + P + '__toggle', {type: 'button'});
      refs.fitContain.textContent = 'Вписать';
      refs.fitCover = el('button', P + '__btn ' + P + '__toggle', {type: 'button'});
      refs.fitCover.textContent = 'Заполнить';
      fitGroup.appendChild(refs.fitContain);
      fitGroup.appendChild(refs.fitCover);
      refs.controls.appendChild(refs.zonesBtn);
      refs.controls.appendChild(fitGroup);
      on(uiListeners, refs.zonesBtn, 'click', function () { view.zones = !view.zones; paint(); });
      on(uiListeners, refs.fitContain, 'click', function () { view.fit = 'contain'; paint(); });
      on(uiListeners, refs.fitCover, 'click', function () { view.fit = 'cover'; paint(); });
      root.appendChild(refs.controls);

      refs.frame = el('div', P + '__frame');
      refs.frame.appendChild(refs.stage);

      var top = el('div', P + '__zone ' + P + '__zone--top', {'aria-hidden': 'true'});
      top.style.height = z.top + '%';
      top.appendChild(el('span', P + '__zone-label')).textContent = 'верх';
      if (z.story) top.appendChild(el('span', P + '__progress'));
      else { top.appendChild(el('span', P + '__bar')); top.appendChild(el('span', P + '__bar ' + P + '__bar--short')); }
      refs.frame.appendChild(top);

      if (z.right) {
        var right = el('div', P + '__zone ' + P + '__zone--right', {'aria-hidden': 'true'});
        right.style.width = z.right + '%';
        right.style.top = z.rightTop + '%';
        right.appendChild(el('span', P + '__zone-label')).textContent = 'кнопки';
        for (var i = 0; i < 4; i++) right.appendChild(el('span', P + '__dot'));
        refs.frame.appendChild(right);
      }

      var bottom = el('div', P + '__zone ' + P + '__zone--bottom', {'aria-hidden': 'true'});
      bottom.style.height = z.bottom + '%';
      if (z.right) bottom.style.right = z.right + '%';
      bottom.appendChild(el('span', P + '__zone-label')).textContent = z.story ? 'поле ответа' : 'подпись';
      if (z.story) bottom.appendChild(el('span', P + '__reply'));
      refs.frame.appendChild(bottom);

      // Настоящий текст поверх кадра (не скрыт от экранного диктора).
      if (z.story) {
        refs.overlayTop = el('div', P + '__overlay ' + P + '__overlay--top');
        refs.overlayTop.style.top = (z.top * 0.35) + '%';
        refs.publisher = el('span', P + '__publisher');
        refs.overlayTop.appendChild(refs.publisher);
        refs.frame.appendChild(refs.overlayTop);
      }
      refs.overlayBottom = el('div', P + '__overlay ' + P + '__overlay--bottom');
      if (z.story) refs.overlayBottom.style.bottom = (z.bottom + 2) + '%';
      else refs.overlayBottom.style.right = (z.right + 2) + '%';
      if (!z.story) {
        refs.publisher = el('span', P + '__publisher');
        refs.overlayBottom.appendChild(refs.publisher);
      }
      if (state.platform === 'youtube_shorts') {
        refs.title = el('span', P + '__title');
        refs.overlayBottom.appendChild(refs.title);
      }
      refs.caption = el('span', P + '__caption');
      refs.overlayBottom.appendChild(refs.caption);
      refs.frame.appendChild(refs.overlayBottom);

      root.appendChild(refs.frame);
      refs.fitNote = el('p', P + '__fit-note', {'aria-live': 'polite'});
      root.appendChild(refs.fitNote);
    }

    function buildMedia() {
      releaseMedia();
      clear(refs.stage);
      var items = state.format === 'carousel' ? state.media : state.media.slice(0, 1);
      if (!items.length) {
        var ph = el('p', P + '__placeholder');
        ph.textContent = EMPTY;
        refs.stage.appendChild(ph);
        return;
      }
      items.forEach(function (m, i) {
        var slide = el('div', P + '__slide');
        var entry = {node: slide, item: m, img: null, video: null};
        if (!m.src) {
          slide.appendChild(fallback(m, 'Файл не может быть показан: ' + m.reason));
        } else if (m.kind === 'video') {
          var v = el('video', P + '__media');
          v.controls = true;
          v.preload = 'metadata';
          v.setAttribute('playsinline', '');
          v.setAttribute('aria-label', m.name ? 'Видео: ' + m.name : 'Видео ' + (i + 1));
          if (m.width && m.height) { v.setAttribute('width', String(m.width)); v.setAttribute('height', String(m.height)); }
          v.src = m.src;
          entry.video = v;
          slide.appendChild(v);
          on(mediaListeners, v, 'error', function () { broken(entry); });
        } else {
          var img = el('img', P + '__media');
          img.alt = m.name ? 'Изображение: ' + m.name : 'Изображение ' + (i + 1);
          img.decoding = 'async';
          img.setAttribute('referrerpolicy', 'no-referrer');
          if (m.width && m.height) { img.setAttribute('width', String(m.width)); img.setAttribute('height', String(m.height)); }
          img.src = m.src;
          entry.img = img;
          slide.appendChild(img);
          on(mediaListeners, img, 'error', function () { broken(entry); });
        }
        slides.push(entry);
        refs.stage.appendChild(slide);
      });
    }

    function fallback(m, message) {
      var box = el('p', P + '__fallback');
      box.textContent = message + (m.name ? ' (' + m.name + ')' : '');
      return box;
    }

    function broken(entry) {
      if (disposed) return;
      var media = entry.img || entry.video;
      if (!media || media.parentNode !== entry.node) return;
      media.removeAttribute('src');
      entry.node.removeChild(media);
      entry.img = entry.video = null;
      entry.node.appendChild(fallback(entry.item, 'Файл не удалось открыть'));
    }

    // ---- painting ----
    function current() { return slides[view.index] ? slides[view.index].item : null; }

    function paint() {
      var layout = layoutOf(state.platform, state.format);
      var platformName = PLATFORMS[state.platform], formatName = FORMATS[state.format];
      var publisher = state.publisherLabel.trim() || PUBLISHER_FALLBACK;
      var m = current();
      var fileRatio = m && m.src ? ratioLabel(m.width, m.height) : null;

      root.setAttribute('aria-label', 'Предпросмотр: ' + platformName + ', ' + formatName + (state.title.trim() ? ', «' + state.title.trim() + '»' : ''));
      text(refs.metaPlatform, platformName);
      text(refs.metaFormat, formatName);
      if (layout === 'vertical') text(refs.metaRatio, 'кадр 9:16');
      else text(refs.metaRatio, !m ? 'пропорции появятся с файлом' : fileRatio ? 'пропорции файла ' + fileRatio : 'пропорции файла неизвестны');

      text(refs.publisher, publisher);
      if (refs.avatar) text(refs.avatar, publisher.charAt(0).toUpperCase());
      if (refs.platformTag) text(refs.platformTag, platformName);
      if (refs.title) { text(refs.title, state.title); setBool(refs.title, 'hidden', !state.title.trim()); }
      if (layout === 'card') {
        var empty = !state.text.trim();
        text(refs.caption, empty ? 'Без текста' : state.text);
        refs.caption.classList.toggle(P + '__caption--empty', empty);
      } else {
        text(refs.caption, state.text);
      }

      slides.forEach(function (s, i) { setBool(s.node, 'hidden', i !== view.index); });

      if (refs.pager) {
        var n = slides.length;
        setBool(refs.pager, 'hidden', n < 2);
        text(refs.counter, n ? (view.index + 1) + ' / ' + n : '0 / 0');
        refs.prev.disabled = view.index <= 0;
        refs.next.disabled = view.index >= n - 1;
        refs.stage.setAttribute('aria-label', 'Карусель, файлов: ' + n + '. Стрелки влево и вправо листают кадры');
      }

      var hidden = state.format === 'carousel' ? 0 : Math.max(0, state.media.length - 1);
      text(refs.extra, hidden ? 'Показан первый файл из ' + state.media.length + '.' : '');
      setBool(refs.extra, 'hidden', !hidden);

      if (refs.frame) {
        root.classList.toggle(P + '--fit-cover', view.fit === 'cover');
        refs.frame.classList.toggle(P + '__frame--zones', view.zones);
        refs.zonesBtn.setAttribute('aria-pressed', String(view.zones));
        refs.fitContain.setAttribute('aria-pressed', String(view.fit === 'contain'));
        refs.fitCover.setAttribute('aria-pressed', String(view.fit === 'cover'));
        text(refs.fitNote, fitNote(m, fileRatio));
        setBool(refs.fitNote, 'hidden', !refs.fitNote.textContent);
      }
    }

    function fitNote(m, fileRatio) {
      if (!m || !m.src) return '';
      if (fileRatio === '9:16') return 'Файл 9:16 совпадает с кадром.';
      var what = fileRatio ? 'Файл ' + fileRatio : 'Файл';
      if (view.fit === 'cover') return what + ' заполняет кадр 9:16: края файла обрезаны.';
      return what + ' вписан в кадр 9:16 целиком' + (fileRatio ? ': по краям будут поля.' : '.');
    }

    function go(step) {
      if (disposed) return;
      var next = Math.max(0, Math.min(slides.length - 1, view.index + step));
      if (next === view.index) return;
      pauseVideos(null);
      view.index = next;
      paint();
    }

    function onKey(event) {
      if (event.key === 'ArrowLeft') { event.preventDefault(); go(-1); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); go(1); }
    }

    function render() {
      var key = state.platform + '|' + state.format;
      if (key !== layoutKey) { build(); layoutKey = key; mediaKey = null; }
      var sig = mediaSignature(state.media);
      if (sig !== mediaKey) { buildMedia(); mediaKey = sig; }
      view.index = Math.max(0, Math.min(view.index, slides.length - 1));
      paint();
    }

    // ---- public ----
    function update(next) {
      if (disposed) return;
      state = normalize(state, next, win, allowedHosts); // бросает TypeError до любых изменений
      render();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      releaseMedia();
      off(uiListeners);
      clear(root);
      if (root.parentNode) root.parentNode.removeChild(root);
      refs = {};
      // URL.revokeObjectURL — забота владельца формы, компонент его не вызывает.
    }
  }

  return {create: create};
});
