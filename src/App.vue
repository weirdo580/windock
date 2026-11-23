<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import LiquidGlass from './components/LiquidGlass.vue';
import DockIcon from './components/DockIcon.vue';
import DockFolder from './components/DockFolder.vue';
import GlassTooltip from './components/GlassTooltip.vue';
import MusicTile from './components/MusicTile.vue';
import MinimizedZone from './components/MinimizedZone.vue';

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

// ---------------- 基础布局 ----------------

// ---------------- 基础布局 ----------------

const MUSIC_W = 168;
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

const dockCapacity = computed(() => {
  const totalApps = regularApps.value.length;
  const totalWindows = minWindows.value.length;
  const screenWidth = Number(winInfo.value.display?.width) || winW.value;
  const maxWidth = Math.max(260, Math.min(screenWidth - 24, winW.value - 12));
  const hoverGrow = cfg.dock.iconSize * (maxScaleOf() - 1);
  let appCount = totalApps;
  let windowCount = totalWindows;
  let layout = buildLayout(appCount, windowCount);
  let guard = 0;

  while (layoutWidth(layout) + hoverGrow > maxWidth && guard < totalApps + totalWindows + 12) {
    guard += 1;
    // 最小化区先自己收缩，绝不为了给最小化窗口腾位置去动左侧应用区。
    if (windowCount > 0) windowCount -= 1;
    else if (appCount > 0) appCount -= 1;
    else break;
    layout = buildLayout(appCount, windowCount);
  }
  // 容量算完后再把“只装一个窗口”的文件夹换成窗口本体：
  // 两者占用的都是同一个图标宽度，不会挤压左侧应用，也不会改变总宽度。
  if (layout.minOverflow.length === 1) layout = buildLayout(appCount, windowCount + 1);
  return layout;
});

const layoutItems = computed(() => dockCapacity.value.items);
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

const glassPanels = computed(() => {
  const list = [];
  if (!winW.value) return list;
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
    anims[id] = { size: baseSize(item), vel: 0, x: 0 };
  }
  return anims[id];
}

function baseSize(item) {
  return layoutItemBaseWidth(item);
}

function ensureAnims() {
  const ids = new Set(layoutItems.value.map(item => item.id));
  layoutItems.value.forEach(item => {
    if (!anims[item.id]) anims[item.id] = { size: baseSize(item), vel: 0, x: 0 };
  });
  Object.keys(anims).forEach(id => { if (!ids.has(id)) delete anims[id]; });
}

watch(
  () => layoutItems.value.map(item => item.id).join('|'),
  () => {
    ensureAnims();
    startLoop();
  }
);

function maxScaleOf() {
  return cfg.dock.magnification === false ? 1 : Math.max(1, Number(cfg.dock.maxScale) || 1.4);
}

function inDockBand(x, y) {
  const d = cfg.dock;
  if (hidden.value) return false;
  const top = winH.value - d.bottomMargin - d.height - d.iconSize * (maxScaleOf() - 1) - 10;
  return x >= view.left - 12 && x <= view.left + view.width + 12 && y >= top && y <= winH.value;
}

function hitIcon(x, y) {
  const d = cfg.dock;
  const glassTop = winH.value - d.bottomMargin - d.height;
  const topLimit = glassTop - d.iconSize * (maxScaleOf() - 1) - 6;
  if (y < topLimit || y > winH.value - d.bottomMargin + 2) return -1;
  const relX = x - view.left;
  for (let i = 0; i < layoutItems.value.length; i++) {
    const item = layoutItems.value[i];
    if (item.type === 'separator' || item.type === 'music' || item.type === 'minimized') continue;
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
    if (item.type === 'minimized') {
      // 最小化窗口区宽度弹性过渡：增减窗口时整条 Dock 同步收回/展开，不是硬跳
      const target = baseSize(item);
      a.vel += (target - a.size) * 0.26;
      a.vel *= 0.72;
      a.size += a.vel;
      if (Math.abs(target - a.size) < 0.05 && Math.abs(a.vel) < 0.05) { a.size = target; a.vel = 0; }
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
  let total = d.padding * 2;
  items.forEach((item, i) => {
    total += anim(item.id).size + (i < items.length - 1 ? gap : 0);
  });
  const width = Math.round(Math.min(winW.value, total));
  if (view.width !== width) {
    view.width = width;
    view.left = Math.max(0, Math.round((winW.value - width) / 2));
  }

  // 行内顺序排布：图标之间、图标与分隔线之间都按实际宽度累加，不会互相压住
  let p = d.padding;
  items.forEach((item, i) => {
    const a = anim(item.id);
    if (a.size <= 0) {
      a.x = p;
      return;
    }
    a.x = p;
    p += a.size + gap;
  });

  const settled = items.every(item => {
    if (item.type === 'music') return true;
    if (item.type === 'separator' || item.type === 'minimized') {
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
  const idx = hitIcon(pointer.x, pointer.y);
  if (idx < 0 || idx !== requested) return;
  const item = layoutItems.value[idx];
  if (!item) return;
  const d = cfg.dock;
  const a = anim(item.id);
  const label = item.name || '应用';
  // 左右各 12px 内边距 + 1px 边框，宽度按 border-box 计算，保证提示框中心与图标中心对齐
  const w = Math.min(230, Math.max(74, label.length * 13 + 26)) + 26;
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

const hitRects = computed(() => {
  if (dragging.value) return [{ x: 0, y: 0, w: winW.value, h: winH.value }];
  if (hidden.value) return [{ x: 0, y: winH.value - 8, w: winW.value, h: 8 }];
  // 文件夹展开时，整个 Dock 窗口都接收点击：点任意空白处都能关闭弹层，
  // 弹层和文件夹自身会在组件里阻止事件冒泡，不会误关。
  if (folderOpen.value) return [{ x: 0, y: 0, w: winW.value, h: winH.value }];
  const list = [{
    x: view.left - 12,
    y: bandTop.value,
    w: view.width + 24,
    h: winH.value - bandTop.value
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

// ---------------- 指针交互 ----------------

function onPointerMove(e) {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.active = true;
  winW.value = window.innerWidth;
  winH.value = window.innerHeight;

  if (hidden.value && pointer.y > winH.value - 10) hidden.value = false;
  startLoop();

  if (cfg.dock.autoHide) {
    if (inDockBand(pointer.x, pointer.y)) clearTimeout(hideTimer);
    else scheduleHide();
  }

  updateHover();

  if (dragging.value) {
    dragging.value.currentX = e.clientX;
    updateDrag(e.clientX);
  }
}

function onPointerLeave() {
  pointer.active = false;
  hovering.value = -1;
  tip.show = false;
  clearTimeout(tipTimer);
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
  const d = dragging.value;
  if (!d) return;
  dragging.value = null;
  try { stageRef.value.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
  if (d.moved) persist(true);
  else launch(d.id);
  startLoop();
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
  // 点了就立刻从 Dock 里收回，让整排图标和底板同步滑回去（之后桥的轮询会自动对齐）
  minWindows.value = minWindows.value.filter(w => w.h !== h);
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

function applyConfig(next) {
  if (!next) return;
  cfg.apps = Array.isArray(next.apps) ? next.apps.map(it => ({ ...it })) : [];
  cfg.glass = { ...(next.glass || {}) };
  cfg.dock = { ...(next.dock || {}) };
  cfg.global = { ...(next.global || {}) };
  ensureAnims();
  startLoop();
  refreshSystemIcons();
}

function onResize() {
  winW.value = window.innerWidth;
  winH.value = window.innerHeight;
  startLoop();
}

onMounted(async () => {
  window.addEventListener('resize', onResize);
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
    pointer.x = p.x;
    pointer.y = p.y;
    pointer.active = true;
    winW.value = window.innerWidth;
    winH.value = window.innerHeight;
    if (hidden.value && pointer.y > winH.value - 10) hidden.value = false;
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
      @fallback="glassFallback = true"
    />

    <div v-if="glassFallback" class="dock-shadow fallback" :style="dockBox"></div>

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
          :width="anim(item.id).size"
          :left="anim(item.id).x"
          :bottom="iconBottom"
          @restored="onMinRestored"
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
