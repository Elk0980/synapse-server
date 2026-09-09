/* Opening video follows the visible scene, with a manual fallback for autoplay. */
(function (root) {
  "use strict";

  function create(options) {
    const video = options.video;
    const button = options.button;
    const sources = options.sources || {};
    const canPlay = options.canPlay || (() => true);
    const onPlaying = options.onPlaying || (() => {});
    const doc = video.ownerDocument;
    const win = doc.defaultView || root;
    const formats = options.isIOS ? ["mp4", "webm"] : ["webm", "mp4"];
    const candidates = formats
      .filter((format) => sources[format] && video.canPlayType("video/" + format))
      .map((format) => sources[format]);

    let sourceIndex = -1;
    let sourceLoaded = false;
    let sourceExhausted = false;
    let pageHidden = false;
    let autoplayBlocked = false;
    let playing = false;
    let attempt = 0;
    let pendingAttempt = null;

    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.loop = true;
    video.preload = "auto";
    video.setAttribute("muted", "");
    video.setAttribute("playsinline", "");

    function eligible() {
      return !pageHidden && !doc.hidden && Boolean(canPlay());
    }

    function updateButton() {
      if (button) button.hidden = !(eligible() && autoplayBlocked && !sourceExhausted);
    }

    function stopPlayback() {
      const wasPending = pendingAttempt !== null;
      attempt += 1;
      pendingAttempt = null;
      playing = false;
      video.style.opacity = "0";
      if (wasPending || !video.paused) video.pause();
      if (button) button.hidden = true;
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
      video.style.opacity = "1";
      updateButton();
      if (firstPlayingEvent) onPlaying();
    }

    function nextSource() {
      stopPlayback();
      sourceLoaded = false;
      sourceIndex += 1;
      if (sourceIndex >= candidates.length) {
        sourceExhausted = true;
        updateButton();
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
        // Keep this call synchronous with a manual click: Safari needs the gesture.
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
      // A denied or interrupted attempt must never leave an unexplained still image.
      autoplayBlocked = true;
      playing = false;
      video.style.opacity = "0";
      updateButton();
    }

    function sync() {
      if (!eligible()) {
        stopPlayback();
        return;
      }
      if (!sourceLoaded && !sourceExhausted) nextSource();
      else if (!autoplayBlocked) requestPlay();
      updateButton();
    }

    video.addEventListener("playing", markPlaying);
    video.addEventListener("error", () => {
      if (!sourceLoaded || sourceExhausted) return;
      nextSource();
    });
    if (button) {
      button.hidden = true;
      button.addEventListener("click", () => {
        autoplayBlocked = false;
        sync();
      });
    }
    doc.addEventListener("visibilitychange", sync);
    win.addEventListener("pagehide", () => { pageHidden = true; sync(); });
    win.addEventListener("pageshow", () => { pageHidden = false; sync(); });

    return Object.freeze({ sync });
  }

  root.AlviHeroIdle = Object.freeze({ create });
})(window);
