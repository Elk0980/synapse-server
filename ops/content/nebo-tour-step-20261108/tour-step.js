/* Небо · экскурсия: один свайп/щелчок колеса = видео доигрывает до следующего блока.
   Подключается отдельным файлом после основного бандла, сам код сайта не трогает. */
(function () {
  'use strict';
  if (window.__neboTourStep) return; window.__neboTourStep = true;
  var IDS = ['tour-sky','tour-building','tour-entrance','tour-reception','tour-prices','tour-doctor','tour-care','tour-microscope'];
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var anim = null, lastGesture = 0, wheelIdleAt = 0, touchY = null, touchX = null;

  function film() { return document.getElementById('tour-film'); }
  function stops() {
    var out = [];
    for (var i = 0; i < IDS.length; i++) {
      var el = document.getElementById(IDS[i]); if (!el) continue;
      out.push(Math.round(el.getBoundingClientRect().top + window.scrollY));
    }
    return out;
  }
  function filmEnd() { // где экскурсия заканчивается и начинается обычный сайт
    var f = film(); if (!f) return 0;
    return Math.round(f.getBoundingClientRect().top + window.scrollY + f.offsetHeight - window.innerHeight);
  }
  function inZone(y) { var f = film(); return !!f && y < filmEnd() - 2; }
  // управляем ли этим жестом: вниз — пока внутри экскурсии; вверх — внутри или ровно на её выходе
  function owns(dir, y) {
    if (!film()) return false;
    return dir > 0 ? inZone(y) : (y > 0 && y <= filmEnd() + 2);
  }

  // Видео сайта перематывается вслед за прокруткой: время = доля пройденного фильма × длительность.
  // Перемотка по кадрам на этом файле медленная и рваная, поэтому на шаг вниз мы ПРОИГРЫВАЕМ видео
  // обычным воспроизведением, а прокрутку ведём за ним. Перемотку сайта на это время глушим,
  // после остановки всё возвращается сайту как было.
  var SPEED = 1.6;                        // видео идёт быстрее обычного (Влад 08.11: «скорость увеличить немного»)
  var CT = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
  function video() { return document.querySelector('#tour-film video') || document.querySelector('.clinic-tour video') || document.querySelector('video'); }
  function filmTop() { var f = film(); return f ? f.getBoundingClientRect().top + window.scrollY : 0; }
  function filmH() { var f = film(); return f ? f.offsetHeight : 1; }
  function timeOfY(y, v) { return Math.max(0, Math.min(.999, (y - filmTop()) / filmH())) * v.duration; }
  function yOfTime(t, v) { return filmTop() + t / v.duration * filmH(); }
  function ease(t) { return t < .5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2) / 2; }
  function setY(y) { window.scrollTo({ top: Math.round(y), behavior: 'instant' }); } // instant: на сайте html { scroll-behavior: smooth }
  // пока играем — перемотку сайта глушим, но запоминаем, куда он хочет поставить кадр
  function lock(v) { Object.defineProperty(v, 'currentTime', { configurable: true, get: function () { return CT.get.call(v); }, set: function (t) { v.__siteWant = t; } }); }
  function unlock(v) { try { delete v.currentTime; } catch (e) {} }

  function finish(a, v) {
    setY(a.to);
    if (v) {
      try { v.pause(); } catch (e) {}
      v.playbackRate = 1;
      try { CT.set.call(v, timeOfY(a.to, v)); } catch (e) {}   // кадр ровно на блоке
      // возвращаем управление сайту только когда его перемотка догнала наш кадр (иначе видео дёрнется назад)
      var started = performance.now();
      (function wait() {
        if (anim && anim.mode === 'play') return;
        var want = v.__siteWant, have = CT.get.call(v);
        if ((typeof want === 'number' && Math.abs(want - have) < .15) || performance.now() - started > 4000) unlock(v);
        else setTimeout(wait, 100);
      })();
    }
    if (anim === a) anim = null;
  }

  // Вниз: проигрываем видео до блока.
  function playTo(to) {
    var v = video();
    if (!v || reduce || !isFinite(v.duration) || v.readyState < 2) return glideTo(to);
    if (anim && anim.mode === 'play') { anim.to = to; return; }   // ещё свайп во время проигрывания — просто едем дальше
    if (anim) stop();
    var a = anim = { mode: 'play', to: to, raf: 0 };
    lock(v);
    try { CT.set.call(v, timeOfY(window.scrollY, v)); } catch (e) {}
    v.playbackRate = SPEED;
    var p; try { p = v.play(); } catch (e) { p = null; }
    if (p && p.catch) p.catch(function () { if (anim === a) { unlock(v); anim = null; glideTo(to); } });
    // Защита от зависания: только если видео реально стоит 4 с — тогда дальше плавной прокруткой.
    // Никаких прыжков по таймеру: видео всегда проигрывается целиком до блока.
    var lastT = -1, lastMove = performance.now();
    (function frame(now) {
      if (anim !== a) return;
      var t = CT.get.call(v), stopT = timeOfY(a.to, v), y = yOfTime(t, v);
      if (t > lastT + .001) { lastT = t; lastMove = now; }
      if (t >= stopT - .03 || v.ended) return finish(a, v);
      if (now - lastMove > 4000) { var to2 = a.to; try { v.pause(); } catch (e) {} v.playbackRate = 1; unlock(v); anim = null; return glideTo(to2); }
      setY(Math.min(y, a.to));
      a.raf = requestAnimationFrame(frame);
    })(performance.now());
  }

  // Вверх (видео назад не играет) и запасной путь: плавная прокрутка, сайт сам перематывает видео.
  function glideTo(to) {
    if (anim) stop();
    var from = window.scrollY, dist = to - from; if (Math.abs(dist) < 2) return;
    var dur = reduce ? 1 : Math.min(2600, Math.max(900, Math.abs(dist) * .6)), t0 = performance.now();
    var a = anim = { mode: 'glide', to: to, raf: 0 };
    (function frame(now) {
      if (anim !== a) return;
      var t = Math.min(1, (now - t0) / dur); setY(from + dist * ease(t));
      if (t >= 1) { anim = null; return; }
      a.raf = requestAnimationFrame(frame);
    })(t0);
  }
  function stop() {
    if (!anim) return; cancelAnimationFrame(anim.raf);
    if (anim.mode === 'play') { var v = video(); if (v) { try { v.pause(); } catch (e) {} v.playbackRate = 1; unlock(v); } }
    anim = null;
  }
  function scrollToY(to, dir) { if (dir > 0) playTo(to); else glideTo(to); }

  function step(dir) {
    var y = window.scrollY, s = stops(), end = filmEnd(), target = null, i;
    if (anim && (anim.to > y) === (dir > 0)) y = anim.to; // ещё свайп в ту же сторону во время движения — к блоку после текущей цели
    if (dir > 0) {
      for (i = 0; i < s.length; i++) if (s[i] > y + 4) { target = s[i]; break; }
      if (target === null) target = end;            // после последнего блока — выход из экскурсии
    } else {
      for (i = s.length - 1; i >= 0; i--) if (s[i] < y - 4) { target = s[i]; break; }
      if (target === null) target = 0;
    }
    scrollToY(target, dir);
  }

  // ── Загрузка и автостарт (Влад 08.11 16:35) ──────────────────────────────────────
  // Пока сайт грузится — поверх идёт бесконечный цикл облаков (#nebo-loader из index.html).
  // Как только видео экскурсии готово — облака плавно растворяются и видео само идёт
  // до первого блока, без касаний. Дальше — свайпами, как обычно.
  var userActed = false;
  ['wheel', 'touchstart', 'keydown'].forEach(function (t) {
    window.addEventListener(t, function () { userActed = true; }, { capture: true, passive: true });
  });
  function hideLoader() {
    var l = document.getElementById('nebo-loader'); if (!l || l.__gone) return; l.__gone = true;
    l.style.opacity = '0';
    setTimeout(function () { l.remove(); }, 900);
  }
  function autostart() {
    hideLoader();
    if (reduce || userActed || window.scrollY > 10 || anim) return;
    setTimeout(function () { if (!userActed && window.scrollY <= 10 && !anim) step(1); }, 700);
  }
  (function waitReady(t0) {
    var v = video(), f = film();
    var ready = v && f && v.readyState >= 3 && isFinite(v.duration) && v.duration > 0 && document.readyState !== 'loading';
    if (ready) return autostart();
    if (performance.now() - t0 > 25000) return hideLoader();   // сеть совсем плохая — убираем облака без автостарта
    setTimeout(function () { waitReady(t0); }, 150);
  })(performance.now());

  // Колесо и тачпад: один жест = один шаг. Инерция тачпада гасится паузой между событиями.
  window.addEventListener('wheel', function (e) {
    var y = anim ? anim.to : window.scrollY;
    var down = e.deltaY > 0;
    if (!owns(down ? 1 : -1, y)) return; // ниже экскурсии — обычная прокрутка
    if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    var now = performance.now(), idle = now - wheelIdleAt; wheelIdleAt = now;
    if (idle < 300) return; // тот же жест (инерция тачпада/колеса) — новый жест только после паузы
    if (Math.abs(e.deltaY) < 4) return;
    lastGesture = now; step(down ? 1 : -1);
  }, { capture: true, passive: false });

  // Палец
  window.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) { touchY = null; return; }
    touchY = e.touches[0].clientY; touchX = e.touches[0].clientX;
  }, { capture: true, passive: true });
  window.addEventListener('touchmove', function (e) {
    if (touchY === null) return;
    var y = anim ? anim.to : window.scrollY, dy = touchY - e.touches[0].clientY;
    if (Math.abs(dy) < 2) return;
    if (owns(dy > 0 ? 1 : -1, y)) {
      e.preventDefault(); e.stopImmediatePropagation();
    }
  }, { capture: true, passive: false });
  window.addEventListener('touchend', function (e) {
    if (touchY === null) return;
    var t = e.changedTouches[0], dy = touchY - t.clientY, dx = touchX - t.clientX; touchY = null;
    if (Math.abs(dy) < 30 || Math.abs(dy) < Math.abs(dx)) return;
    var y = anim ? anim.to : window.scrollY;
    if (owns(dy > 0 ? 1 : -1, y)) {
      step(dy > 0 ? 1 : -1);
    }
  }, { capture: true, passive: true });

  // Клавиатура
  window.addEventListener('keydown', function (e) {
    var k = e.key, tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || e.target.isContentEditable) return;
    var down = k === 'ArrowDown' || k === 'PageDown' || (k === ' ' && !e.shiftKey);
    var up = k === 'ArrowUp' || k === 'PageUp' || (k === ' ' && e.shiftKey);
    if (!down && !up) return;
    var y = anim ? anim.to : window.scrollY;
    if (!owns(down ? 1 : -1, y)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    step(down ? 1 : -1);
  }, { capture: true });
})();
