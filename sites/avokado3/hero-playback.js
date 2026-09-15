/* Retry denied opening playback within a real tap; keep the photo until video plays. */
(function (root) {
  'use strict';
  function create(video, button, canPlay, onFallback) {
    var doc = video.ownerDocument, pending = false, blocked = false, attempt = 0;
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    function hideButton() { if (button) button.hidden = true; }
    function failed(error, id) {
      if (id !== attempt) return;
      pending = false;
      blocked = Boolean(error && error.name === 'NotAllowedError');
      if (button) button.hidden = !blocked || !canPlay() || doc.hidden;
      onFallback();
    }
    function play(gesture) {
      if (!canPlay() || doc.hidden || pending) return;
      if (blocked && !gesture) { if (button) button.hidden = false; return; }
      if (!video.paused) return;
      var id = ++attempt;
      pending = true;
      var result;
      try { result = video.play(); } catch (error) { failed(error, id); return; }
      Promise.resolve(result).then(function () {
        if (id !== attempt) return;
        pending = false;
        blocked = false;
        hideButton();
      }, function (error) { failed(error, id); });
    }
    function cancel() { attempt++; pending = false; hideButton(); }
    video.addEventListener('playing', function () { blocked = false; hideButton(); });
    ['touchend', 'click', 'keydown'].forEach(function (name) {
      doc.addEventListener(name, function () { play(true); }, { capture: true });
    });
    return { play: function () { play(false); }, cancel: cancel };
  }
  root.AvokadoHeroPlayback = { create: create };
})(window);
