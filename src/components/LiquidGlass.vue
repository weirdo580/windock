<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
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
  winInfo: { type: Object, default: () => ({}) }
});

const emit = defineEmits(['fallback']);
const filterId = `liquid-glass-${Math.random().toString(36).slice(2, 10)}`;
const videoRef = ref(null);
const liveReady = ref(false);
const fallbackReady = ref(false);
const fallbackUrl = ref('');
const fallbackDisplay = ref(null);
const fallbackStrip = ref(null);

let stream = null;
let fallbackCapture = null;
let fallbackTimer = 0;
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
const saturationPct = computed(() => Math.max(80, numberOr(glassConfig.value.saturation, 1.3) * 100));
const tintColor = computed(() => {
  const alpha = Math.max(0, Math.min(0.4, numberOr(glassConfig.value.opacity, 0.05)));
  return `rgba(255,255,255,${alpha.toFixed(3)})`;
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
  return {
    left: `${geometry.left - p.x}px`,
    top: `${geometry.top - p.y}px`,
    width: `${geometry.width}px`,
    height: `${geometry.height}px`
  };
});

const fallbackSourceStyle = computed(() => {
  const p = panel.value;
  const geometry = displayGeometry(fallbackDisplay.value);
  const strip = fallbackStrip.value;
  const image = fallbackUrl.value ? `url("${fallbackUrl.value}")` : 'none';
  if (!p) return {};
  if (strip) {
    return {
      left: `${geometry.left - p.x}px`,
      top: `${geometry.top + strip.y - p.y}px`,
      width: `${geometry.width}px`,
      height: `${strip.height}px`,
      backgroundImage: image
    };
  }
  return {
    left: `${geometry.left - p.x}px`,
    top: `${geometry.top - p.y}px`,
    width: `${geometry.width}px`,
    height: `${geometry.height}px`,
    backgroundImage: image
  };
});

const warpStyle = computed(() => ({
  filter: `url(#${filterId})`,
  backdropFilter: `blur(${blurPx.value}px) saturate(${saturationPct.value}%)`,
  WebkitBackdropFilter: `blur(${blurPx.value}px) saturate(${saturationPct.value}%)`,
  backgroundColor: tintColor.value
}));

function startFallback() {
  if (!alive || fallbackCapture) return;
  fallbackCapture = useDesktopCapture({
    interval: 33,
    onImage(_img, frame) {
      if (!alive || liveReady.value) return;
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



onMounted(startFallback);

onBeforeUnmount(() => {
  alive = false;
  clearTimeout(fallbackTimer);
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
      </defs>
    </svg>

    <div
      v-if="panel"
      class="liquid-panel"
      :class="{ 'is-ready': liveReady || fallbackReady }"
      :style="panelStyle"
    >
      <video
        ref="videoRef"
        v-show="liveReady"
        class="screen-source live-screen"
        :style="liveSourceStyle"
        autoplay
        muted
        playsinline
      ></video>
      <div
        v-show="!liveReady && fallbackReady"
        class="screen-source fallback-screen"
        :style="fallbackSourceStyle"
      ></div>
      <span class="liquid-warp" :style="warpStyle"></span>
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

.fallback-screen {
  background-repeat: no-repeat;
  background-size: 100% 100%;
}
</style>
