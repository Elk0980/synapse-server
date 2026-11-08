/* Opening video follows the visible scene and recovers during ordinary page interaction. */
(function (root) {
  "use strict";

  function create(options) {
    const video = options.video;
    const sources = options.sources || {};
    const canPlay = options.canPlay || (() => true);
    const onPlaying = options.onPlaying || (() => {});
    const onBlocked = options.onBlocked || (() => {});
    const doc = video.ownerDocument;
    const win = doc.defaultView || root;
    const formats = options.isIOS ? ["mp4", "webm"] : ["webm", "mp4"];
    const candidates = formats
      .filter((format) => sources[format] && video.canPlayType("video/" + format))
      .map((format) => sources[format]);

    let sourceIndex = -1;
    let sourceLoaded = false;
    let sourceExhausted = false;
    let disposed = false;
    let pageHidden = false;
    let autoplayBlocked = false;
    let playing = false;
    let attempt = 0;
    let pendingAttempt = null;
    const listeners = [];
    function listen(target, type, handler, capture = false) {
      const eventOptions = { capture };
      target.addEventListener(type, handler, eventOptions);
      listeners.push(() => target.removeEventListener(type, handler, eventOptions));
    }

    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.controls = false;
    video.disablePictureInPicture = true;
    video.loop = true;
    video.preload = "auto";
    video.setAttribute("muted", "");
    video.setAttribute("playsinline", "");

    function eligible() {
      return !disposed && !pageHidden && !doc.hidden && Boolean(canPlay());
    }

    function stopPlayback() {
      const wasPending = pendingAttempt !== null;
      attempt += 1;
      pendingAttempt = null;
      playing = false;
      onBlocked(false);
      video.style.opacity = "0";
      if (wasPending || !video.paused) video.pause();
    }

    function markPlaying() {
      if (!eligible()) {
        stopPlayback();
        return;
      }
      if (!sourceLoaded || sourceExhausted || video.paused) return;
      const firstPlayingEvent = !playing;
      playing = true;
      autoplayBlocked = false;
      onBlocked(false);
      video.style.opacity = "1";
      if (firstPlayingEvent) onPlaying();
    }

    function nextSource() {
      stopPlayback();
      sourceLoaded = false;
      sourceIndex += 1;
      if (sourceIndex >= candidates.length) {
        sourceExhausted = true;
        return;
      }
      autoplayBlocked = false;
      sourceLoaded = true;
      video.src = candidates[sourceIndex];
      video.load();
      if (eligible()) requestPlay();
    }

    function requestPlay() {
      if (!eligible() || !sourceLoaded || sourceExhausted || pendingAttempt !== null) return;
      if (!video.paused && playing) return;

      const currentAttempt = ++attempt;
      pendingAttempt = currentAttempt;
      let result;
      try {
        // Keep this call inside the ordinary interaction handler: Safari needs the gesture.
        result = video.play();
      } catch (error) {
        rejectPlay(error, currentAttempt);
        return;
      }
      Promise.resolve(result).then(() => {
        if (currentAttempt !== attempt) return;
        pendingAttempt = null;
        if (!eligible()) {
          stopPlayback();
          return;
        }
        // "playing" normally fires first; the promise also covers an already-playing video.
        if (!video.paused && video.readyState >= 2) markPlaying();
      }, (error) => rejectPlay(error, currentAttempt));
    }

    function rejectPlay(error, currentAttempt) {
      if (currentAttempt !== attempt) return;
      pendingAttempt = null;
      if (!eligible()) {
        stopPlayback();
        return;
      }
      if (error && error.name === "NotSupportedError") {
        nextSource();
        return;
      }
      // Keep the existing frame fallback visible until a permitted interaction.
      autoplayBlocked = true;
      onBlocked(error?.name === "NotAllowedError");
      playing = false;
      video.style.opacity = "0";
    }

    function sync() {
      if (!eligible()) {
        stopPlayback();
        return;
      }
      if (!sourceLoaded && !sourceExhausted) nextSource();
      else if (!autoplayBlocked) requestPlay();
      else onBlocked(true);
    }

    listen(video, "playing", markPlaying);
    listen(video, "error", () => {
      if (!sourceLoaded || sourceExhausted) return;
      nextSource();
    });
    function resumeFromGesture() {
      if (!eligible() || sourceExhausted || pendingAttempt !== null) return;
      autoplayBlocked = false;
      sync();
    }
    // The visible play button and ordinary page taps both retain Safari's user gesture.
    ["touchend", "click", "keydown"].forEach((type) => listen(doc, type, resumeFromGesture, true));
    listen(doc, "visibilitychange", sync);
    listen(win, "pagehide", () => { pageHidden = true; sync(); });
    listen(win, "pageshow", () => { pageHidden = false; sync(); });

    function destroy() {
      disposed = true;
      listeners.forEach((remove) => remove());
      stopPlayback();
    }
    return Object.freeze({ sync, destroy });
  }

  // Preserve the desktop behavior approved before the mobile revisions:
  // wait for canplay, prefer WebM, retire once beyond 4px, fade before pausing.
  function createDesktop(options) {
    const video = options.video;
    const sources = options.sources || {};
    const win = video.ownerDocument.defaultView || root;
    const hasUserScrolled = options.hasUserScrolled || (() => false);
    const scrollY = options.scrollY || (() => win.scrollY || 0);
    const candidates = [];
    if (sources.webm && video.canPlayType("video/webm")) candidates.push(sources.webm);
    if (sources.mp4) candidates.push(sources.mp4);
    let started = false;
    let retired = false;
    let disposed = false;
    let candidateIndex = 0;
    let pauseTimer = null;
    let cleanup = () => {};
    let pending = false;
    const doc = video.ownerDocument;
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    function requestPlay() {
      if (retired || disposed || doc.hidden || hasUserScrolled() || pending || video.readyState < 2
        || (options.canPlay && !options.canPlay())) return;
      if (!video.paused) return;
      pending = true;
      let result;
      try { result = video.play(); } catch (error) { result = Promise.reject(error); }
      Promise.resolve(result).then(() => {
        pending = false;
        if (retired || disposed || doc.hidden) { video.pause(); return; }
        video.style.opacity = "1";
        options.onBlocked?.(false);
        options.onPlaying?.();
      }, (error) => {
        pending = false;
        if (!retired && !disposed) options.onBlocked?.(error?.name === "NotAllowedError");
      });
    }
    const gestures = ["touchend", "click", "keydown"];
    gestures.forEach(type => doc.addEventListener(type, requestPlay, true));

    function nextSource() {
      const candidate = candidates[candidateIndex++];
      if (!candidate || retired || disposed) return;
      const onReady = () => {
        cleanup();
        if (retired || disposed || hasUserScrolled()) return;
        requestPlay();
      };
      const onError = () => { cleanup(); nextSource(); };
      cleanup = () => {
        video.removeEventListener("canplay", onReady);
        video.removeEventListener("error", onError);
      };
      video.addEventListener("canplay", onReady, { once: true });
      video.addEventListener("error", onError, { once: true });
      video.src = candidate;
      video.load();
    }

    function sync() {
      if (disposed) return;
      if (!started) {
        started = true;
        if (!hasUserScrolled() && sources.enabled !== false) nextSource();
      }
      if (hasUserScrolled() && scrollY() > 4 && !retired) {
        retired = true;
        options.onBlocked?.(false);
        video.style.opacity = "0";
        pauseTimer = win.setTimeout(() => { try { video.pause(); } catch (_) {} }, 500);
      }
    }

    function destroy() {
      disposed = true;
      gestures.forEach(type => doc.removeEventListener(type, requestPlay, true));
      options.onBlocked?.(false);
      cleanup();
      if (pauseTimer !== null) win.clearTimeout(pauseTimer);
      video.style.opacity = "0";
      video.pause();
    }
    return Object.freeze({ sync, destroy });
  }

  function createResponsive(options) {
    let compact = null;
    let controller = null;
    function sync() {
      const nextCompact = Boolean(options.isCompactMode());
      if (nextCompact !== compact) {
        controller?.destroy();
        compact = nextCompact;
        controller = compact ? create(options) : createDesktop(options);
      }
      controller.sync();
    }
    function destroy() { controller?.destroy(); controller = null; compact = null; }
    return Object.freeze({ sync, destroy });
  }

  root.AlviHeroIdle = Object.freeze({ create, createDesktop, createResponsive });
})(window);
