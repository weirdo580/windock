<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useDesktopCapture } from '../composables/useDesktopCapture.js';

/**
 * DOM port of rdev/liquid-glass-react's glass renderer.
 * The original SVG displacement filter is preserved; its backdrop is fed by a
 * live display stream so desktop changes appear in real time.
 */
const props = defineProps({
  panels: { type: Array, default: () => [] },
  pointer: { type: Object, default: () => ({ x: 0, y: 0 }) },
  glass: { type: Object, default: () => ({}) },
  winInfo: { type: Object, default: () => ({}) },
  captureOffset: { type: Number, default: 0 }
});

const emit = defineEmits(['fallback']);
// 真透明模式：玻璃不再铺一张桌面截图，而是让窗口后面的真实桌面直接透出来。
// 这样壁纸位置与桌面完全一致，也不会把 Dock/悬浮提示拍进玻璃里。
const CLEAR_GLASS = true;
const filterId = `liquid-glass-${Math.random().toString(36).slice(2, 10)}`;
const refractionFilterId = `liquid-refraction-${Math.random().toString(36).slice(2, 10)}`;
const videoRef = ref(null);
const liveReady = ref(false);
const fallbackReady = ref(false);
const fallbackUrl = ref('');
const fallbackDisplay = ref(null);
const fallbackStrip = ref(null);

let stream = null;
let fallbackCapture = null;
let fallbackTimer = 0;
let offCaptureReset = null;
let alive = true;
let liveFrameCount = 0;

const panel = computed(() => {
  const list = Array.isArray(props.panels) ? props.panels : [];
  return list.find(item => Number(item.h) >= 50) || null;
});

const glassConfig = computed(() => props.glass || {});

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// 设置页里的“边缘折射 / 边缘高光 / 背景模糊”直接驱动同一层玻璃。
const displacementScale = computed(() => {
  const direct = Number(glassConfig.value.displacementScale);
  if (Number.isFinite(direct)) return direct;
  return Math.max(0, numberOr(glassConfig.value.refraction, 0.52) * 135);
});
const aberrationIntensity = computed(() => {
  const direct = Number(glassConfig.value.aberrationIntensity);
  if (Number.isFinite(direct)) return direct;
  return Math.max(0, numberOr(glassConfig.value.fresnel, 0.86) * 2.326);
});
const blurPx = computed(() => {
  const direct = Number(glassConfig.value.blurAmount);
  if (Number.isFinite(direct)) return Math.max(0, 7 + direct * 32);
  return Math.max(0, numberOr(glassConfig.value.blur, 0.9) * 8);
});
const tintColor = computed(() => {
  const alpha = Math.max(0, Math.min(0.4, numberOr(glassConfig.value.opacity, 0.05)));
  return `rgba(255,255,255,${alpha.toFixed(3)})`;
});

 // 背景模糊只在离开默认值时才铺一层“真实桌面”的模糊副本；
// 默认值（0）下这层完全不显示，Dock 保持现在的真透明。
const effectStrength = computed(() => {
  const blur = Math.max(0, numberOr(glassConfig.value.blur, 0));
  return Math.min(1, blur / 1.2);
});
const effectActive = computed(() => {
  const blur = Math.max(0, numberOr(glassConfig.value.blur, 0));
  return blur > 0.05;
});
// 背景采样切换保护状态时，旧帧里还带着 Dock 图标；等第一帧“干净”的桌面图到了
// 再把效果层显示出来，避免切换时闪一下彩色重影。
const effectReady = ref(true);
let effectReadyTimer = 0;
let minCaptureAt = 0;
function delayEffectReady() {
  effectReady.value = false;
  clearTimeout(effectReadyTimer);
  effectReadyTimer = setTimeout(() => {
    effectReady.value = true;
  }, 240);
}
watch(effectActive, (active, was) => {
  if (active && !was) delayEffectReady();
  else if (!active) {
    clearTimeout(effectReadyTimer);
    effectReady.value = true;
  }
});
const effectLayerStyle = computed(() => {
  const s = effectStrength.value;
  const blurSetting = Math.max(0, numberOr(glassConfig.value.blur, 0));
  // 极小数值不算开启，避免 0.02 这种“没设置”的状态把整块桌面图贴上来。
  if (blurSetting <= 0.05) return { opacity: 0 };
  if (!effectReady.value) {
    // 保护状态刚切换时先拿旧帧做一层高模糊的中性背景，
    // 不让图标轮廓可辨，等干净帧到了再切回正式效果。
    const preFilter = 'blur(24px)';
    return { opacity: '0.6', filter: preFilter, WebkitFilter: preFilter };
  }
  const layerBlur = Math.max(4, Math.min(40, Math.round(blurSetting * 16)));
  const filter = `blur(${layerBlur}px)`;
  const opacity = Math.min(1, 0.55 + s * 0.45);
  return {
    opacity: opacity.toFixed(3),
    filter,
    WebkitFilter: filter
  };
});
// 边缘折射只作用在玻璃最外圈：用同一张桌面画面做一层边缘位移，
// 中间区域保持原画面，这样只影响“靠近边缘时的背景弯曲”。
const refractionScale = computed(() => Math.max(0, numberOr(glassConfig.value.refraction, 0) * 140));
const refractionActive = computed(() => refractionScale.value > 0.5);
const refractionZoom = computed(() => 1 + Math.max(0, numberOr(glassConfig.value.refraction, 0)) * 0.06);
const refractionFilterStyle = computed(() => (
  refractionActive.value
    ? { filter: `url(#${refractionFilterId})`, WebkitFilter: `url(#${refractionFilterId})` }
    : {}
));
// 背景本身是柔和的云层时，单纯位移不容易被看见；给最外圈加一层随折射增强的
// 极轻内阴影，让玻璃边缘的“弯折感”在浅色背景上也能看出来。
const refractionRimStyle = computed(() => {
  const r = Math.max(0, numberOr(glassConfig.value.refraction, 0));
  if (r <= 0.02) return {};
  const blur = Math.round(4 + r * 16);
  const alpha = Math.min(0.26, 0.04 + r * 0.2);
  return {
    boxShadow: `inset 0 0 ${blur}px rgba(30, 22, 16, ${alpha.toFixed(3)})`
  };
});
const edgeMaskStyle = computed(() => {
  const p = panel.value;
  if (!p) return {};
  const w = Math.max(1, Math.round(p.w));
  const h = Math.max(1, Math.round(p.h));
  const radius = Math.max(0, Number(p.radius ?? 26));
  const band = Math.max(10, Math.min(26, Math.round(h * 0.42)));
  const innerW = Math.max(1, w - band * 2);
  const innerH = Math.max(1, h - band * 2);
  const innerR = Math.max(0, radius - band * 0.7);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><mask id="edge"><rect width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="#fff"/><rect x="${band}" y="${band}" width="${innerW}" height="${innerH}" rx="${innerR}" ry="${innerR}" fill="#000"/></mask></defs><rect width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="#fff" mask="url(#edge)"/></svg>`;
  const image = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  return {
    maskImage: image,
    WebkitMaskImage: image,
    maskSize: '100% 100%',
    WebkitMaskSize: '100% 100%',
    maskRepeat: 'no-repeat',
    WebkitMaskRepeat: 'no-repeat'
  };
});


const panelStyle = computed(() => {
  const p = panel.value;
  if (!p) return {};
  return {
    left: `${p.x}px`,
    top: `${p.y}px`,
    width: `${p.w}px`,
    height: `${p.h}px`,
    borderRadius: `${p.radius ?? 26}px`
  };
});

function displayGeometry(display) {
  const bounds = props.winInfo?.bounds || {};
  const sourceDisplay = display || props.winInfo?.display || {};
  const x = Number(sourceDisplay.x) || 0;
  const y = Number(sourceDisplay.y) || 0;
  const width = Number(sourceDisplay.width) || window.innerWidth;
  const height = Number(sourceDisplay.height) || window.innerHeight;
  return {
    left: x - (Number(bounds.x) || 0),
    top: y - (Number(bounds.y) || 0),
    width,
    height
  };
}

const liveSourceStyle = computed(() => {
  const p = panel.value;
  const geometry = displayGeometry(props.winInfo?.display);
  if (!p) return {};
  const left = geometry.left - p.x;
  const top = geometry.top - p.y;
  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${geometry.width}px`,
    height: `${geometry.height}px`,
    ...(refractionActive.value
      ? {
          transform: `scale(${refractionZoom.value})`,
          transformOrigin: `${p.w / 2 - left}px ${p.h / 2 - top}px`
        }
      : {})
  };
});

const fallbackSourceStyle = computed(() => {
  const p = panel.value;
  const geometry = displayGeometry(fallbackDisplay.value);
  const strip = fallbackStrip.value;
  const image = fallbackUrl.value ? `url("${fallbackUrl.value}")` : 'none';
  if (!p) return {};
  if (strip) {
    const left = geometry.left - p.x;
    const top = geometry.top + strip.y - p.y;
    return {
      left: `${left}px`,
      top: `${top}px`,
      width: `${geometry.width}px`,
      height: `${strip.height}px`,
      backgroundImage: image,
      ...(refractionActive.value
        ? {
            transform: `scale(${refractionZoom.value})`,
            transformOrigin: `${p.w / 2 - left}px ${p.h / 2 - top}px`
          }
        : {})
    };
  }
  const left = geometry.left - p.x;
  const top = geometry.top - p.y;
  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${geometry.width}px`,
    height: `${geometry.height}px`,
    backgroundImage: image,
    ...(refractionActive.value
      ? {
          transform: `scale(${refractionZoom.value})`,
          transformOrigin: `${p.w / 2 - left}px ${p.h / 2 - top}px`
        }
      : {})
  };
});

const warpStyle = computed(() => {
  if (CLEAR_GLASS) {
    // 只保留一层几乎看不见的玻璃色，背景完全交给真实桌面。
    return { backgroundColor: tintColor.value };
  }
  return {
    filter: `url(#${filterId})`,
    backdropFilter: `blur(${blurPx.value}px)`,
    WebkitBackdropFilter: `blur(${blurPx.value}px)`,
    backgroundColor: tintColor.value
  };
});

const glassReady = computed(() => CLEAR_GLASS || liveReady.value || fallbackReady.value);

function startFallback() {
  if (!alive || fallbackCapture) return;
  fallbackCapture = useDesktopCapture({
    interval: 33,
    onImage(_img, frame) {
      if (!alive || liveReady.value) return;
      const capturedAt = Number(frame.capturedAt) || 0;
      if (capturedAt && capturedAt < minCaptureAt) return;
      fallbackUrl.value = frame.dataUrl;
      fallbackDisplay.value = frame.display || null;
      fallbackStrip.value = frame.strip || null;
      fallbackReady.value = true;
    }
  });
  fallbackCapture.start();
}

async function useLiveDisplay(mediaStream) {
  if (!alive) {
    mediaStream.getTracks().forEach(track => track.stop());
    return;
  }
  stream = mediaStream;
  if (fallbackCapture) {
    fallbackCapture.stop();
    fallbackCapture = null;
  }
  clearTimeout(fallbackTimer);
  await nextTick();
  const video = videoRef.value;
  if (!video) return;
  video.srcObject = mediaStream;
  video.muted = true;
  try {
    await video.play();
    liveReady.value = true;
    fallbackReady.value = false;
    const markFrame = () => {
      if (!alive || stream !== mediaStream) return;
      liveFrameCount += 1;
      video.dataset.liveFrames = String(liveFrameCount);
      video.requestVideoFrameCallback(markFrame);
    };
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(markFrame);
  } catch (err) {
    startFallback();
  }
}



onMounted(() => {
  startFallback();
  if (window.dockApi && window.dockApi.onCaptureReset) {
    offCaptureReset = window.dockApi.onCaptureReset(payload => {
      const at = Number(payload && payload.at) || Date.now();
      minCaptureAt = at;
      delayEffectReady();
    });
  }
});

onBeforeUnmount(() => {
  alive = false;
  clearTimeout(fallbackTimer);
  clearTimeout(effectReadyTimer);
  if (typeof offCaptureReset === 'function') offCaptureReset();
  if (fallbackCapture) fallbackCapture.stop();
  if (stream) stream.getTracks().forEach(track => track.stop());
  if (videoRef.value) videoRef.value.srcObject = null;
});
</script>

<template>
  <div class="glass-layer" aria-hidden="true">
    <svg class="liquid-filter-defs">
      <defs>
        <filter
          :id="filterId"
          x="-35%"
          y="-35%"
          width="170%"
          height="170%"
          color-interpolation-filters="sRGB"
        >
          <feImage
            x="0"
            y="0"
            width="100%"
            height="100%"
            result="DISPLACEMENT_MAP"
            href="./liquid-glass-displacement.jpg"
            preserveAspectRatio="xMidYMid slice"
          />
          <feColorMatrix
            in="DISPLACEMENT_MAP"
            type="matrix"
            values="0.3 0.3 0.3 0 0
                    0.3 0.3 0.3 0 0
                    0.3 0.3 0.3 0 0
                    0 0 0 1 0"
            result="EDGE_INTENSITY"
          />
          <feComponentTransfer in="EDGE_INTENSITY" result="EDGE_MASK">
            <feFuncA type="discrete" :tableValues="`0 ${aberrationIntensity * 0.05} 1`" />
          </feComponentTransfer>
          <feOffset in="SourceGraphic" dx="0" dy="0" result="CENTER_ORIGINAL" />

          <feDisplacementMap
            in="SourceGraphic"
            in2="DISPLACEMENT_MAP"
            :scale="-displacementScale"
            xChannelSelector="R"
            yChannelSelector="B"
            result="RED_DISPLACED"
          />
          <feColorMatrix
            in="RED_DISPLACED"
            type="matrix"
            values="1 0 0 0 0
                    0 0 0 0 0
                    0 0 0 0 0
                    0 0 0 1 0"
            result="RED_CHANNEL"
          />

          <feDisplacementMap
            in="SourceGraphic"
            in2="DISPLACEMENT_MAP"
            :scale="-displacementScale * (1 - aberrationIntensity * 0.05)"
            xChannelSelector="R"
            yChannelSelector="B"
            result="GREEN_DISPLACED"
          />
          <feColorMatrix
            in="GREEN_DISPLACED"
            type="matrix"
            values="0 0 0 0 0
                    0 1 0 0 0
                    0 0 0 0 0
                    0 0 0 1 0"
            result="GREEN_CHANNEL"
          />

          <feDisplacementMap
            in="SourceGraphic"
            in2="DISPLACEMENT_MAP"
            :scale="-displacementScale * (1 - aberrationIntensity * 0.1)"
            xChannelSelector="R"
            yChannelSelector="B"
            result="BLUE_DISPLACED"
          />
          <feColorMatrix
            in="BLUE_DISPLACED"
            type="matrix"
            values="0 0 0 0 0
                    0 0 0 0 0
                    0 0 1 0 0
                    0 0 0 1 0"
            result="BLUE_CHANNEL"
          />

          <feBlend in="GREEN_CHANNEL" in2="BLUE_CHANNEL" mode="screen" result="GB_COMBINED" />
          <feBlend in="RED_CHANNEL" in2="GB_COMBINED" mode="screen" result="RGB_COMBINED" />
          <feGaussianBlur
            in="RGB_COMBINED"
            :stdDeviation="Math.max(0.1, 0.5 - aberrationIntensity * 0.1)"
            result="ABERRATED_BLURRED"
          />
          <feComposite in="ABERRATED_BLURRED" in2="EDGE_MASK" operator="in" result="EDGE_ABERRATION" />
          <feComponentTransfer in="EDGE_MASK" result="INVERTED_MASK">
            <feFuncA type="table" tableValues="1 0" />
          </feComponentTransfer>
          <feComposite in="CENTER_ORIGINAL" in2="INVERTED_MASK" operator="in" result="CENTER_CLEAN" />
          <feComposite in="EDGE_ABERRATION" in2="CENTER_CLEAN" operator="over" />
        </filter>

        <filter
          :id="refractionFilterId"
          x="0"
          y="0"
          width="100%"
          height="100%"
          color-interpolation-filters="sRGB"
        >
          <feImage
            x="0"
            y="0"
            width="100%"
            height="100%"
            result="REFRACTION_MAP"
            href="./liquid-glass-displacement.jpg"
            preserveAspectRatio="xMidYMid slice"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="REFRACTION_MAP"
            :scale="-refractionScale"
            xChannelSelector="R"
            yChannelSelector="B"
          />
        </filter>
      </defs>
    </svg>

    <div
      v-if="panel"
      class="liquid-panel"
      :class="{ 'is-ready': glassReady }"
      :style="panelStyle"
    >
      <div class="effect-window">
        <video
          ref="videoRef"
          v-show="liveReady"
          class="screen-source live-screen"
          :style="[liveSourceStyle, effectLayerStyle]"
          autoplay
          muted
          playsinline
        ></video>
        <div
          v-show="!liveReady && fallbackReady"
          class="screen-source fallback-screen"
          :style="[fallbackSourceStyle, effectLayerStyle]"
        ></div>
      </div>
      <div
        v-if="!CLEAR_GLASS && refractionActive && !liveReady && fallbackReady"
        class="refraction-edge"
        :style="[edgeMaskStyle, refractionFilterStyle]"
      >
        <div class="screen-source fallback-screen" :style="fallbackSourceStyle"></div>
      </div>
      <span class="liquid-warp" :style="warpStyle"></span>
      <span
        v-if="!CLEAR_GLASS && refractionActive"
        class="refraction-rim"
        :style="refractionRimStyle"
      ></span>
    </div>
  </div>
</template>

<style scoped>
.glass-layer {
  position: fixed;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  z-index: 2;
}

.liquid-filter-defs {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
}

.liquid-panel {
  position: absolute;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  isolation: isolate;
  transform: translateZ(0);
  transition: opacity 180ms ease;
}

.liquid-panel.is-ready {
  opacity: 1;
}

.liquid-warp {
  position: absolute;
  inset: 0;
  overflow: hidden;
  will-change: filter;
  transform: translateZ(0);
}

.screen-source {
  position: absolute;
  display: block;
  max-width: none;
  max-height: none;
  object-fit: fill;
  pointer-events: none;
}

.effect-window {
  position: absolute;
  inset: 0;
  overflow: hidden;
  border-radius: inherit;
  pointer-events: none;
}

.effect-window .screen-source {
  transition: opacity 120ms ease-out;
}

.refraction-edge {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.refraction-rim {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
}

.fallback-screen {
  background-repeat: no-repeat;
  background-size: 100% 100%;
}
</style>
