'use strict';

// 音檔播放器：部分嵌入環境（例如 claude.ai 頁面）不允許 <audio> 直接載入檔案網址，
// 所以先用 fetch 取回檔案轉成 blob 網址播放；若 <audio> 仍無法播放，改用 Web Audio。
// iOS 只允許在點擊當下開始播放，因此音檔要事先 prefetch，點擊時才能同步呼叫 play()。
const Player = (() => {
  const el = new Audio();
  const blobs = new Map();    // url -> blob url（已下載完成）
  const pending = new Map();  // url -> Promise<blob url>
  const buffers = new Map();  // url -> AudioBuffer（Web Audio 用）
  let ctx = null;
  let source = null;
  let token = 0;              // 每次 play/stop 遞增，丟棄過期的非同步結果
  let onEnd = null;

  function prefetch(url) {
    if (blobs.has(url)) return Promise.resolve(blobs.get(url));
    if (!pending.has(url)) {
      pending.set(url, fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.blob();
        })
        .then((b) => {
          const u = URL.createObjectURL(b);
          blobs.set(url, u);
          return u;
        })
        .finally(() => pending.delete(url)));
    }
    return pending.get(url);
  }

  // 必須在點擊事件內同步呼叫，iOS 才會允許之後的 Web Audio 發聲
  function unlock() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!ctx) ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  function stopAll() {
    el.pause();
    if (source) {
      source.onended = null;
      try { source.stop(); } catch { /* already stopped */ }
      source = null;
    }
  }

  function stop() {
    token++;
    stopAll();
  }

  async function playWebAudio(url, my) {
    if (!ctx) throw new Error('此瀏覽器不支援 Web Audio');
    if (ctx.state === 'suspended') await ctx.resume();
    let buf = buffers.get(url);
    if (!buf) {
      const blobUrl = await prefetch(url);
      const data = await (await fetch(blobUrl)).arrayBuffer();
      buf = await new Promise((res, rej) => ctx.decodeAudioData(data, res, rej));
      buffers.set(url, buf);
    }
    if (my !== token) return;
    source = ctx.createBufferSource();
    source.buffer = buf;
    source.connect(ctx.destination);
    source.onended = () => { if (my === token && onEnd) onEnd(); };
    source.start();
  }

  // 回傳 Promise：開始發聲時 resolve，全部方法都失敗時 reject（附錯誤原因）
  function play(url, { onended } = {}) {
    unlock();
    stopAll();
    const my = ++token;
    onEnd = onended || null;
    const viaElement = (src) => {
      el.src = src;
      el.currentTime = 0;
      return el.play();
    };
    const ready = blobs.get(url);
    const first = ready ? viaElement(ready) : prefetch(url).then((u) => (my === token ? viaElement(u) : undefined));
    return first.catch((e1) => {
      if (my !== token) return undefined;
      return playWebAudio(url, my).catch((e2) => {
        throw new Error(`${e1 && e1.name ? e1.name : e1} / ${e2 && e2.message ? e2.message : e2}`);
      });
    });
  }

  el.addEventListener('ended', () => { if (onEnd) onEnd(); });

  return { play, stop, prefetch, unlock };
})();
