<script setup>
import { reactive, ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';

const props = defineProps({
  left: { type: Number, default: 0 },
  bottom: { type: Number, default: 0 },
  width: { type: Number, default: 170 },
  height: { type: Number, default: 56 },
  dockHeight: { type: Number, default: 52 },
  // 由 Dock 舞台级指针命中算出的悬停状态（'' 或 'group'）
  hoverKind: { type: String, default: '' }
});

// 悬停只做“拉长一点点”：胶囊底横向拉伸约 6px、高 2px，图标尺寸不变
const CAP = { h: 25, gap: 5, pad: 6 };
const STRETCH = 6;

const st = ref(0);
let stVel = 0;
let sizeRaf = 0;

function stepStretch() {
  sizeRaf = 0;
  const target = props.hoverKind ? STRETCH : 0;
  stVel += (target - st.value) * 0.30;
  stVel *= 0.70;
  st.value += stVel;
  if (Math.abs(target - st.value) < 0.02 && Math.abs(stVel) < 0.02) {
    st.value = target;
    stVel = 0;
    return;
  }
  sizeRaf = requestAnimationFrame(stepStretch);
}
function startSizes() {
  if (!sizeRaf) sizeRaf = requestAnimationFrame(stepStretch);
}
watch(() => props.hoverKind, startSizes);

function groupStyle() {
  return {
    height: CAP.h + st.value * 0.34 + 'px',
    gap: CAP.gap + st.value * 0.17 + 'px',
    padding: '0 ' + (CAP.pad + st.value * 0.42) + 'px'
  };
}

const api = window.dockApi;

const state = reactive({
  volume: { level: null, muted: false },
  wifi: { connected: false, ssid: '', signal: 0 },
  battery: null,
  // 是否开着省电模式（拔电时电池图标转黄）
  powerSaver: false,
  // 这台电脑的硬件能力：没有无线网卡就不画 Wi-Fi 图标（电池靠 null 判断）
  caps: { battery: true, brightness: true, wifi: true, ime: true }
});

let timer = 0;
let offStatus = null;
let lastDataAt = 0;

function applyStatus(s) {
  if (!s) return;
  if (s.volume) state.volume = s.volume;
  if (s.wifi) state.wifi = s.wifi;
  if (typeof s.battery !== 'undefined') state.battery = s.battery;
  if (s.caps) state.caps = { ...state.caps, ...s.caps };
  if (s.power) state.powerSaver = s.power === 'saver';
  lastDataAt = Date.now();
}

async function refresh() {
  if (!api || !api.statusGet) return;
  // 主进程常驻进程正在推状态时就不用再单独拉一次
  if (Date.now() - lastDataAt < 2500) return;
  try { applyStatus(await api.statusGet()); } catch (err) { /* 保留上一次状态 */ }
}

const hopping = ref(false);
let hopTimer = 0;
let lastActAt = 0;
function act(e) {
  if (e) { e.stopPropagation(); e.preventDefault(); }
  // 连点两下会「开了又关」，看起来像没反应：这 260ms 内的第二次点击直接忽略
  const now = Date.now();
  if (now - lastActAt < 260) return;
  lastActAt = now;
  // 点击给整块胶囊一次很短的按压回弹（按下缩一点、松开弹回来），
  // 之前那套 1.16s 的 dock-bounce 太软太慢，点下去像卡住。
  hopping.value = false;
  clearTimeout(hopTimer);
  requestAnimationFrame(() => {
    hopping.value = true;
    hopTimer = setTimeout(() => { hopping.value = false; }, 240);
  });
  if (api && api.statusPanel) api.statusPanel();
}

// 气泡文案（走和左侧应用图标同一个玻璃气泡，不用系统原生 title）
const wifiLabel = computed(() => (state.wifi.connected ? 'Wi-Fi · ' + state.wifi.ssid : 'Wi-Fi'));
const volumeLabel = computed(() => (state.volume.muted ? '音量（已静音）' : '音量'));
const batteryLabel = computed(() => {
  const b = state.battery;
  if (!b) return '电池';
  const parts = ['电池 ' + b.percent + '%'];
  if (b.full || b.percent >= 100) parts.push('已充满');
  else if (b.charging) parts.push('充电中');
  else if (b.ac) parts.push('已接电源');
  if (!b.ac && state.powerSaver) parts.push('省电模式');
  return parts.join(' · ');
});

// 电池图标配色：插着电按电量走（≤20 红、>20 绿），拔掉电源纯白，拔电 + 省电模式变黄
const TONE = { low: '#ff453a', ok: '#30d158', saver: '#ffd60a', idle: '#ffffff' };
const batteryTone = computed(() => {
  const b = state.battery;
  if (!b) return 'idle';
  const plugged = typeof b.ac === 'boolean' ? b.ac : !!b.charging;
  if (plugged) return b.percent <= 20 ? 'low' : 'ok';
  return state.powerSaver ? 'saver' : 'idle';
});
const batteryColor = computed(() => TONE[batteryTone.value]);
// 电量占格子的比例；充满时格子铺满
const batteryFillPct = computed(() => {
  const b = state.battery;
  if (!b) return 0;
  if (b.full || b.percent >= 100) return 100;
  const p = Number(b.percent);
  return Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : 0;
});
const batteryFillW = computed(() => Math.max(1.1, 12.6 * batteryFillPct.value / 100));

const wifiBars = (sig) => {  if (!state.wifi.connected) return 0;
  if (sig >= 67) return 3;
  if (sig >= 33) return 2;
  return 1;
};
const volBars = (level) => {
  if (level === null || level === undefined) return 3;
  if (level >= 67) return 3;
  if (level >= 33) return 2;
  return 1;
};

onMounted(() => {
  refresh();
  // 主进程常驻状态进程每秒推送一次，图标随系统实时变化
  if (api && api.onStatus) offStatus = api.onStatus(applyStatus);
  timer = setInterval(refresh, 2000);
});
onBeforeUnmount(() => {
  clearInterval(timer);
  if (typeof offStatus === 'function') offStatus();
});
</script>

<template>
  <div
    class="status-tray"
    :style="{ left: left + 'px', bottom: bottom + 'px', width: width + 'px', height: height + 'px' }"
    @click="act($event)"
  >
    <!-- Wi-Fi / 音量 / 电池：共用一块底，视为一个整体；
         整块状态区（含图标之间的空隙、胶囊内边距）都能点开面板，不用瞄图标 -->
    <div class="status-group" :class="{ hop: hopping }" :style="groupStyle()">
      <button v-if="state.caps.wifi" class="status-item" data-kind="wifi" :data-label="wifiLabel">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
        <path v-if="wifiBars(state.wifi.signal) >= 1" d="M3.6 9.4a13.6 13.6 0 0 1 16.8 0" />
        <path v-if="wifiBars(state.wifi.signal) >= 2" d="M6.6 12.6a9.4 9.4 0 0 1 10.8 0" />
        <path v-if="wifiBars(state.wifi.signal) >= 3" d="M9.6 15.8a5.2 5.2 0 0 1 4.8 0" />
        <circle cx="12" cy="18.4" r="1.3" fill="currentColor" stroke="none" />
      </svg>
    </button>

    <button class="status-item" data-kind="volume" :data-label="volumeLabel">
      <svg v-if="state.volume.muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" fill="currentColor" stroke="none" />
        <path d="M15.5 9.5l5 5M20.5 9.5l-5 5" />
      </svg>
      <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" fill="currentColor" stroke="none" />
        <path v-if="volBars(state.volume.level) >= 2" d="M15.2 9.2a4.2 4.2 0 0 1 0 5.6" />
        <path v-if="volBars(state.volume.level) >= 3" d="M17.6 6.9a7.2 7.2 0 0 1 0 10.2" />
      </svg>
    </button>

    <button v-if="state.caps.battery && state.battery" class="status-item bat" data-kind="battery" :data-label="batteryLabel">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="8" width="16.4" height="8" rx="2.1" />
        <path d="M21.2 10.7v2.6" />
        <rect
          class="bat-fill"
          x="4.9"
          y="9.9"
          :width="batteryFillW"
          height="4.2"
          rx="1.1"
          :fill="batteryColor"
          stroke="none"
        />
        <path v-if="state.battery.charging" d="M13.1 9.3l-2.7 3.7h2.2l-1.5 3.3 3.7-4.2h-2.2l1.4-2.8z" fill="#ffffff" stroke="none" />
      </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.status-tray {
  position: absolute;
  box-sizing: border-box;
  display: flex;
  /* 状态胶囊按“整条 Dock 的中线”垂直居中：图标调大时 Dock 变高，
     它也跟着居中，而不是像原来那样贴着底边越沉越低 */
  align-items: center;
  gap: 7px;
  /* 左边不再留内边距：竖线改由 Dock 用标准分隔线绘制，胶囊紧贴分隔线，
     间距和音乐区两侧的竖线保持一致（垂直居中由 align-items 负责，不再靠底部 padding） */
  padding: 0;
  /* 整块状态区都可以点：图标之间的空隙、胶囊内边距不再是死区 */
  pointer-events: auto;
  cursor: pointer;
  color: rgba(255, 255, 255, 0.92);
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.45));
}

/* 命中区再往外扩一圈，点到胶囊边缘也能打开 */
.status-tray::before {
  content: '';
  position: absolute;
  inset: -7px -5px;
}

/* 悬停放大由脚本按和左侧应用图标同一套弹簧逐帧算宽高（见 sizeOf / stepSizes） */
.status-item {
  position: relative;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  padding: 0;
  margin: 0;
  color: inherit;
  pointer-events: auto;
  cursor: pointer;
  border-radius: 6px;
  outline: none;
  -webkit-tap-highlight-color: transparent;
  transform-origin: 50% 100%;
}

/* 图标只有 19px，鼠标稍微偏一点就点空：用不可见的伪元素把命中区放大到整个 Dock 高度 */
.status-item::before {
  content: '';
  position: absolute;
  inset: -11px -2px;
  border-radius: 8px;
}

/* 三个图标是一体的：悬停不给单个图标加方块，只在整块胶囊上做反馈 */
.status-item:active::before,
.status-item:hover {
  background: transparent;
}

.status-item:focus,
.status-item:focus-visible {
  outline: none;
  box-shadow: none;
}

.status-item:hover {
  background: transparent;
}

.status-item:active {
  background: transparent;
}

/* 点击整块胶囊：短促的按压回弹（按下缩一点、立刻弹回） */
.status-group.hop {
  animation: status-pop 220ms cubic-bezier(0.34, 0.7, 0.4, 1);
}

@keyframes status-pop {
  0% { transform: scale(1); }
  35% { transform: scale(0.9); }
  70% { transform: scale(1.02); }
  100% { transform: scale(1); }
}

/* 三个图标共用一块胶囊底，视觉上是一个整体 */
.status-group {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 5px;
  height: 25px;
  padding: 0 6px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.13);
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.18),
    inset 0 1px 0 rgba(255, 255, 255, 0.22);
  pointer-events: auto;
  overflow: visible;
  transition: background 160ms ease, box-shadow 160ms ease;
}

/* 悬停只拉长胶囊一点点，图标尺寸不变 */
.status-group .status-item {
  width: 18px;
  height: 18px;
}

.status-group .status-item.bat {
  width: 20px;
}

.status-group:hover {
  background: rgba(255, 255, 255, 0.17);
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.24),
    inset 0 1px 0 rgba(255, 255, 255, 0.28);
}

.status-group:active {
  background: rgba(255, 255, 255, 0.2);
}

.status-group .status-item svg {
  width: 100%;
  height: 100%;
  display: block;
}

.status-group .status-item.bat svg {
  width: 100%;
  height: 100%;
}

@media (prefers-color-scheme: dark) {
  .status-tray {
    color: rgba(255, 255, 255, 0.94);
  }
}
</style>
