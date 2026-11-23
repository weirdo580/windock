import { onBeforeUnmount } from 'vue';

/**
 * 低频拉取桌面缩略图。防重入，上一帧还没解码完就不再请求下一帧。
 */
export function useDesktopCapture(options = {}) {
  const { interval = 180, onImage } = options;
  let timer = null;
  let busy = false;
  let stopped = true;

  async function tick() {
    if (busy || stopped) return;
    const api = window.dockApi;
    if (!api) return;
    busy = true;
    try {
      const frame = await api.capture();
      if (!frame || !frame.dataUrl) {
        busy = false;
        return;
      }
      const img = new Image();
      img.onload = () => {
        busy = false;
        if (typeof onImage === 'function') onImage(img, frame);
      };
      img.onerror = () => { busy = false; };
      img.src = frame.dataUrl;
    } catch (err) {
      busy = false;
    }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    tick();
    timer = setInterval(tick, Math.max(16, interval));
  }

  function stop() {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  onBeforeUnmount(stop);

  return { start, stop };
}
