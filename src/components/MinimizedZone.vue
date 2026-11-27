<script setup>
import { computed, ref, watch } from 'vue';
import { needsRoundedSquareFrame } from '../utils/iconShape.js';

const props = defineProps({
  items: { type: Array, default: () => [] },
  size: { type: Number, default: 56 },
  gap: { type: Number, default: 8 },
  scale: { type: Number, default: 1.4 },
  // 由 Dock 舞台级指针命中算出的当前悬停缩略图 handle（'' = 无）。
  // 必须以此为准：缩略图自己的 pointerenter 在透明窗口下会丢，导致玻璃变宽但图标不放大
  hoverId: { type: String, default: '' },
  // 由 Dock 传入当前正在弹跳的缩略图 handle（'' = 无），与左侧图标的 bouncingId 同源
  bounceH: { type: String, default: '' },
  left: { type: Number, default: 0 },
  bottom: { type: Number, default: 0 },
  width: { type: Number, default: 0 }
});

const emit = defineEmits(['restored', 'hover']);
const api = window.dockApi;
const iconCache = new Map();
const icons = ref({});
const iconStates = ref({});

function stateOf(handle) {
  return iconStates.value[String(handle)] || { ready: false, frame: false };
}

function onIconLoad(item, event) {
  const key = String(item.h);
  iconStates.value = {
    ...iconStates.value,
    [key]: {
      ready: true,
      frame: needsRoundedSquareFrame(event.currentTarget)
    }
  };
}

async function loadIcons() {
  if (!api || !api.extractIcon) return;
  const next = { ...icons.value };
  for (const it of props.items) {
    const key = String(it.h);
    const direct = String(it.icon || '');
    if (direct) {
      if (next[key] === direct) continue;
      next[key] = direct;
      if (iconStates.value[key]) {
        const nextStates = { ...iconStates.value };
        delete nextStates[key];
        iconStates.value = nextStates;
      }
      icons.value = { ...next };
      continue;
    }
    if (next[key] !== undefined) continue;
    next[key] = '';
    icons.value = { ...next };
    try {
      const exe = it.e || '';
      if (!exe) continue;
      let url = iconCache.get(exe);
      if (url === undefined) {
        url = (await api.extractIcon(exe)) || '';
        iconCache.set(exe, url);
      }
      next[key] = url;
      if (iconStates.value[key]) {
        const nextStates = { ...iconStates.value };
        delete nextStates[key];
        iconStates.value = nextStates;
      }
      icons.value = { ...next };
    } catch (err) { next[key] = ''; }
  }
}

watch(() => props.items.map(it => `${it.h}:${it.icon ? 'own' : ''}`).join(','), () => {
  const keep = {};
  for (const it of props.items) if (icons.value[it.h]) keep[it.h] = icons.value[it.h];
  icons.value = keep;
  const keepStates = {};
  for (const it of props.items) {
    const state = iconStates.value[String(it.h)];
    if (state) keepStates[String(it.h)] = state;
  }
  iconStates.value = keepStates;
  loadIcons();
}, { immediate: true });

const visible = computed(() => props.items.length > 0);
const bouncing = ref('');

// 新缩略图出现时的入场动画（不能用 transition-group：它会给每次尺寸变化都叠位移过渡，
// 导致悬停放大时底边往下漂）。这里只给新出现的项挂一个短动画，动画结束就摘掉。
const entering = ref(Object.fromEntries(props.items.map(it => [String(it.h), true])));
let prevKeys = new Set(props.items.map(it => String(it.h)));
const enterTimers = {};
function clearEntering(k) {
  const m = { ...entering.value };
  delete m[k];
  entering.value = m;
}
function markEntering(keys) {
  const next = { ...entering.value };
  keys.forEach(k => {
    next[k] = true;
    clearTimeout(enterTimers[k]);
    enterTimers[k] = setTimeout(() => clearEntering(k), 420);
  });
  entering.value = next;
}
// 组件挂载时（第一扇窗口最小化进来）也走一次入场动画
if (props.items.length) markEntering(props.items.map(it => String(it.h)));
watch(() => props.items.map(it => String(it.h)).join('|'), () => {
  const keys = props.items.map(it => String(it.h));
  const fresh = keys.filter(k => !prevKeys.has(k));
  prevKeys = new Set(keys);
  if (fresh.length) markEntering(fresh);
});

// 悬停放大不走 CSS，而是和左边应用图标同一套弹簧动画：
// 逐帧算尺寸（vel += (target-size)*0.30; vel *= 0.70；倍率 1.4），
// 因为宽高在动画，旁边的图标会跟着挪开，手感才和 Dock 图标一模一样
const sizes = ref({});
const vels = {};
const hoverH = ref('');
const activeH = computed(() => props.hoverId || hoverH.value);
watch(activeH, () => { startSizes(); });
const sizeMoving = ref(false);
let sizeRaf = 0;

function sizeOf(h) {
  const key = String(h);
  if (!sizes.value[key]) {
    sizes.value[key] = props.size;
    vels[key] = 0;
  }
  return sizes.value[key];
}

function stepSizes() {
  sizeRaf = 0;
  let moving = false;
  for (const it of props.items) {
    const key = String(it.h);
    if (sizes.value[key] === undefined) { sizes.value[key] = props.size; vels[key] = 0; }
    const target = (activeH.value === key) ? props.size * props.scale : props.size;
    let vel = vels[key] || 0;
    vel += (target - sizes.value[key]) * 0.30;
    vel *= 0.70;
    let next = sizes.value[key] + vel;
    if (Math.abs(target - next) < 0.04 && Math.abs(vel) < 0.04) { next = target; vel = 0; }
    else moving = true;
    vels[key] = vel;
    sizes.value[key] = next;
  }
  sizeMoving.value = moving;
  sizes.value = { ...sizes.value };
  if (moving) sizeRaf = requestAnimationFrame(stepSizes);
}

function startSizes() {
  if (!sizeRaf) sizeRaf = requestAnimationFrame(stepSizes);
}

// 设置里改“图标大小/间距”时，这一区必须整块直接落到新尺寸：
// 原来每颗缩略图的尺寸只在第一次出现时取一次 props.size，之后设置变大变小它都不跟，
// 结果容器按新尺寸变宽、里面的缩略图还是旧尺寸 —— 就是 Dock 右边“空一大块 + 图标大小不一”。
watch(() => Number(props.size), (n) => {
  cancelAnimationFrame(sizeRaf);
  sizeRaf = 0;
  const next = {};
  for (const it of props.items) {
    const key = String(it.h);
    vels[key] = 0;
    next[key] = (activeH.value === key) ? n * props.scale : n;
  }
  sizes.value = next;
  sizeMoving.value = false;
});

function onItemEnter(it) {
  hoverH.value = String(it.h);
  emit('hover', String(it.h));   // 让 Dock 整块玻璃同步变宽
  startSizes();
}
function onZoneLeave() {
  hoverH.value = '';
  emit('hover', '');
  startSizes();
}

// Dock 切成鼠标穿透后，这里的 pointerleave 收不到，悬停状态会永久停在某一颗上，
// 那颗缩略图就一直比别的大（103px vs 76px）。所以以上层传下来的 hoverId 为准：
// 上层清空时同步清掉内部状态，让尺寸收回去。
watch(() => props.hoverId, (v) => {
  if (!v && hoverH.value) {
    hoverH.value = '';
    startSizes();
  }
});

async function restore(it, e) {
  // 真实鼠标点击由 Dock 舞台统一处理（与左侧应用图标同路径）；
  // 这里只兜底键盘 Enter/Space 等直接触发
  if (e) { e.stopPropagation(); e.preventDefault(); }
  emit('restored', it.h);
  await new Promise(resolve => setTimeout(resolve, 170));
  if (!api || !api.restoreWindow) return;
  try { await api.restoreWindow(it.h); } catch (err) { /* ignore */ }
}

function initial(title) {
  const value = String(title || '?').trim();
  return value ? value[0].toUpperCase() : '?';
}
</script>

<template>
  <div
    v-if="visible"
    class="min-zone"
    :style="{ left: left + 'px', bottom: bottom + 'px', width: width + 'px', gap: gap + 'px' }"
    @pointerleave="onZoneLeave"
  >
    <div class="min-row" :style="{ gap: gap + 'px' }">
      <button
        v-for="it in items"
        :key="it.h"
        class="min-item"
        :class="{ hop: bouncing === String(it.h), 'is-entering': entering[String(it.h)] }"
        :data-h="String(it.h)"
        :style="{
          width: sizeOf(it.h) + 'px',
          height: sizeOf(it.h) + 'px',
          '--grow': (size * (scale - 1)) + 'px',
          '--gap': gap + 'px'
        }"
        tabindex="-1"
        @pointerenter="onItemEnter(it)"
        @keydown.enter.prevent="restore(it, $event)"
        @keydown.space.prevent="restore(it, $event)"
      >
        <span
          class="min-visual"
          :class="{
            'has-icon-frame': stateOf(it.h).frame,
            'is-pending': !!icons[it.h] && !stateOf(it.h).ready
          }"
        >
          <img
            v-if="icons[it.h]"
            class="min-icon"
            :src="icons[it.h]"
            alt=""
            draggable="false"
            @load="onIconLoad(it, $event)"
          />
          <span v-else class="min-fallback">{{ initial(it.t) }}</span>
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.min-zone {
  position: absolute;
  display: flex;
  align-items: flex-end;
  pointer-events: auto;
}

.min-row {
  display: flex;
  align-items: flex-end;
}

.min-item {
  position: relative;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  padding: 0;
  border: none;
  background: transparent;
  cursor: default;   /* 和左侧应用图标一致：默认箭头，不是手型 */
  pointer-events: auto;
  overflow: visible;
  transform-origin: 50% 100%;
  outline: none;
  -webkit-tap-highlight-color: transparent;
}

/* 命中区和左侧应用图标一致：图标上方一段（放大预留高度）+ 左右各半个 gap 都算悬停 */
.min-item::before {
  content: '';
  position: absolute;
  left: calc(var(--gap, 8px) / -2);
  right: calc(var(--gap, 8px) / -2);
  bottom: 0;
  top: calc(-1 * var(--grow, 0px) - 6px);
}

/* 悬停放大由脚本按同一套弹簧逐帧算宽高（见 sizeOf / stepSizes），不再走 CSS 缩放 */
.min-item.hop .min-visual {
  animation: dock-bounce 1160ms cubic-bezier(0.3, 0.9, 0.4, 1);
}

/* 新最小化进来的窗口：从下方带一点缩放弹进来，和左侧图标落地的手感一致 */
.min-item.is-entering .min-visual {
  animation: min-enter 380ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

@keyframes min-enter {
  0% {
    opacity: 0;
    transform: translateY(16px) scale(0.55);
  }
  62% {
    opacity: 1;
    transform: translateY(-2px) scale(1.03);
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.min-visual {
  box-sizing: border-box;
  width: 88%;
  height: 88%;
  margin: 6%;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: 22%;
  transition: opacity 100ms ease, padding 140ms ease, background 140ms ease, box-shadow 140ms ease;
}

.min-visual.is-pending {
  opacity: 0;
}

.min-visual.has-icon-frame {
  padding: 12%;
  background: linear-gradient(
    145deg,
    rgba(255, 255, 255, 0.28),
    rgba(138, 149, 168, 0.18)
  );
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.36),
    inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

.min-icon {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
  -webkit-user-drag: none;
}

.min-fallback {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  border-radius: inherit;
  background: linear-gradient(160deg, #6e6e73, #3a3a3c);
  color: #fff;
  font-size: 20px;
  font-weight: 600;
}

</style>
