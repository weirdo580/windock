<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import LiquidGlass from './components/LiquidGlass.vue';
import DockIcon from './components/DockIcon.vue';
import DockFolder from './components/DockFolder.vue';
import GlassTooltip from './components/GlassTooltip.vue';
import MusicTile from './components/MusicTile.vue';
import MinimizedZone from './components/MinimizedZone.vue';
import StatusTray from './components/StatusTray.vue';

const api = window.dockApi;

const cfg = reactive({
  apps: [],
  glass: {},
  dock: {
    height: 72,
    iconSize: 56,
    maxScale: 1.42,
    magnification: true,
    effectStrength: 0.5,
    gap: 8,
    padding: 18,
    bottomMargin: 18
  },
  global: {}
});

const winInfo = ref({
  bounds: { x: 0, y: 0, width: 0, height: 0 },
  display: { x: 0, y: 0, width: 0, height: 0 },
  dpr: 1
});
const winW = ref(window.innerWidth);
const winH = ref(window.innerHeight);

const stageRef = ref(null);
const renameInput = ref(null);

const pointer = reactive({ x: -10000, y: -10000, active: false });
const anims = reactive({});
const view = reactive({ left: 0, width: 0 });
const hovering = ref(-1);
// 最小化窗口区里当前悬停的是哪一颗（由 MinimizedZone 上报），用于让整块玻璃跟着变宽
const minHoverId = ref('');
// 右侧状态区里当前悬停的是哪一颗（wifi / volume / battery），同样让整条玻璃跟着变宽
const statusHover = ref('');
// 状态区悬停时的玻璃气泡（和左侧应用图标同一个气泡，不用系统原生 title）
const statusLabel = ref('');
let statusTipTimer = 0;
let statusTipEl = null;
// 气泡宽度按真实文字宽度算（Canvas 量一次，带 0.2px 字距），最长封顶 256px：
// 文字比框宽时由 .tip-text 的 ellipsis 收尾，框本身不会再被撑破。
let tipMeasureCtx = null;
function tipTextWidth(label) {
  const text = String(label || '');
  if (!tipMeasureCtx) {
    const c = document.createElement('canvas');
    tipMeasureCtx = c.getContext('2d');
    const cs = getComputedStyle(document.body);
    tipMeasureCtx.font = '400 12.5px ' + (cs.fontFamily || 'system-ui, sans-serif');
  }
  return Math.ceil(tipMeasureCtx.measureText(text).width + text.length * 0.2);
}
const TIP_MAX_W = 256;
const TIP_MIN_W = 100;
function tipWidth(label) {
  // +24 内边距 +2 边框，border-box 下才是完整外框宽度
  return Math.min(TIP_MAX_W, Math.max(TIP_MIN_W, tipTextWidth(label) + 26));
}
function onStatusHover(label, node) {
  if (node) statusTipEl = node;
  const changed = label !== statusLabel.value;
  statusHover.value = label ? 'group' : '';
  if (!changed) { startLoop(); return; }
  statusLabel.value = label;
  clearTimeout(statusTipTimer);
  tip.show = false;
  if (label && cfg.global.tooltip !== false) {
    statusTipTimer = setTimeout(() => {
      if (!statusHover.value || statusLabel.value !== label || !statusTipEl) return;
      const r = statusTipEl.getBoundingClientRect();
      const w = tipWidth(label);
      const hh = 30;
      const d = cfg.dock;
      const x = Math.max(6, Math.min(winW.value - w - 6, r.x + r.width / 2 - w / 2));
      // 高度和左侧应用图标的气泡完全同一档：按图标放大后的顶部算，气泡底边比它高 10px
      const top = winH.value - d.bottomMargin - iconBottom.value - d.iconSize * maxScaleOf();
      const y = Math.max(4, top - hh - 10);
      Object.assign(tip, { show: true, label, x, y, w, h: hh });
    }, 380);
  }
  startLoop();
}
const minPress = ref(null);
let minTipTimer = 0;
// 点开缩略图的退出动画：用 FLIP 思路——先量下它此刻的位置和尺寸（含悬停放大后的实际大小），
// 立刻把它从最小化区移除（Dock 右端同帧开始弹簧收拢），同时在原地挂一个不参与布局的“幽灵”缩略图，
// 由合成层独自完成“抬起 → 缩小 → 淡出”。两者时间重叠，所以不会出现先停一下再收拢的台阶感。
const minGhost = ref(null);
let ghostSeq = 0;
let ghostTimer = 0;
function captureMinGhost(key) {
  const stage = stageRef.value;
  const el = stage ? stage.querySelector(`.min-item[data-h="${key}"]`) : null;
  if (!stage || !el) return null;
  // 用整块舞台（窗口）做坐标系，而不是会随弹簧左右移动的 .dock，
  // 这样 dock 收窄时幽灵不会跟着横向漂。
  const s = stage.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const vis = el.querySelector('.min-visual');
  const img = el.querySelector('.min-icon');
  return {
    id: ++ghostSeq,
    left: Math.round(r.left - s.left),
    bottom: Math.round(s.bottom - r.bottom),
    size: Math.round(r.width),
    icon: img ? img.getAttribute('src') || '' : '',
    frame: !!(vis && vis.classList.contains('has-icon-frame')),
    ready: !!(vis && !vis.classList.contains('is-pending')),
    letter: (el.textContent || '').trim() ? (el.textContent || '').trim()[0].toUpperCase() : '?'
  };
}
function restoreMinThumb(it) {
  if (!it || !api) return;
  const key = String(it.h);
  if (minGhost.value && minGhost.value.key === key) return;
  const ghost = captureMinGhost(key);
  if (minHoverId.value === key) {
    minHoverId.value = '';
    clearTimeout(minTipTimer);
    tip.show = false;
  }
  // 同一帧：移除该项 + 挂幽灵，视觉上缩略图原地不动，只是由布局元素换成了绝对定位的副本
  onMinRestored(it.h);
  if (ghost) {
    ghost.key = key;
    minGhost.value = ghost;
    clearTimeout(ghostTimer);
    ghostTimer = setTimeout(() => { minGhost.value = null; }, 220);
  }
  setTimeout(async () => {
    try { await api.restoreWindow(it.h); } catch (err) { /* 忽略 */ }
  }, 160);
}
function onMinHover(h) {
  const key = h ? String(h) : '';
  minHoverId.value = key;
  clearTimeout(minTipTimer);
  tip.show = false;
  // 和左侧应用图标同一个名字气泡：380ms 后出现，位置按图标实际矩形算
  if (key && cfg.global.tooltip !== false) {
    minTipTimer = setTimeout(() => {
      if (minHoverId.value !== key) return;
      const el = document.querySelector('.min-item[data-h="' + key + '"]');
      const it = visibleMinItems.value.find(w => String(w.h) === key);
      if (!el || !it) return;
      const r = el.getBoundingClientRect();
      const label = it.t || '窗口';
      const w = tipWidth(label);
      const hh = 30;
      const x = Math.max(6, Math.min(winW.value - w - 6, r.x + r.width / 2 - w / 2));
      const y = Math.max(4, r.y - hh - 10);
      Object.assign(tip, { show: true, label, x, y, w, h: hh });
    }, 380);
  }
  startLoop();
}
watch(() => visibleMinItems.value.map(w => String(w.h)).join(','), () => {
  if (minHoverId.value && !visibleMinItems.value.some(w => String(w.h) === minHoverId.value)) {
    minHoverId.value = '';
    clearTimeout(minTipTimer);
    tip.show = false;
    startLoop();
  }
});
const dragging = ref(null);
const bouncingId = ref('');
const hidden = ref(false);
const glassFallback = ref(false);
const runningSet = ref(new Set());
const minWindows = ref([]);
const systemIcons = reactive({});
const folderOpen = ref('');

const toast = reactive({ show: false, text: '' });
const tip = reactive({ show: false, label: '', x: 0, y: 0, w: 0, h: 30 });
const rename = reactive({ show: false, id: '', value: '', x: 0, y: 0, w: 240, h: 42 });

let rafId = 0;
let tipTimer = 0;
let hideTimer = 0;
let toastTimer = 0;
let bounceTimer = 0;
let saveTimer = 0;
let runningTimer = 0;
let iconTimer = 0;
let rectTimer = 0;
let themeQuery = null;
let offAction = null;
let offConfig = null;
let offCursor = null;
let offMin = null;
let lastRects = '';
// 设置页改了尺寸/间距这类几何参数时，整排图标要在同一帧里直接落到新尺寸，
// 不能各自从 0 宽或旧尺寸弹进来 —— 那会出现“拉到一半有的 8px 有的 50px”的错位。
let snapLayoutOnce = false;

// ---------------- 基础布局 ----------------

// ---------------- 基础布局 ----------------

const MUSIC_W = 168;
const STATUS_W = 94;
const STATUS_STRETCH = 6;
const regularApps = computed(() => cfg.apps.filter(item => !item.type));

function isFolderItem(item) {
  return item && (item.type === 'app-folder' || item.type === 'min-folder');
}

function minimizedWidth(count) {
  if (!count) return 0;
  return count * cfg.dock.iconSize + (count - 1) * cfg.dock.gap;
}

function buildLayout(appCount, windowCount) {
  const apps = regularApps.value;
  const windows = minWindows.value;
  const visibleApps = new Set(apps.slice(0, appCount).map(item => item.id));
  const appOverflow = apps.slice(appCount);
  const visibleWindows = windows.slice(0, windowCount);
  const minOverflow = windows.slice(windowCount);
  const items = [];
  let appFolderAdded = appOverflow.length === 0;

  const addAppFolder = () => {
    if (appFolderAdded) return;
    items.push({
      type: 'app-folder',
      id: 'app-folder',
      name: '更多应用',
      items: appOverflow,
      width: cfg.dock.iconSize
    });
    appFolderAdded = true;
  };

  for (const item of cfg.apps) {
    if (!item.type) {
      if (visibleApps.has(item.id)) items.push(item);
      continue;
    }
    if (item.type === 'separator') {
      addAppFolder();
      // 最小化区没有窗口时，它左边那根竖线不该出现（否则会和状态区竖线挤成两条并排的线）
      if (item.id === 'windows-separator' && visibleWindows.length === 0) continue;
      items.push(item);
      continue;
    }
    if (item.type === 'music') {
      addAppFolder();
      items.push(item);
      continue;
    }
    if (item.type === 'minimized') {
      addAppFolder();
      if (visibleWindows.length) {
        items.push({
          ...item,
          visibleItems: visibleWindows,
          virtualWidth: minimizedWidth(visibleWindows.length)
        });
      }
      if (minOverflow.length) {
        items.push({
          type: 'min-folder',
          id: 'min-folder',
          name: '更多窗口',
          items: minOverflow,
          width: cfg.dock.iconSize
        });
      }
    }
  }
  addAppFolder();

  return { items, visibleApps, appOverflow, visibleWindows, minOverflow };
}

function layoutItemBaseWidth(item) {
  if (!item) return cfg.dock.iconSize;
  if (isFolderItem(item)) return item.width || cfg.dock.iconSize;
  if (item.type === 'separator') return 13;
  if (item.type === 'music') return MUSIC_W;
  if (item.type === 'status') return STATUS_W;
  if (item.type === 'minimized') return item.virtualWidth || 0;
  return cfg.dock.iconSize;
}

function layoutWidth(layout) {
  const items = layout?.items || [];
  if (!items.length) return 0;
  let width = cfg.dock.padding * 2 + Math.max(0, items.length - 1) * cfg.dock.gap;
  items.forEach(item => { width += layoutItemBaseWidth(item); });
  return Math.round(width);
}

const MIN_RESIDENT = 4;       // 最小化窗口区常驻 4 个，多余的进“更多窗口”文件夹
const DOCK_EDGE_MARGIN = 40;  // 放大/拉间距时，Dock 离屏幕左右两边至少留这么多

const dockCapacity = computed(() => {
  const totalApps = regularApps.value.length;
  const totalWindows = minWindows.value.length;
  const screenWidth = Number(winInfo.value.display?.width) || winW.value;
  const maxWidth = Math.max(260, Math.min(screenWidth, winW.value) - DOCK_EDGE_MARGIN * 2);
  const hoverGrow = cfg.dock.iconSize * (maxScaleOf() - 1);
  // 末尾的系统状态区（含它左侧的标准分隔线）不参与折叠，但确实占位置，算容量时必须一起算进去
  const statusRoom = 13 + cfg.dock.gap + STATUS_W + cfg.dock.gap;
  let appCount = totalApps;
  // 最小化区常驻 4 个；但溢出只有 1 个时先单独摆着，第 6 个窗口出现才一起收进文件夹
  let windowCount = totalWindows <= MIN_RESIDENT + 1 ? totalWindows : MIN_RESIDENT;
  let layout = buildLayout(appCount, windowCount);
  let guard = 0;

  while (layoutWidth(layout) + statusRoom + hoverGrow > maxWidth && guard < totalApps + totalWindows + 12) {
    guard += 1;
    // 最小化区固定常驻 4 个，位置不够时先折叠左侧应用（多出的进「更多应用」文件夹）
    if (appCount > 0) appCount -= 1;
    else if (windowCount > 0) windowCount -= 1;
    else break;
    layout = buildLayout(appCount, windowCount);
  }
  // 溢出正好剩 1 个时（应用或窗口）不塞文件夹——文件夹里只装一个东西说不通，摆回原位当普通图标
  if (totalApps - appCount === 1) appCount = totalApps;
  if (totalWindows - windowCount === 1) windowCount = totalWindows;
  layout = buildLayout(appCount, windowCount);
  return layout;
});

const layoutItems = computed(() => {
  const items = dockCapacity.value.items.slice();
  // 系统状态区固定在最右侧；它左边这根竖线用 Dock 标准分隔线（和音乐区两侧完全同源）
  items.push({ type: 'separator', id: 'status-separator' });
  items.push({ type: 'status', id: 'status' });
  return items;
});
const visibleMinItems = computed(() => dockCapacity.value.visibleWindows);
const appOverflow = computed(() => dockCapacity.value.appOverflow);
const minOverflow = computed(() => dockCapacity.value.minOverflow);
const dockW = computed(() => layoutWidth({ items: layoutItems.value }));

watch([() => appOverflow.value.length, () => minOverflow.value.length], () => {
  if (folderOpen.value === 'app' && !appOverflow.value.length) folderOpen.value = '';
  if (folderOpen.value === 'min' && !minOverflow.value.length) folderOpen.value = '';
});

// 基础槽位：只用于拖拽排序与指针中心参考，放大时不用它定位
const slots = computed(() => {
  const d = cfg.dock;
  let x = d.padding;
  const list = [];
  layoutItems.value.forEach((item, index) => {
    const w = layoutItemBaseWidth(item);
    list.push({ item, index, x, w });
    x += w + (index < layoutItems.value.length - 1 ? d.gap : 0);
  });
  return list;
});

const iconBottom = computed(() => Math.max(0, (cfg.dock.height - cfg.dock.iconSize) / 2));

const dockBox = computed(() => ({
  left: view.left + 'px',
  bottom: cfg.dock.bottomMargin + 'px',
  width: view.width + 'px',
  height: cfg.dock.height + 'px',
  // 玻璃底色和图标层的描边必须共用同一个圆角，否则会看到两层轮廓。
  '--radius-dock': `${Number(cfg.glass.radius ?? 26)}px`,
  '--glass-fresnel': `${Number(cfg.glass.fresnel ?? 0.86)}`
}));

// 自动隐藏后保留的底部细线：宽度固定为 iOS 底部横条那种短条，居中显示。
const COLLAPSED_LINE_WIDTH = 118;
const autoHideDurationMs = computed(() => {
  const raw = Number(cfg.dock.autoHideDuration);
  return Number.isFinite(raw) ? Math.max(100, Math.min(1200, raw)) : 460;
});
const autoHideDurationCss = computed(() => `${autoHideDurationMs.value}ms`);
const autoHideLineDelayCss = computed(() => `${Math.round(autoHideDurationMs.value * 0.6)}ms`);
const glassCaptureOffset = computed(() => {
  const d = cfg.dock;
  // 底部留白够高时，直接取 Dock 下方那块真实桌面，避开 Dock 自身和悬浮提示；
  // 留白太少时退回取 Dock 上方一条。
  return d.bottomMargin >= d.height - 8 ? -Number(d.bottomMargin) : Number(d.height) + 6;
});
const collapsedLineBox = computed(() => {
  const width = Math.min(COLLAPSED_LINE_WIDTH, view.width || COLLAPSED_LINE_WIDTH);
  return {
    left: view.left + (view.width - width) / 2,
    width,
    bottom: cfg.dock.bottomMargin
  };
});

const collapsedLine = computed(() => ({
  left: collapsedLineBox.value.left + 'px',
  bottom: collapsedLineBox.value.bottom + 'px',
  width: collapsedLineBox.value.width + 'px'
}));

const glassPanels = computed(() => {
  const list = [];
  if (!winW.value || hidden.value) return list;
  const d = cfg.dock;
  list.push({
    x: view.left,
    y: winH.value - d.bottomMargin - d.height,
    w: view.width,
    h: d.height,
    radius: Number(cfg.glass.radius ?? 26)
  });
  if (tip.show) list.push({ x: tip.x, y: tip.y, w: tip.w, h: tip.h, radius: 12 });
  if (rename.show) list.push({ x: rename.x, y: rename.y, w: rename.w, h: rename.h, radius: 14 });
  return list;
});

// ---------------- 放大动画：cos^8 + 底板跟随 ----------------

function anim(id) {
  if (!anims[id]) {
    const item = layoutItems.value.find(it => it.id === id);
    const hasExisting = Object.keys(anims).length > 0;
    anims[id] = { size: hasExisting ? 0 : baseSize(item), vel: 0, x: 0 };
  }
  return anims[id];
}

function baseSize(item) {
  return layoutItemBaseWidth(item);
}

/** 静止状态下的目标宽度（不含悬停放大） */
function restSize(item) {
  if (item.type === 'music') return MUSIC_W;
  if (item.type === 'status') return STATUS_W + (statusHover.value ? STATUS_STRETCH : 0);
  return baseSize(item);
}

function ensureAnims() {
  const ids = new Set(layoutItems.value.map(item => item.id));
  const hasExisting = Object.keys(anims).length > 0;
  // 几何参数变化那一次，新冒出来的项（比如折叠进/出文件夹的应用）直接按最终宽度出现，
  // 不再从 0 宽弹簧撑开；窗口最小化进 Dock 这类“真新增”仍保留弹性展开。
  const snap = snapLayoutOnce;
  layoutItems.value.forEach(item => {
    if (!anims[item.id]) {
      anims[item.id] = { size: (snap || !hasExisting) ? baseSize(item) : 0, vel: 0, x: 0 };
    } else if (snap) {
      const a = anims[item.id];
      a.size = restSize(item);
      a.vel = 0;
    }
  });
  Object.keys(anims).forEach(id => { if (!ids.has(id)) delete anims[id]; });
  snapLayoutOnce = false;
}

watch(
  () => layoutItems.value.map(item => item.id).join('|'),
  () => {
    ensureAnims();
    syncGeometry();
    startLoop();
  }
);

// 底板宽度 + 行内 left：尺寸一变就要在同一帧一起算，不能让“宽度已经是新的、
// left 还是上一帧的”这种半新半旧状态露出一帧（拖动图标大小时那一下“错位/空一块”）。
function syncGeometry() {
  const d = cfg.dock;
  const gap = Number(d.gap) || 8;
  const items = layoutItems.value;
  if (!items.length) return;
  let total = d.padding * 2;
  items.forEach((item, i) => {
    total += anim(item.id).size + (i < items.length - 1 ? gap : 0);
  });
  const width = Math.round(Math.min(winW.value, total));
  if (view.width !== width) {
    view.width = width;
    view.left = Math.max(0, Math.round((winW.value - width) / 2));
  }
  placeRow();
}

function placeRow() {
  const d = cfg.dock;
  const gap = Number(d.gap) || 8;
  let p = d.padding;
  layoutItems.value.forEach(item => {
    const a = anim(item.id);
    a.x = p;
    if (a.size <= 0) return;
    p += a.size + gap;
  });
}

function maxScaleOf() {
  return cfg.dock.magnification === false ? 1 : Math.max(1, Number(cfg.dock.maxScale) || 1.4);
}

function inDockBand(x, y) {
  const d = cfg.dock;
  if (hidden.value) return false;
  const top = winH.value - d.bottomMargin - d.height - d.iconSize * (maxScaleOf() - 1) - 10;
  return x >= view.left - 12 && x <= view.left + view.width + 12 && y >= top && y <= winH.value;
}

function inHiddenRevealBand(x, y) {
  const d = cfg.dock;
  const line = collapsedLineBox.value;
  const top = winH.value - d.bottomMargin - 18;
  return x >= line.left - 40 && x <= line.left + line.width + 40 && y >= top && y <= winH.value;
}

function hitIcon(x, y) {
  const d = cfg.dock;
  const glassTop = winH.value - d.bottomMargin - d.height;
  const topLimit = glassTop - d.iconSize * (maxScaleOf() - 1) - 6;
  if (y < topLimit || y > winH.value - d.bottomMargin + 2) return -1;
  const relX = x - view.left;
  for (let i = 0; i < layoutItems.value.length; i++) {
    const item = layoutItems.value[i];
    if (item.type === 'separator' || item.type === 'music' || item.type === 'minimized' || item.type === 'status') continue;
    const a = anim(item.id);
    if (relX >= a.x - d.gap / 2 && relX <= a.x + a.size + d.gap / 2) return i;
  }
  return -1;
}

function iconVisualLeft(item) {
  const a = anim(item.id);
  const drag = dragging.value;
  if (!drag || drag.id !== item.id || !drag.moved) return a.x;
  const maxLeft = Math.max(0, view.width - a.size);
  return Math.max(0, Math.min(maxLeft, drag.currentX - view.left - a.size / 2));
}

function baseCenterOf(id) {
  const s = slots.value.find(item => item.item.id === id);
  return s ? s.x + s.w / 2 : 0;
}

function step() {
  rafId = 0;
  const d = cfg.dock;
  const base = Number(d.iconSize) || 56;
  const gap = Number(d.gap) || 8;
  const maxScale = maxScaleOf();
  const strength = Math.max(0.05, Math.min(1, Number(d.effectStrength ?? 0.5)));
  const items = layoutItems.value;
  if (!items.length) return;

  const over = pointer.active && !dragging.value && !folderOpen.value && inDockBand(pointer.x, pointer.y);
  const hoverIdx = over ? hitIcon(pointer.x, pointer.y) : -1;
  const hoverId = hoverIdx >= 0 && items[hoverIdx] ? items[hoverIdx].id : '';
  // 影响半径按图标尺寸归一化（约 4 个图标宽），与 Dock 总长无关
  const reach = Math.max(1, base * 8.4 * strength);

  items.forEach(item => {
    const a = anim(item.id);
    if (item.type === 'separator') {
      // 右侧“最小化窗口”区的分隔线会随该区一起淡入淡出，宽度也做弹性过渡
      const target = baseSize(item);
      a.vel += (target - a.size) * 0.26;
      a.vel *= 0.72;
      a.size += a.vel;
      if (Math.abs(target - a.size) < 0.05 && Math.abs(a.vel) < 0.05) { a.size = target; a.vel = 0; }
      return;
    }
    if (item.type === 'music') {
      // 音乐条是固定宽度的挂件，不参与放大，避免把整排撑得乱跳
      a.size = MUSIC_W;
      a.vel = 0;
      return;
    }
    if (item.type === 'status') {
      // 右侧状态区：悬停时胶囊底拉长一点点，整条玻璃同步加宽同样的一点点
      const target = STATUS_W + (statusHover.value ? STATUS_STRETCH : 0);
      a.vel += (target - a.size) * 0.30;
      a.vel *= 0.70;
      a.size += a.vel;
      if (Math.abs(target - a.size) < 0.04 && Math.abs(a.vel) < 0.04) { a.size = target; a.vel = 0; }
      return;
    }
    if (item.type === 'minimized') {
      // 最小化窗口区宽度弹性过渡：增减窗口时整条 Dock 同步收回/展开，不是硬跳
      // 悬停某一颗缩略图时，这一块也要跟着变宽（和左侧应用图标放大时整条玻璃变宽一致）
      const base = baseSize(item);
      const target = base + (minHoverId.value ? cfg.dock.iconSize * (maxScale - 1) : 0);
      // 与图标弹簧完全同参（0.30 / 0.70 / 0.04），玻璃变宽和缩略图放大逐帧同步
      a.vel += (target - a.size) * 0.30;
      a.vel *= 0.70;
      a.size += a.vel;
      if (Math.abs(target - a.size) < 0.04 && Math.abs(a.vel) < 0.04) { a.size = target; a.vel = 0; }
      return;
    }
    // 只有指针下那一个图标放大，其它图标保持原尺寸（不再整排跟着起伏）
    const target = (over && hoverId && item.id === hoverId) ? base * maxScale : base;
    a.vel += (target - a.size) * 0.30;
    a.vel *= 0.70;
    a.size += a.vel;
    if (Math.abs(target - a.size) < 0.04 && Math.abs(a.vel) < 0.04) {
      a.size = target;
      a.vel = 0;
    }
  });

  // 底板宽度 = 图标行实际宽度（含内边距），所以图标永远不会冲出玻璃
  syncGeometry();

  // 行内顺序排布：图标之间、图标与分隔线之间都按实际宽度累加，不会互相压住
  placeRow();

  const settled = items.every(item => {
    if (item.type === 'music' || item.type === 'status') return true;
    if (item.type === 'minimized') {
      const t = baseSize(item) + (minHoverId.value ? cfg.dock.iconSize * (maxScaleOf() - 1) : 0);
      return Math.abs(anim(item.id).size - t) < 0.1;
    }
    if (item.type === 'separator') {
      return Math.abs(anim(item.id).size - baseSize(item)) < 0.1;
    }
    return Math.abs(anim(item.id).size - base) < 0.1;
  });

  // 空闲时停掉动画循环，避免常驻 60fps 占用
  if ((!over && settled && width === dockW.value) || hidden.value) {
    return;
  }
  rafId = requestAnimationFrame(step);
}

function startLoop() {
  if (!rafId) rafId = requestAnimationFrame(step);
}

// ---------------- 提示与穿透 ----------------

function updateHover() {
  if (folderOpen.value) {
    hovering.value = -1;
    tip.show = false;
    clearTimeout(tipTimer);
    return;
  }
  const idx = hitIcon(pointer.x, pointer.y);
  if (idx === hovering.value) return;
  hovering.value = idx;
  tip.show = false;
  clearTimeout(tipTimer);
  if (idx >= 0 && cfg.global.tooltip !== false) {
    tipTimer = setTimeout(() => showTip(idx), 380);
  }
}

function showTip(requested) {
  if (cfg.global.tooltip === false) return;
  if (folderOpen.value) return;
  const idx = hitIcon(pointer.x, pointer.y);
  if (idx < 0 || idx !== requested) return;
  const item = layoutItems.value[idx];
  if (!item) return;
  const d = cfg.dock;
  const a = anim(item.id);
  const label = item.name || '应用';
  // 左右各 12px 内边距 + 1px 边框，宽度按真实文字量算并封顶 256px，超出用省略号
  const w = tipWidth(label);
  const h = 30;
  const centerX = view.left + a.x + a.size / 2;
  const x = Math.max(6, Math.min(winW.value - w - 6, centerX - w / 2));
  const top = winH.value - d.bottomMargin - iconBottom.value - a.size;
  const y = Math.max(4, top - h - 10);
  Object.assign(tip, { show: true, label, x, y, w, h });
}

const bandTop = computed(() => {
  const d = cfg.dock;
  return winH.value - d.bottomMargin - d.height - d.iconSize * (maxScaleOf() - 1) - 10;
});

// 命中区到 Dock 底板下沿为止：窗口本身比 Dock 高，窗口底边是屏幕底边，
// 命中区只要多出底板一点，鼠标从底板往下走的那一下就会被 Dock 吃掉，
// 下面 Windows 任务栏（尤其是自动隐藏时抬起来的那条）就点不动了。
// 命中区到 Dock 底板下沿为止：窗口本身比 Dock 高，窗口底边是屏幕底边，
// 命中区只要多出底板一点，下面那条 Windows 任务栏就有一段点不动。
const hitBottom = computed(() => {
  const bottom = winH.value - cfg.dock.bottomMargin;
  return Math.max(0, Math.min(winH.value, bottom));
});

const hitRects = computed(() => {
  if (dragging.value) return [{ x: 0, y: 0, w: winW.value, h: hitBottom.value }];
  if (hidden.value) {
    // 收起后 Dock 只剩中间一小段横条；命中区域跟着横条收窄，
    // 鼠标回到横条附近时由主进程解除穿透并触发重新展开。
    const d = cfg.dock;
    const line = collapsedLineBox.value;
    const top = Math.max(0, winH.value - d.bottomMargin - 18);
    const x = Math.max(0, line.left - 40);
    const w = Math.max(32, Math.min(winW.value - x, line.width + 80));
    return [{ x, y: top, w, h: Math.max(24, hitBottom.value - top) }];
  }
  // 文件夹展开时，横向整宽都接收点击：点任意空白处都能关闭弹层，
  // 弹层和文件夹自身会在组件里阻止事件冒泡，不会误关。
  if (folderOpen.value) return [{ x: 0, y: 0, w: winW.value, h: hitBottom.value }];
  const list = [{
    x: view.left - 12,
    y: bandTop.value,
    w: view.width + 24,
    h: hitBottom.value - bandTop.value
  }];
  if (rename.show) list.push({ x: rename.x, y: rename.y, w: rename.w, h: rename.h });
  return list;
});

// 底板随图标变宽时，命中区域也在变，这里限流后再发给主进程
watch(hitRects, rects => {
  if (!api || !api.setHitRects) return;
  const payload = JSON.stringify(rects);
  if (payload === lastRects) return;
  clearTimeout(rectTimer);
  rectTimer = setTimeout(() => {
    lastRects = payload;
    api.setHitRects(rects);
  }, 90);
}, { deep: true, immediate: true });

function scheduleHide() {
  if (!cfg.dock.autoHide) return;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!pointer.active || !inDockBand(pointer.x, pointer.y)) hidden.value = true;
  }, Number(cfg.dock.autoHideDelay) || 650);
}

// 指针一离开底板命中区就立刻把穿透交还出去，不等主进程轮询。
// 否则“鼠标刚滑到任务栏就按下”的这一下会被 Dock 窗吞掉，表现为任务栏点不动。
let throughNow = null;
function syncThrough() {
  if (!api || !api.setMouseThrough) return;
  let inside = false;
  for (const r of hitRects.value) {
    if (pointer.x >= r.x && pointer.x <= r.x + r.w && pointer.y >= r.y && pointer.y <= r.y + r.h) { inside = true; break; }
  }
  const want = !inside;
  if (want === throughNow) return;
  throughNow = want;
  api.setMouseThrough(want);
}

// ---------------- 指针交互 ----------------

function onPointerMove(e) {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.active = true;
  winW.value = window.innerWidth;
  winH.value = window.innerHeight;
  syncThrough();


  if (hidden.value && inHiddenRevealBand(pointer.x, pointer.y)) hidden.value = false;
  startLoop();

  if (cfg.dock.autoHide) {
    if (inDockBand(pointer.x, pointer.y)) clearTimeout(hideTimer);
    else scheduleHide();
  }

  // 最小化区的悬停也走舞台级指针命中，和左侧应用图标同源：
  // 透明/不激活窗口下 DOM pointerenter 可能被吞，导致“划过去没反应、忽大忽小”
  const minEl = stageRef.value ? stageRef.value.querySelector('.min-zone') : null;
  if (minEl) {
    const r = minEl.getBoundingClientRect();
    const gap = Number(cfg.dock.gap) || 8;
    const grow = cfg.dock.iconSize * (maxScaleOf() - 1);
    if (e.clientX >= r.x && e.clientX <= r.x + r.width && e.clientY >= r.y - grow - 6 && e.clientY <= r.y + r.height) {
      const nodes = minEl.querySelectorAll('.min-item');
      let found = '';
      for (const n of nodes) {
        const b = n.getBoundingClientRect();
        if (e.clientX >= b.x - gap / 2 && e.clientX <= b.x + b.width + gap / 2) { found = n.getAttribute('data-h') || ''; break; }
      }
      if (found !== minHoverId.value) onMinHover(found);
    } else if (minHoverId.value) {
      onMinHover('');
    }
  }

  updateHover();

  // 右侧状态区（Wi‑Fi / 音量 / 电池）：悬停时胶囊底只拉长一点点，图标不放大
  const tray = stageRef.value ? stageRef.value.querySelector('.status-tray') : null;
  if (tray) {
    const grp = tray.querySelector('.status-group');
    let label = '';
    let node = null;
    if (grp) {
      const r = grp.getBoundingClientRect();
      if (e.clientX >= r.x - 3 && e.clientX <= r.x + r.width + 3 && e.clientY >= r.y - 6 && e.clientY <= r.y + r.height + 6) {
        for (const n of grp.querySelectorAll('.status-item')) {
          const b = n.getBoundingClientRect();
          if (e.clientX >= b.x - 2 && e.clientX <= b.x + b.width + 2) { label = n.getAttribute('data-label') || ''; node = n; break; }
        }
      }
    }
    onStatusHover(label, node);
  }

  if (dragging.value) {
    dragging.value.currentX = e.clientX;
    updateDrag(e.clientX);
  }
  if (minPress.value && Math.abs(e.clientX - minPress.value.startX) >= 8) {
    minPress.value.moved = true;
  }
}

function onPointerLeave() {
  pointer.active = false;
  // 只是按了一下没拖动就离开窗口，抬起事件常常收不到，会把图标永久卡在“抬起放大”态
  if (dragging.value && !dragging.value.moved) { dragging.value = null; }
  if (minPress.value && !minPress.value.moved) { minPress.value = null; }
  // 人已经离开窗口，立刻交还穿透，别让主进程轮询把这一下算成还在底板上
  if (api && api.setMouseThrough && throughNow !== true) { throughNow = true; api.setMouseThrough(true); }
  hovering.value = -1;
  tip.show = false;
  clearTimeout(tipTimer);
  if (minHoverId.value) onMinHover('');
  clearTimeout(statusTipTimer);
  statusLabel.value = '';
  statusHover.value = '';
  if (folderOpen.value) folderOpen.value = '';
  startLoop();
  if (cfg.dock.autoHide) scheduleHide();
}

function onPointerDown(e) {
  if (e.button !== 0) return;
  if (folderOpen.value) {
    folderOpen.value = '';
    return;
  }
  updateHover();
  // 最小化缩略图也走舞台级指针（和左侧应用图标同一条路径），
  // 透明/不激活窗口下按钮自身的 DOM 事件不可靠，统一在这里做命中与按下
  if (minHoverId.value) {
    minPress.value = { h: minHoverId.value, startX: e.clientX, moved: false };
    try { stageRef.value.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    startLoop();
    return;
  }
  const idx = hitIcon(e.clientX, e.clientY);
  if (idx < 0) return;
  const item = layoutItems.value[idx];
  if (isFolderItem(item)) {
    folderOpen.value = folderOpen.value === (item.type === 'app-folder' ? 'app' : 'min')
      ? ''
      : (item.type === 'app-folder' ? 'app' : 'min');
    startLoop();
    return;
  }
  if (!item || item.type) return;
  dragging.value = { id: item.id, startX: e.clientX, currentX: e.clientX, moved: false };
  startLoop();
  try { stageRef.value.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
  e.preventDefault();
}

function updateDrag(x) {
  const d = dragging.value;
  if (!d) return;
  if (!d.moved && Math.abs(x - d.startX) < 8) return;
  d.moved = true;

  const relX = x - view.left;
  const items = cfg.apps;
  const from = items.findIndex(it => it.id === d.id);
  if (from < 0) return;

  let insertAt = -1;
  for (const s of slots.value) {
    if (s.item.id === d.id || s.item.type || isFolderItem(s.item)) continue;
    if (relX < s.x + s.w / 2) { insertAt = items.findIndex(it => it.id === s.item.id); break; }
  }
  if (insertAt < 0) {
    const firstFixed = items.findIndex(it => it.type);
    insertAt = firstFixed >= 0 ? firstFixed : items.length;
  }

  let target = insertAt;
  if (target > from) target -= 1;
  if (target === from || target < 0) return;

  const [moved] = items.splice(from, 1);
  items.splice(target, 0, moved);
}

function onPointerUp(e) {
  // 最小化缩略图：与左侧应用图标同一套“按下-抬起触发、拖动超过 8px 取消”
  if (minPress.value) {
    const p = minPress.value;
    minPress.value = null;
    try { stageRef.value.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    if (!p.moved) {
      const it = visibleMinItems.value.find(w => String(w.h) === String(p.h));
      if (it) restoreMinThumb(it);
    }
    startLoop();
    return;
  }
  const d = dragging.value;
  if (!d) return;
  dragging.value = null;
  try { stageRef.value.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
  if (d.moved) persist(true);
  else launch(d.id);
  startLoop();
}

/**
 * 兜底收尾：拖拽图标时如果鼠标是在窗口外松开的（Dock 会临时切成鼠标穿透），
 * 舞台上的 pointerup 收不到，拖拽状态就会永久卡住 —— 那颗图标一直带着抬起缩放、
 * 还停在手指位置，和别的不一样大也不在槽位上。所以窗口级再兜一层。
 */
function onGlobalPointerUp(e) {
  if (dragging.value || minPress.value) onPointerUp(e);
}

function cancelPointerState() {
  if (dragging.value) { dragging.value = null; startLoop(); }
  if (minPress.value) { minPress.value = null; startLoop(); }
}

function onContextMenu(e) {
  if (!api) return;
  const idx = hitIcon(e.clientX, e.clientY);
  const payload = { type: 'dock', x: e.clientX, y: e.clientY };
  if (idx >= 0) {
    const item = layoutItems.value[idx];
    if (!item.type) {
      payload.type = 'icon';
      payload.id = item.id;
    }
  }
  api.showMenu(payload);
}

// ---------------- 动作 ----------------

async function launch(id) {
  if (!api) return;
  clearTimeout(bounceTimer);
  bouncingId.value = '';
  if (cfg.dock.bounce !== false) {
    bouncingId.value = id;
    bounceTimer = setTimeout(() => { bouncingId.value = ''; }, 1180);
  }
  const res = await api.launch(id);
  if (res && res.ok === false) showToast(res.error || '启动失败');
}

function showToast(text) {
  toast.text = text;
  toast.show = true;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.show = false; }, 2400);
}

async function persist(immediate) {
  if (!api) return;
  clearTimeout(saveTimer);
  const doSave = async () => {
    const payload = JSON.parse(JSON.stringify({
      apps: cfg.apps,
      glass: cfg.glass,
      dock: cfg.dock,
      global: cfg.global
    }));
    const res = await api.saveConfig(payload);
    if (res && res.config) applyConfig(res.config);
    await refreshWindowInfo();
  };
  if (immediate) await doSave();
  else saveTimer = setTimeout(doSave, 400);
}

async function refreshWindowInfo() {
  if (!api) return;
  const info = await api.getWindowInfo();
  if (info) {
    winInfo.value = info;
    winW.value = info.bounds.width || window.innerWidth;
    winH.value = info.bounds.height || window.innerHeight;
  }
}

async function pollRunning() {
  if (!api) return;
  const ids = await api.running();
  runningSet.value = new Set(Array.isArray(ids) ? ids : []);
}

let iconRefreshBusy = false;

async function refreshSystemIcons() {
  if (!api || !api.extractIcon || iconRefreshBusy) return;
  iconRefreshBusy = true;
  try {
    const activeIds = new Set();
    for (const item of cfg.apps) {
      if (!item.id) continue;
      activeIds.add(item.id);
      if (!item.path || String(item.path).startsWith('shell:')) {
        delete systemIcons[item.id];
        continue;
      }
      try {
        const icon = await api.extractIcon(item.path);
        if (icon && systemIcons[item.id] !== icon) systemIcons[item.id] = icon;
      } catch (err) { /* keep configured fallback */ }
    }
    Object.keys(systemIcons).forEach(id => {
      if (!activeIds.has(id)) delete systemIcons[id];
    });
  } finally {
    iconRefreshBusy = false;
  }
}

function removeItem(id) {
  const idx = cfg.apps.findIndex(it => it.id === id);
  if (idx < 0) return;
  cfg.apps.splice(idx, 1);
  ensureAnims();
  persist(true);
}

function startRename(id) {
  const idx = cfg.apps.findIndex(it => it.id === id);
  if (idx < 0) return;
  const s = slots.value.find(slot => slot.item.id === id);
  if (!s) return;
  const centerX = view.left + s.x + s.w / 2;
  rename.w = 240;
  rename.h = 42;
  rename.x = Math.max(6, Math.min(winW.value - rename.w - 6, centerX - rename.w / 2));
  rename.y = winH.value - cfg.dock.bottomMargin - cfg.dock.height - 64;
  rename.id = id;
  rename.value = cfg.apps[idx].name || '';
  rename.show = true;
  nextTick(() => {
    if (renameInput.value) {
      renameInput.value.focus();
      renameInput.value.select();
    }
  });
}

function commitRename() {
  if (!rename.show) return;
  const item = cfg.apps.find(it => it.id === rename.id);
  const value = (rename.value || '').trim();
  if (item && value) item.name = value;
  rename.show = false;
  persist(true);
}

function cancelRename() {
  rename.show = false;
}

function handleAction(payload) {
  if (!payload) return;
  switch (payload.action) {
    case 'remove':
      removeItem(payload.id);
      break;
    case 'rename':
      startRename(payload.id);
      break;
    case 'toggle-autohide':
      cfg.dock.autoHide = !cfg.dock.autoHide;
      if (!cfg.dock.autoHide) hidden.value = false;
      persist(true);
      break;
    case 'empty-trash':
      if (api) {
        api.emptyTrash().then(res => {
          if (res && res.ok === false && !res.canceled) showToast(res.error || '清空失败');
        });
      }
      break;
    default:
      break;
  }
}

// ---------------- 拖入文件 ----------------

async function onDrop(e) {
  if (!api) return;
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
  if (!files.length) return;
  const added = [];
  for (const file of files) {
    const filePath = api.pathForFile(file);
    if (!filePath) continue;
    const base = filePath.split(/[\\/]/).pop() || filePath;
    const name = base.replace(/\.[^.]+$/, '');
    const normalizedPath = filePath.replace(/\//g, '\\').toLowerCase();
    const duplicate = cfg.apps.some(item => {
      if (!item.path || String(item.path).startsWith('shell:')) return false;
      return String(item.path).replace(/\//g, '\\').toLowerCase() === normalizedPath;
    });
    if (duplicate) {
      showToast('该软件已在 Dock 中');
      continue;
    }
    const item = {
      id: 'app-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      name,
      path: filePath,
      icon: ''
    };
    const firstFixed = cfg.apps.findIndex(it => !!it.type);
    const at = firstFixed >= 0 ? firstFixed : cfg.apps.length;
    cfg.apps.splice(at, 0, item);
    added.push(item);
  }
  if (!added.length) return;
  ensureAnims();
  syncGeometry();
  startLoop();

  await Promise.all(added.map(async item => {
    try {
      const icon = await api.extractIcon(item.path);
      if (!icon) return;
      const current = cfg.apps.find(entry => entry.id === item.id);
      if (!current) return;
      current.icon = icon;
      systemIcons[current.id] = icon;
    } catch (err) { /* fallback remains */ }
  }));
  await persist(true);
}

// ---------------- 配置 ----------------

function applyTheme(e) {
  document.documentElement.classList.toggle('theme-dark', !!(e && e.matches));
}

function onMinRestored(h) {
  // 点击缩略图 = 从最小化区“移除一项”（和左侧应用图标点击是不同语义，不能照抄），
  // 退出动画在 restoreMinThumb 里先播完，这里只负责真正移除 + 触发整排弹簧收拢。
  const key = String(h);
  minWindows.value = minWindows.value.filter(w => String(w.h) !== key);
  if (minHoverId.value === key) {
    minHoverId.value = '';
    clearTimeout(minTipTimer);
    tip.show = false;
  }
  startLoop();
}

async function restoreMinimized(item) {
  if (!item || !api) return;
  folderOpen.value = '';
  onMinRestored(item.h);
  await new Promise(resolve => setTimeout(resolve, 170));
  try { await api.restoreWindow(item.h); } catch (err) { /* ignore */ }
}

function toggleFolder(kind) {
  folderOpen.value = folderOpen.value === kind ? '' : kind;
  startLoop();
}

function sameJson(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch (err) { return false; }
}

/** 应用列表指纹：图标是 base64，整串比较太重，取长度 + 前后片段辨认换图 */
function appsKey(list) {
  return (list || []).map(it => {
    const ic = String(it.icon || '');
    return [it.id, it.path, it.name, it.type || '', it.width || 0, ic.length, ic.slice(200, 232), ic.slice(-48)].join('\u0001');
  }).join('\u0002');
}

/** 影响图标排布的几何参数：这些一变，整排要一次性落到新尺寸 */
const GEOM_KEYS = ['iconSize', 'height', 'gap', 'padding', 'bottomMargin', 'maxScale', 'magnification'];

function applyConfig(next) {
  if (!next) return;
  // 设置页拖滑杆时每 50ms 就推一次完整配置。原来这里无条件重建 apps/glass/dock/global
  // 并重新抽取系统图标，等于让 Dock 跟着设置页全量重绘，拖动时肉眼可见地卡。
  // 现在按段比对，只改真正变了的段落，图标没变就不重新抽。
  const nextApps = Array.isArray(next.apps) ? next.apps.map(it => ({ ...it })) : [];
  const nextGlass = { ...(next.glass || {}) };
  const nextDock = { ...(next.dock || {}) };
  const nextGlobal = { ...(next.global || {}) };
  let changed = false;

  if (appsKey(cfg.apps) !== appsKey(nextApps)) {
    cfg.apps = nextApps;
    changed = true;
    refreshSystemIcons();
  }
  if (!sameJson(cfg.glass, nextGlass)) { cfg.glass = nextGlass; changed = true; }
  if (!sameJson(cfg.dock, nextDock)) {
    const wasAutoHide = !!cfg.dock.autoHide;
    // 尺寸/间距/高度这类参数变化时，整排图标必须在同一帧直接变成新尺寸。
    // 否则每一项都会带着弹簧从旧尺寸往新尺寸追，拖动过程中新旧混在一起，
    // 折叠进文件夹的项还会从 0 宽撑开 —— 就是那种“有的 8px 有的 50px”的错位。
    if (GEOM_KEYS.some(k => cfg.dock[k] !== nextDock[k])) {
      snapLayoutOnce = true;
      requestAnimationFrame(() => { snapLayoutOnce = false; });
    }
    cfg.dock = nextDock;
    // 设置页关闭自动隐藏时，已经收起的 Dock 必须立即展开，和设置保持同步。
    if (wasAutoHide && !cfg.dock.autoHide) {
      clearTimeout(hideTimer);
      hidden.value = false;
    }
    changed = true;
  }
  if (!sameJson(cfg.global, nextGlobal)) { cfg.global = nextGlobal; changed = true; }
  if (!changed) return;
  ensureAnims();
  syncGeometry();
  startLoop();
}

function onResize() {
  winW.value = window.innerWidth;
  winH.value = window.innerHeight;
  startLoop();
}

onMounted(async () => {
  window.addEventListener('resize', onResize);
  window.addEventListener('pointerup', onGlobalPointerUp, true);
  window.addEventListener('pointercancel', onGlobalPointerUp, true);
  window.addEventListener('blur', cancelPointerState);
  themeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  applyTheme(themeQuery);
  if (themeQuery.addEventListener) themeQuery.addEventListener('change', applyTheme);

  if (!api) {
    showToast('未检测到桌面接口，请在 Electron 中运行');
    return;
  }
  const { config } = await api.getConfig();
  applyConfig(config);
  await refreshWindowInfo();
  winW.value = window.innerWidth;
  winH.value = window.innerHeight;
  view.width = dockW.value;
  view.left = Math.round((winW.value - view.width) / 2);

  offAction = api.onAction(handleAction);
  offCursor = api.onCursorAt(p => {
    if (!p) return;
    // 主进程通知“光标已经离开 Dock”：穿透状态下 DOM 收不到 pointerleave，
    // 这里必须主动清掉指针状态，否则最后那颗图标会一直保持放大，动画也停不下来。
    if (p.out) {
      pointer.active = false;
      hovering.value = -1;
      tip.show = false;
      clearTimeout(tipTimer);
      if (minHoverId.value) onMinHover('');
      statusLabel.value = '';
      statusHover.value = '';
      startLoop();
      return;
    }
    pointer.x = p.x;
    pointer.y = p.y;
    pointer.active = true;
    winW.value = window.innerWidth;
    winH.value = window.innerHeight;
    if (hidden.value && inHiddenRevealBand(pointer.x, pointer.y)) hidden.value = false;
    updateHover();
    startLoop();
  });
  offConfig = api.onConfigUpdated(payload => {
    if (payload && payload.config) {
      applyConfig(payload.config);
      refreshWindowInfo();
    }
  });

  pollRunning();
  runningTimer = setInterval(pollRunning, 3000);
  iconTimer = setInterval(refreshSystemIcons, 15000);

  if (api.minimizedGet) {
    try {
      const res = await api.minimizedGet();
      if (res && Array.isArray(res.items)) { minWindows.value = res.items; startLoop(); }
    } catch (err) { /* 忽略 */ }
  }
  if (api.onMinimized) {
    offMin = api.onMinimized(list => {
      minWindows.value = Array.isArray(list) ? list : [];
      startLoop();
    });
  }
  startLoop();
});

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId);
  clearInterval(runningTimer);
  clearInterval(iconTimer);
  clearTimeout(tipTimer);
  clearTimeout(hideTimer);
  clearTimeout(bounceTimer);
  clearTimeout(saveTimer);
  clearTimeout(rectTimer);
  if (offAction) offAction();
  if (offConfig) offConfig();
  if (offCursor) offCursor();
  if (offMin) offMin();
  if (themeQuery && themeQuery.removeEventListener) themeQuery.removeEventListener('change', applyTheme);
  window.removeEventListener('resize', onResize);
});
</script>

<template>
  <div
    ref="stageRef"
    class="stage"
    :style="{ '--auto-hide-duration': autoHideDurationCss, '--auto-hide-line-delay': autoHideLineDelayCss }"
    :class="{ 'is-hidden': hidden, 'is-dragging': !!dragging && dragging.moved, 'is-over-icon': hovering >= 0 }"
    @pointermove="onPointerMove"
    @pointerleave="onPointerLeave"
    @pointerdown="onPointerDown"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @contextmenu.prevent="onContextMenu"
    @dragover.prevent
    @drop.prevent="onDrop"
  >
    <LiquidGlass
      :panels="glassPanels"
      :pointer="pointer"
      :glass="cfg.glass"
      :winInfo="winInfo"
      :capture-offset="glassCaptureOffset"
      @fallback="glassFallback = true"
    />

    <div v-if="glassFallback" class="dock-shadow fallback" :style="dockBox"></div>

    <div class="dock-collapsed-line" :style="collapsedLine" aria-hidden="true"></div>

    <div class="dock" :style="dockBox">
      <template v-for="item in layoutItems" :key="item.id">
        <div
          v-if="item.type === 'separator'"
          class="dock-separator"
          :style="{ left: (anim(item.id).x + 5.75) + 'px', height: Math.max(22, cfg.dock.height - 24) + 'px', opacity: anim(item.id).size > 0 ? 1 : 0 }"
        ></div>
        <MusicTile
          v-else-if="item.type === 'music'"
          :item="item"
          :width="anim(item.id).size"
          :height="cfg.dock.iconSize"
          :left="anim(item.id).x"
          :bottom="iconBottom"
        />
        <MinimizedZone
          v-else-if="item.type === 'minimized'"
          :items="visibleMinItems"
          :size="cfg.dock.iconSize"
          :gap="cfg.dock.gap"
          :scale="maxScaleOf()"
          :hover-id="minHoverId"
          :width="anim(item.id).size"
          :left="anim(item.id).x"
          :bottom="iconBottom"
          @restored="onMinRestored"
          @hover="onMinHover"
        />
        <StatusTray
          v-else-if="item.type === 'status'"
          :width="anim(item.id).size"
          :height="cfg.dock.iconSize"
          :dock-height="cfg.dock.height"
          :left="anim(item.id).x"
          :bottom="iconBottom"
          :hover-kind="statusHover"
        />
        <DockFolder
          v-else-if="isFolderItem(item)"
          :kind="item.type === 'app-folder' ? 'app' : 'min'"
          :items="item.items"
          :system-icons="systemIcons"
          :size="anim(item.id).size"
          :left="anim(item.id).x"
          :bottom="iconBottom"
          :container-width="view.width"
          :dock-height="cfg.dock.height"
          :dock-bottom="cfg.dock.bottomMargin"
          :stage-height="winH"
          :open="folderOpen === (item.type === 'app-folder' ? 'app' : 'min')"
          @toggle="toggleFolder"
          @close="folderOpen = ''"
          @launch="launch"
          @restore="restoreMinimized"
        />
        <DockIcon
          v-else
          :item="item"
          :system-icon="systemIcons[item.id] || ''"
          :size="anim(item.id).size"
          :left="iconVisualLeft(item)"
          :bottom="iconBottom"
          :running="runningSet.has(item.id)"
          :dragging="!!dragging && dragging.id === item.id"
          :bouncing="bouncingId === item.id"
        />
      </template>
    </div>

    <!-- 缩略图被点开时的“幽灵”：绝对定位、不参与布局，只负责抬起缩小淡出的收尾 -->
    <span
      v-if="minGhost"
      :key="minGhost.id"
      class="min-ghost"
      :style="{ left: minGhost.left + 'px', bottom: minGhost.bottom + 'px', width: minGhost.size + 'px', height: minGhost.size + 'px' }"
    >
      <span
        class="min-ghost-visual"
        :class="{ 'has-icon-frame': minGhost.frame, 'is-pending': !minGhost.ready }"
      >
        <img v-if="minGhost.icon" :src="minGhost.icon" alt="" draggable="false" />
        <span v-else class="min-ghost-letter">{{ minGhost.letter }}</span>
      </span>
    </span>

    <GlassTooltip
      v-if="tip.show"
      :label="tip.label"
      :x="tip.x"
      :y="tip.y"
      :w="tip.w"
      :h="tip.h"
    />

    <div
      v-if="rename.show"
      class="rename-panel"
      :style="{ left: rename.x + 'px', top: rename.y + 'px', width: rename.w + 'px', height: rename.h + 'px' }"
      @pointerdown.stop
      @pointerup.stop
    >
      <input
        ref="renameInput"
        v-model="rename.value"
        type="text"
        spellcheck="false"
        @keydown.enter.prevent="commitRename"
        @keydown.esc.prevent="cancelRename"
        @blur="commitRename"
      />
    </div>

    <div v-if="toast.show" class="toast">{{ toast.text }}</div>
  </div>
</template>
