<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import windockIcon from './assets/windock-icon.png';

const api = window.dockApi;
const activeTab = ref('dock');
const draft = ref(null);
const savedJson = ref('');
const loading = ref(true);
const saving = ref(false);
const message = ref('');
const previewing = ref(false);
const appIcons = reactive({});
const iconCache = new Map();
let offConfig = null;
let previewTimer = null;
let saveTimer = null;
let previewPending = false;
let previewInFlight = false;
let previewLast = 0;
let saveQueued = false;
let applying = false;

const tabs = [
  { id: 'dock', title: 'Dock', subtitle: '尺寸、布局与动画' },
  { id: 'glass', title: '液态玻璃', subtitle: '材质、光学与采样' },
  { id: 'apps', title: '软件', subtitle: '图标与排列' },
  { id: 'behavior', title: '行为', subtitle: '显示与交互' }
];

const clone = value => JSON.parse(JSON.stringify(value));
const dirty = computed(() => !!draft.value && JSON.stringify(draft.value) !== savedJson.value);
const apps = computed(() => draft.value?.apps?.filter(item => !item.type) || []);
const fixedItems = computed(() => draft.value?.apps?.filter(item => !!item.type) || []);
const statusText = computed(() => {
  if (saving.value) return '正在自动保存…';
  if (dirty.value) return '实时同步中';
  return '已自动保存';
});

function applyConfig(next) {
  const config = clone(next || {});
  config.apps = Array.isArray(config.apps) ? config.apps : [];
  config.glass = config.glass || {};
  config.glass.shadow = 0;
  config.dock = config.dock || {};
  config.global = config.global || {};
  applying = true;
  draft.value = config;
  savedJson.value = JSON.stringify(config);
  loading.value = false;
  previewing.value = false;
  nextTick(() => { applying = false; });
  refreshAppIcons();
}

function normalizeIcon(icon) {
  if (!icon) return '';
  if (icon.startsWith('data:')) return icon;
  return './' + icon.replace(/^\.\//, '');
}

const BUILTIN_ICONS = {
  trash: 'icons/trash.svg',
  notepad: 'icons/notepad.svg',
  explorer: 'icons/explorer.svg',
  calculator: 'icons/calculator.svg'
};

function iconFor(item) {
  if (item.iconCustom && item.customIcon) return item.customIcon;
  return appIcons[item.id] || normalizeIcon(item.icon || '');
}

async function refreshAppIcons() {
  if (!api?.extractIcon || !draft.value) return;
  for (const item of apps.value) {
    if (appIcons[item.id]) continue;
    const cached = iconCache.get(item.path);
    if (cached) {
      appIcons[item.id] = cached;
      continue;
    }
    try {
      const icon = await api.extractIcon(item.path);
      if (icon) {
        appIcons[item.id] = icon;
        iconCache.set(item.path, icon);
      }
    } catch (err) { /* keep configured icon */ }
  }
}

function showMessage(text) {
  message.value = text;
  clearTimeout(showMessage.timer);
  showMessage.timer = setTimeout(() => { message.value = ''; }, 2400);
}

function clampDraft(config) {
  const d = config.dock;
  d.iconSize = clamp(d.iconSize, 36, 76);
  d.height = Math.max(d.iconSize + 8, clamp(d.height, 52, 110));
  d.gap = clamp(d.gap, 2, 24);
  d.padding = clamp(d.padding, 8, 44);
  d.bottomMargin = clamp(d.bottomMargin, 0, 80);
  d.maxScale = clamp(d.maxScale, 1, 1.8);
  d.effectStrength = clamp(d.effectStrength, 0.05, 1);
  d.animationDuration = clamp(d.animationDuration, 80, 600);
  d.autoHideDelay = clamp(d.autoHideDelay, 100, 4000);
  d.autoHideDuration = clamp(d.autoHideDuration, 100, 1200);
  const g = config.glass;
  g.radius = clamp(g.radius, 10, 30);
  g.refraction = clamp(g.refraction, 0, 1);
  g.fresnel = clamp(g.fresnel, 0, 1.8);
  g.blur = clamp(g.blur, 0, 2.5);
  g.saturation = 1;
  g.opacity = clamp(g.opacity, 0, 0.35);
  g.captureInterval = clamp(g.captureInterval, 100, 60000);
  g.captureWidth = clamp(g.captureWidth, 320, 1920);
  return config;
}

async function autoSave() {
  if (!draft.value || !api) return;
  if (saving.value) {
    saveQueued = true;
    return;
  }
  clearTimeout(previewTimer);
  previewTimer = null;
  previewPending = false;
  clampDraft(draft.value);
  saving.value = true;
  try {
    const res = await api.saveConfig(clone(draft.value));
    if (res?.config) savedJson.value = JSON.stringify(res.config);
    else savedJson.value = JSON.stringify(draft.value);
    previewing.value = false;
  } catch (err) {
    showMessage('自动保存失败：' + err.message);
  } finally {
    saving.value = false;
    if (saveQueued || dirty.value) {
      saveQueued = false;
      scheduleAutoSave();
    }
  }
}

// 实时预览用节流而不是防抖：拖动滑块的过程中也会持续把最新草稿送到 Dock。
function schedulePreview() {
  if (!api?.previewConfig || !draft.value || loading.value || applying || saving.value) return;
  previewPending = true;
  if (previewInFlight || previewTimer) return;
  const wait = Math.max(0, 50 - (performance.now() - previewLast));
  if (wait <= 0) flushPreview();
  else previewTimer = setTimeout(flushPreview, wait);
}

async function flushPreview() {
  previewTimer = null;
  if (previewInFlight || !previewPending || !draft.value) return;
  previewPending = false;
  previewInFlight = true;
  previewLast = performance.now();
  try {
    await api.previewConfig(clone(draft.value));
    previewing.value = true;
  } catch (err) {
    previewing.value = false;
  } finally {
    previewInFlight = false;
    if (previewPending) schedulePreview();
  }
}

// 停止操作一小段时间后落盘，避免拖动滑块时反复写配置文件。
function scheduleAutoSave() {
  if (!api?.saveConfig || !draft.value || loading.value || applying) return;
  if (saving.value) {
    saveQueued = true;
    return;
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (dirty.value) autoSave();
  }, 360);
}

async function reload() {
  if (!api) return;
  clearTimeout(previewTimer);
  previewTimer = null;
  clearTimeout(saveTimer);
  saveTimer = null;
  previewPending = false;
  saveQueued = false;
  const res = await api.reloadConfig?.();
  if (res?.config) applyConfig(res.config);
  else if (res) applyConfig(res);
  showMessage('已恢复到上次保存的配置');
}

async function openConfigFile() {
  if (!api?.openConfig) return;
  await api.openConfig();
  showMessage('已打开配置文件');
}

function clamp(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}

async function chooseApp() {
  if (!api?.chooseApp) return;
  const picked = await api.chooseApp();
  if (!picked) return;
  const normalized = picked.path.replace(/\//g, '\\').toLowerCase();
  if (apps.value.some(item => String(item.path || '').replace(/\//g, '\\').toLowerCase() === normalized)) {
    showMessage('该软件已在 Dock 中');
    return;
  }
  const item = {
    id: 'app-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    name: picked.name,
    path: picked.path,
    icon: picked.icon || ''
  };
  const firstFixed = draft.value.apps.findIndex(entry => !!entry.type);
  draft.value.apps.splice(firstFixed < 0 ? draft.value.apps.length : firstFixed, 0, item);
  if (picked.icon) appIcons[item.id] = picked.icon;
}

function removeApp(item) {
  const index = draft.value.apps.findIndex(entry => entry.id === item.id);
  if (index >= 0) draft.value.apps.splice(index, 1);
}

async function changeIcon(item) {
  if (!api?.chooseIcon) return;
  const picked = await api.chooseIcon();
  if (!picked) return;
  if (picked.error) {
    showMessage('更换图标失败：' + picked.error);
    return;
  }
  if (picked.icon) {
    item.customIcon = picked.icon;
    item.iconCustom = true;
    appIcons[item.id] = picked.icon;
    schedulePreview();
    scheduleAutoSave();
    showMessage('图标已更换，正在自动保存');
  }
}

async function resetIcon(item) {
  if (!item.iconCustom) return;
  const builtin = BUILTIN_ICONS[item.id];
  if (builtin) {
    item.icon = builtin;
  } else if (api?.extractIcon && item.path && !String(item.path).startsWith('shell:')) {
    try {
      const icon = await api.extractIcon(item.path);
      if (icon) item.icon = icon;
    } catch (err) { /* 保留原图标，至少不会清空 */ }
  }
  item.iconCustom = false;
  item.customIcon = '';
  delete appIcons[item.id];
  schedulePreview();
  scheduleAutoSave();
  showMessage('已恢复默认图标');
}

function moveApp(index, direction) {
  const list = apps.value.slice();
  const target = index + direction;
  if (target < 0 || target >= list.length) return;
  [list[index], list[target]] = [list[target], list[index]];
  let cursor = 0;
  draft.value.apps = draft.value.apps.map(entry => entry.type ? entry : list[cursor++]);
}

function typeLabel(item) {
  if (item.type === 'music') return '音乐组件';
  if (item.type === 'minimized') return '最小化窗口';
  return '分隔符';
}

const previewIcons = computed(() => apps.value.slice(0, 8));
const previewIconStyle = computed(() => {
  const size = Number(draft.value?.dock?.iconSize) || 56;
  const value = Math.max(25, Math.min(40, size * 0.66));
  return { width: value + 'px', height: value + 'px', borderRadius: Math.round(value * 0.22) + 'px' };
});
const previewDockStyle = computed(() => {
  const d = draft.value?.dock || {};
  const g = draft.value?.glass || {};
  const height = Math.round(Math.max(52, Math.min(82, (Number(d.height) || 72) * 0.92)));
  const gap = Math.round(Math.max(3, Math.min(14, (Number(d.gap) || 8) * 0.55)));
  const pad = Math.round(Math.max(7, Math.min(22, (Number(d.padding) || 18) * 0.55)));
  return {
    height: height + 'px',
    padding: '0 ' + pad + 'px',
    gap: gap + 'px',
    borderRadius: (Number(g.radius) || 26) + 'px',
    background: 'rgba(255,255,255,' + Math.max(0.06, Math.min(0.24, (Number(g.opacity) || 0.05) + 0.09)).toFixed(2) + ')',
    backdropFilter: 'blur(' + Math.max(8, (Number(g.blur) || 0.9) * 14).toFixed(0) + 'px)',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,.28)'
  };
});

onMounted(async () => {
  document.title = 'WinDock 设置';
  if (!api) {
    loading.value = false;
    showMessage('未检测到 Dock 接口');
    return;
  }
  const res = await api.getConfig();
  applyConfig(res?.config);
  offConfig = api.onConfigUpdated(payload => {
    if (payload?.config && !dirty.value) applyConfig(payload.config);
  });
});

onBeforeUnmount(() => {
  if (offConfig) offConfig();
  clearTimeout(showMessage.timer);
  clearTimeout(previewTimer);
  clearTimeout(saveTimer);
  // 关闭瞬间还有未落盘的改动时，先把最新草稿送到主进程，由 closed 回调补存。
  if (dirty.value && api?.previewConfig && draft.value) {
    api.previewConfig(clone(draft.value)).catch(() => {});
  }
});

watch(() => apps.value.map(item => item.id).join(','), refreshAppIcons);
watch(draft, () => {
  schedulePreview();
  scheduleAutoSave();
}, { deep: true });
</script>

<template>
  <div class="settings-shell">
  <aside class="settings-rail">
    <div class="rail-brand">
      <img class="brand-icon" :src="windockIcon" alt="" />
      <div>
        <div class="brand-title">WinDock</div>
        <div class="brand-subtitle">Windows 桌面程序坞</div>
      </div>
    </div>
    <div class="rail-label">偏好设置</div>
    <nav class="rail-nav">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="nav-item"
        :class="{ active: activeTab === tab.id }"
        @click="activeTab = tab.id"
      >
        <span class="nav-copy">
          <strong>{{ tab.title }}</strong>
          <small>{{ tab.subtitle }}</small>
        </span>
      </button>
    </nav>
  </aside>

  <div class="settings-main">
    <header class="settings-topbar">
      <div class="topbar-copy">
        <span class="topbar-eyebrow">设置</span>
        <h1 class="topbar-title">{{ tabs.find(tab => tab.id === activeTab)?.title }}</h1>
      </div>
      <button class="undo-icon" :disabled="!dirty" aria-label="放弃未保存的修改" @click="reload">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M4 9a6 6 0 1 1 1.8 4.3" />
          <path d="M4 4.5V9h4.5" />
        </svg>
      </button>
    </header>

    <main class="settings-content">
        <div v-if="loading" class="loading-state">正在读取 Dock 配置…</div>

        <section v-else class="preview-card">
          <div class="preview-copy">
            <span class="eyebrow">外观预览</span>
            <h1 class="preview-title">桌面 Dock</h1>
            <div class="preview-metrics">
              <span><b>{{ draft.dock.iconSize }}</b> px 图标</span>
              <span><b>{{ draft.glass.radius }}</b> px 圆角</span>
            </div>
            <div class="preview-meta">
              <span class="pulse-dot"></span>
              <span>调整参数会立即同步到桌面 Dock</span>
            </div>
          </div>
          <div class="preview-stage">
            <div class="preview-dock" :style="previewDockStyle">
              <span
                v-for="item in previewIcons"
                :key="item.id"
                class="preview-icon"
                :class="{ 'is-custom': item.iconCustom && item.customIcon }"
                :style="previewIconStyle"
              >
                <img v-if="iconFor(item)" :src="iconFor(item)" alt="" />
                <span v-else>{{ (item.name || '?').slice(0, 1) }}</span>
              </span>
            </div>
          </div>
        </section>

        <template v-if="draft && activeTab === 'dock'">
          <section class="panel-grid">
            <article class="setting-card">
              <div class="card-heading">
                <div><h2>尺寸与布局</h2><p>控制 Dock 的整体占用空间。</p></div>
              </div>
              <label class="setting-row">
                <span><b>图标大小</b><small>底层软件图标的基准尺寸</small></span>
                <output>{{ draft.dock.iconSize }} px</output>
                <input v-model.number="draft.dock.iconSize" type="range" min="36" max="76" step="1" />
              </label>
              <label class="setting-row">
                <span><b>Dock 高度</b><small>玻璃底板的高度</small></span>
                <output>{{ draft.dock.height }} px</output>
                <input v-model.number="draft.dock.height" type="range" min="52" max="110" step="1" />
              </label>
              <label class="setting-row">
                <span><b>图标间距</b><small>相邻图标之间的距离</small></span>
                <output>{{ draft.dock.gap }} px</output>
                <input v-model.number="draft.dock.gap" type="range" min="2" max="24" step="1" />
              </label>
              <label class="setting-row">
                <span><b>距屏幕底部</b><small>Dock 距离屏幕底边的位置</small></span>
                <output>{{ draft.dock.bottomMargin }} px</output>
                <input v-model.number="draft.dock.bottomMargin" type="range" min="0" max="80" step="1" />
              </label>
            </article>

            <article class="setting-card">
              <div class="card-heading">
                <div><h2>悬停放大</h2><p>调整鼠标经过图标时的放大手感。</p></div>
              </div>
              <label class="toggle-row">
                <span><b>开启放大</b><small>鼠标靠近图标时突出当前应用</small></span>
                <input v-model="draft.dock.magnification" class="switch" type="checkbox" />
              </label>
              <label class="setting-row">
                <span><b>最大缩放</b><small>悬停图标的最大显示倍率</small></span>
                <output>{{ Number(draft.dock.maxScale).toFixed(2) }}×</output>
                <input v-model.number="draft.dock.maxScale" type="range" min="1" max="1.8" step="0.01" />
              </label>
              <label class="toggle-row">
                <span><b>点击回弹</b><small>启动应用时显示弹跳动画</small></span>
                <input v-model="draft.dock.bounce" class="switch" type="checkbox" />
              </label>
            </article>
          </section>
        </template>

        <template v-if="draft && activeTab === 'glass'">
          <section class="panel-grid">
            <article class="setting-card">
              <div class="card-heading">
                <div><h2>玻璃轮廓</h2><p>调整底板圆角和边缘高光。</p></div>
              </div>
              <label class="setting-row">
                <span><b>圆角</b><small>Dock 玻璃底板的圆角半径</small></span>
                <output>{{ draft.glass.radius }} px</output>
                <input v-model.number="draft.glass.radius" type="range" min="10" max="30" step="1" />
              </label>
              <label class="setting-row">
                <span><b>边缘高光</b><small>Fresnel 反射与轮廓亮度</small></span>
                <output>{{ Math.round(draft.glass.fresnel * 100) }}%</output>
                <input v-model.number="draft.glass.fresnel" type="range" min="0" max="1.8" step="0.01" />
              </label>
            </article>
            <article class="setting-card">
              <div class="card-heading">
                <div><h2>背景与控制</h2><p>调整玻璃的清晰度和透明度。</p></div>
              </div>
              <label class="setting-row">
                <span><b>背景模糊</b><small>透过玻璃看到的桌面柔化程度</small></span>
                <output>{{ Number(draft.glass.blur).toFixed(2) }}</output>
                <input v-model.number="draft.glass.blur" type="range" min="0" max="2.5" step="0.01" />
              </label>
              <label class="setting-row">
                <span><b>玻璃浓度</b><small>数值越高，玻璃主体越明显</small></span>
                <output>{{ Math.round(draft.glass.opacity * 100) }}%</output>
                <input v-model.number="draft.glass.opacity" type="range" min="0" max="0.35" step="0.005" />
              </label>
            </article>
            <article class="setting-card full-span">
              <div class="card-heading">
                <div><h2>桌面采样</h2><p>玻璃折射使用真实桌面画面，采样频率越高越跟手。</p></div>
              </div>
              <div class="split-settings">
                <label class="setting-row">
                  <span><b>采样间隔</b><small>两次桌面截图之间等待的时间</small></span>
                  <output>{{ (draft.glass.captureInterval / 1000).toFixed(1) }} s</output>
                  <input v-model.number="draft.glass.captureInterval" type="range" min="100" max="60000" step="100" />
                </label>
                <label class="setting-row">
                  <span><b>采样宽度</b><small>桌面缩略图的分辨率宽度</small></span>
                  <output>{{ draft.glass.captureWidth }} px</output>
                  <input v-model.number="draft.glass.captureWidth" type="range" min="320" max="1920" step="16" />
                </label>
              </div>
              <div class="hint-line">建议间隔 10–30 秒；高分辨率屏幕无需把宽度拉到物理分辨率。</div>
            </article>
          </section>
        </template>

        <template v-if="draft && activeTab === 'apps'">
          <section class="apps-panel">
            <div class="apps-header">
              <div class="app-header-copy">
                <h2>软件与组件 <span class="app-count">{{ apps.length }} 个</span></h2>
                <p>用上下按钮调整顺序；只影响 Dock 的显示，不会移动或删除原程序。</p>
              </div>
              <button class="button primary" @click="chooseApp">添加软件</button>
            </div>
            <div class="app-list">
              <div v-if="!apps.length" class="empty-state">还没有软件，点击右上角“添加软件”开始。</div>
              <div v-for="(item, index) in apps" :key="item.id" class="app-row">
                <span class="app-icon" :class="{ 'is-custom': item.iconCustom && item.customIcon }">
                  <img v-if="iconFor(item)" :src="iconFor(item)" alt="" />
                  <span v-else>{{ (item.name || '?').slice(0, 1) }}</span>
                </span>
                <span class="app-copy">
                  <input v-model="item.name" class="app-name" spellcheck="false" />
                  <small :title="item.path">{{ item.path }}</small>
                </span>
                <span class="app-actions">
                  <button class="mini-button icon-button" title="更换图标" @click="changeIcon(item)">
                    <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M2.5 11l3.2-3.2 2.4 2.4 2.4-2.4 3 3" /></svg>
                  </button>
                  <button class="mini-button" :disabled="!item.iconCustom" title="恢复默认图标" @click="resetIcon(item)">
                    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.8v4h4" /><path d="M3.3 6.8A5 5 0 1 1 3 9.4" /></svg>
                  </button>
                  <button class="mini-button" :disabled="index === 0" title="上移" @click="moveApp(index, -1)">
                    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12.5V3.5M4.5 7 8 3.5 11.5 7" /></svg>
                  </button>
                  <button class="mini-button" :disabled="index === apps.length - 1" title="下移" @click="moveApp(index, 1)">
                    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M4.5 9 8 12.5 11.5 9" /></svg>
                  </button>
                  <button class="mini-button danger" title="从 Dock 移除" @click="removeApp(item)">
                    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
                  </button>
                </span>
              </div>
            </div>
            <div v-if="fixedItems.length" class="fixed-list">
              <div class="fixed-title">固定组件</div>
              <div v-for="item in fixedItems" :key="item.id" class="fixed-row">
                <span>{{ typeLabel(item) }}</span>
                <small>由 Dock 自动管理</small>
              </div>
            </div>
          </section>
        </template>

        <template v-if="draft && activeTab === 'behavior'">
          <section class="panel-grid">
            <article class="setting-card">
              <div class="card-heading">
                <div><h2>显示行为</h2><p>控制 Dock 何时出现，以及如何与窗口配合。</p></div>
              </div>
              <label class="toggle-row">
                <span><b>始终置顶</b><small>保持 Dock 显示在其他普通窗口上方</small></span>
                <input v-model="draft.global.alwaysOnTop" class="switch" type="checkbox" />
              </label>
              <label class="toggle-row">
                <span><b>开机自启动</b><small>登录 Windows 后自动启动 WinDock</small></span>
                <input v-model="draft.global.autoStart" class="switch" type="checkbox" />
              </label>
              <label class="toggle-row">
                <span><b>显示名称提示</b><small>悬停图标时显示软件名称</small></span>
                <input v-model="draft.global.tooltip" class="switch" type="checkbox" />
              </label>
              <label class="toggle-row">
                <span><b>自动隐藏</b><small>鼠标离开后将 Dock 收起</small></span>
                <input v-model="draft.dock.autoHide" class="switch" type="checkbox" />
              </label>
              <label class="setting-row">
                <span><b>隐藏延迟</b><small>鼠标离开后等待多久收起</small></span>
                <output>{{ draft.dock.autoHideDelay }} ms</output>
                <input v-model.number="draft.dock.autoHideDelay" type="range" min="200" max="3000" step="50" />
              </label>
              <label class="setting-row">
                <span><b>收起时长</b><small>滑出/收起动画的持续时间</small></span>
                <output>{{ draft.dock.autoHideDuration }} ms</output>
                <input v-model.number="draft.dock.autoHideDuration" type="range" min="100" max="1200" step="10" />
              </label>
            </article>
            <article class="setting-card info-card">
              <h2>关于 WinDock</h2>
              <p>WinDock 是一个放在 Windows 桌面底部的程序坞，把常用软件、文件夹和正在运行的应用集中在一起，点一下就能打开。图标大小、玻璃质感、软件排列和显示方式都可以在这里调整，修改会实时同步到桌面 Dock。</p>
              <p class="contact-note">如果有建议或者想法，可以发邮件到 <span>3209431882@qq.com</span></p>
            </article>
          </section>
        </template>
      </main>
    </div>

    <transition name="toast">
      <div v-if="message" class="settings-toast">{{ message }}</div>
    </transition>
  </div>
</template>

<style scoped>
:global(.settings-mode),
:global(.settings-mode body),
:global(.settings-mode #app) {
  height: 100%;
  overflow: hidden;
  background: #0d0f11;
}

.settings-shell {
  color-scheme: dark;
  --bg: #0d0f11;
  --rail: #111315;
  --panel: #16181b;
  --panel-soft: #1a1d20;
  --line: #272b2f;
  --line-soft: #22262a;
  --text: #e9ecef;
  --muted: #8a9199;
  --accent: #6f95d8;
  --accent-strong: #4f79c7;
  height: 100vh;
  display: grid;
  grid-template-columns: 216px minmax(0, 1fr);
  color: var(--text);
  background: var(--bg);
  font-family: "Segoe UI Variable Text", "Microsoft YaHei UI", "PingFang SC", sans-serif;
}
.settings-shell,
.settings-shell *,
.settings-shell *::before,
.settings-shell *::after {
  box-sizing: border-box;
}

.settings-rail {
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 22px 14px 18px;
  background: var(--rail);
  border-right: 1px solid #23272b;
}
.rail-brand,
.header-actions,
.card-heading,
.apps-header,
.app-row,
.app-actions,
.fixed-row {
  display: flex;
  align-items: center;
}
.rail-brand { gap: 10px; padding: 0 10px 28px; }
.brand-icon {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  object-fit: cover;
  flex: 0 0 auto;
  border: 1px solid rgba(255, 255, 255, .08);
}
.brand-title { font-size: 14px; font-weight: 600; letter-spacing: .1px; }
.brand-subtitle { margin-top: 3px; font-size: 9.5px; color: #7d858d; }
.rail-label {
  padding: 0 12px;
  margin-bottom: 8px;
  font-size: 9px;
  letter-spacing: .14em;
  color: #6d757d;
}
.rail-nav { display: flex; flex-direction: column; gap: 2px; }
.nav-item {
  position: relative;
  width: 100%;
  padding: 10px 12px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 140ms ease;
}
.nav-item:hover { background: #171a1d; }
.nav-item.active { background: #1d2125; }
.nav-item.active::before {
  content: "";
  position: absolute;
  left: 0;
  top: 10px;
  bottom: 10px;
  width: 2px;
  border-radius: 2px;
  background: var(--accent);
}
.nav-copy strong {
  display: block;
  font-size: 12.5px;
  font-weight: 500;
  color: #c5cbd1;
}
.nav-copy small {
  display: block;
  margin-top: 2px;
  font-size: 10px;
  color: #79818a;
}
.nav-item.active strong { color: #f1f4f7; }
.nav-item.active small { color: #a0a7af; }
.rail-footer {
  margin-top: auto;
  padding: 14px 10px 0;
  border-top: 1px solid #23272b;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 9.5px;
  color: #6f777f;
}

.settings-main {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}
.settings-topbar {
  height: 64px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 28px;
  border-bottom: 1px solid #23272b;
  background: #0f1113;
}
.topbar-copy { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.topbar-eyebrow {
  font-size: 9px;
  letter-spacing: .14em;
  color: #6f7780;
}
.topbar-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: .01em;
  color: #eef2f5;
}
.header-actions { gap: 10px; flex: 0 0 auto; }
.live-state {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: #78818a;
  font-size: 10px;
  white-space: nowrap;
}
.live-state i { width: 5px; height: 5px; border-radius: 50%; background: #565e66; }
.live-state.active { color: #aabfd9; }
.live-state.active i { background: var(--accent); }
.undo-icon {
  width: 28px;
  height: 28px;
  margin-left: auto;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: #858e97;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease, color 140ms ease;
}
.undo-icon svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.undo-icon:hover:not(:disabled) { background: #191d20; border-color: #2d3237; color: #e6ebef; }
.undo-icon:disabled { opacity: .24; cursor: default; }

.button,
.mini-button {
  border: 0;
  font: inherit;
  cursor: pointer;
}
.button {
  height: 32px;
  padding: 0 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  color: var(--text);
  font-size: 11.5px;
  font-weight: 500;
  transition: background 140ms ease, border-color 140ms ease, color 140ms ease;
}
.button.ghost { background: transparent; border: 1px solid #2d3237; color: #bcc3ca; }
.button.ghost:hover:not(:disabled) { background: #181b1e; border-color: #383e44; color: #e8ecef; }
.button.primary { background: var(--accent-strong); border: 1px solid var(--accent-strong); color: #f5f9ff; }
.button.primary:hover { background: #5d88d8; border-color: #5d88d8; }
.button:disabled { opacity: .32; cursor: default; }

.settings-content {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 24px 28px 36px;
}
.settings-content > * {
  width: 100%;
  max-width: 1080px;
  margin-left: auto;
  margin-right: auto;
}
.settings-content::-webkit-scrollbar { width: 10px; }
.settings-content::-webkit-scrollbar-track { background: transparent; }
.settings-content::-webkit-scrollbar-thumb {
  border: 3px solid var(--bg);
  border-radius: 8px;
  background: #343a40;
}
.loading-state { padding: 100px; text-align: center; color: var(--muted); }

.preview-card {
  position: relative;
  min-height: 224px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid #2a2f34;
  background:
    linear-gradient(180deg, rgba(13, 15, 17, .08) 0%, rgba(13, 15, 17, .22) 45%, rgba(13, 15, 17, .86) 100%),
    linear-gradient(90deg, rgba(13, 15, 17, .75) 0%, rgba(13, 15, 17, .28) 48%, rgba(13, 15, 17, .04) 75%, rgba(13, 15, 17, 0) 100%),
    url('./assets/preview-background.png') 0% center / 135% auto no-repeat;
}
.preview-copy {
  position: absolute;
  left: 24px;
  bottom: 22px;
  z-index: 2;
  max-width: 300px;
}
.eyebrow {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 9px;
  font-weight: 500;
  letter-spacing: .14em;
  color: #aeb7c1;
}
.eyebrow::before { content: ""; width: 16px; height: 1px; background: var(--accent); }
.preview-title {
  margin: 8px 0 0;
  font-size: 25px;
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: .01em;
  color: #f1f4f7;
}
.preview-metrics {
  display: flex;
  align-items: baseline;
  gap: 16px;
  width: fit-content;
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px solid rgba(235, 240, 246, .18);
  color: rgba(235, 240, 246, .66);
  font-size: 10px;
}
.preview-metrics span + span { padding-left: 16px; border-left: 1px solid rgba(235, 240, 246, .16); }
.preview-metrics b {
  margin-right: 2px;
  color: #edf2f7;
  font-family: "Bahnschrift", "Segoe UI Variable Text", sans-serif;
  font-size: 16px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.preview-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 9px;
  color: rgba(235, 240, 246, .56);
  font-size: 9.5px;
}
.pulse-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); }
.preview-stage {
  position: absolute;
  right: 22px;
  bottom: 22px;
  left: 52%;
  display: flex;
  justify-content: flex-end;
  z-index: 2;
}
.preview-dock {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 52px;
  padding: 10px 14px;
  background: rgba(255, 255, 255, .13);
  border: 1px solid rgba(255, 255, 255, .22);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .24);
  backdrop-filter: blur(16px) saturate(1.2);
  transition: height 160ms ease, padding 160ms ease, gap 160ms ease, border-radius 160ms ease, background 160ms ease;
}
.preview-icon {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  overflow: hidden;
  background: rgba(255, 255, 255, .12);
  color: #fff;
  font-size: 12px;
}
.preview-icon img { width: 100%; height: 100%; object-fit: contain; }
.preview-icon.is-custom { background: rgba(255, 255, 255, .18); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .14); }
.preview-icon.is-custom img { object-fit: cover; }

.panel-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.04fr) minmax(0, .96fr);
  align-items: start;
  gap: 14px;
  margin-top: 16px;
}
.setting-card,
.apps-panel {
  min-width: 0;
  padding: 24px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 11px;
}
.full-span { grid-column: 1 / -1; }
.split-settings {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 30px;
}
.hint-line {
  margin-top: 10px;
  padding: 9px 11px;
  border-radius: 6px;
  background: #1b1f23;
  color: #858d95;
  font-size: 9.5px;
  line-height: 1.65;
}
.app-count { margin-left: 4px; color: #8b9299; font-size: 10px; font-weight: 500; vertical-align: 1px; }
.empty-state { padding: 44px 0; text-align: center; color: var(--muted); font-size: 11px; }
.card-heading { gap: 11px; margin-bottom: 7px; }
.card-heading h2,
.apps-header h2,
.info-card h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.35;
  letter-spacing: .01em;
  color: #edf0f3;
}
.card-heading p,
.apps-header p,
.info-card p { margin: 4px 0 0; font-size: 10.5px; line-height: 1.55; color: var(--muted); }

.setting-row {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px 14px;
  padding: 13px 0;
  border-top: 1px solid var(--line-soft);
}
.setting-row span { min-width: 0; }
.setting-row b,
.toggle-row b { display: block; color: #dfe4e8; font-size: 12px; font-weight: 500; }
.setting-row small,
.toggle-row small { display: block; margin-top: 3px; color: #838b93; font-size: 10px; }
.setting-row output {
  align-self: center;
  color: #a0a8b0;
  font-family: "Bahnschrift", "Segoe UI Variable Text", sans-serif;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.setting-row input[type="range"] {
  grid-column: 1 / -1;
  width: 100%;
  height: 16px;
  margin: 7px 0 0;
  appearance: none;
  background: transparent;
  cursor: pointer;
}
.setting-row input[type="range"]::-webkit-slider-runnable-track {
  height: 3px;
  border-radius: 3px;
  background: #343a41;
}
.setting-row input[type="range"]::-webkit-slider-thumb {
  appearance: none;
  width: 12px;
  height: 12px;
  margin-top: -4.5px;
  border: 0;
  border-radius: 50%;
  background: #7da3e3;
  box-shadow: 0 0 0 1px rgba(8, 10, 12, .55);
}
.setting-row input[type="range"]::-moz-range-track {
  height: 3px;
  border-radius: 3px;
  background: #343a41;
}
.setting-row input[type="range"]::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border: 0;
  border-radius: 50%;
  background: #7da3e3;
}

.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 13px 0;
  border-top: 1px solid var(--line-soft);
}
.switch {
  appearance: none;
  width: 36px;
  height: 20px;
  flex: 0 0 auto;
  margin: 0;
  border-radius: 999px;
  background: #333940;
  border: 1px solid #3b4249;
  cursor: pointer;
  transition: background 150ms ease, border-color 150ms ease;
}
.switch::after {
  content: "";
  display: block;
  width: 14px;
  height: 14px;
  margin: 2px;
  border-radius: 50%;
  background: #c9cfd5;
  transition: transform 150ms ease, background 150ms ease;
}
.switch:checked { background: var(--accent-strong); border-color: var(--accent-strong); }
.switch:checked::after { background: #f4f8ff; transform: translateX(16px); }

.apps-panel {
  margin-top: 16px;
  padding: 24px 26px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
}
.apps-header { justify-content: space-between; gap: 20px; margin-bottom: 14px; }
.app-list { border-top: 1px solid var(--line-soft); }
.app-row {
  gap: 10px;
  padding: 10px 4px;
  border-bottom: 1px solid var(--line-soft);
  transition: background 120ms ease;
}
.app-row:hover { background: #1a1d20; }
.app-icon {
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: 7px;
  background: #23272b;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
}
.app-icon img { width: 100%; height: 100%; object-fit: contain; }
.app-icon.is-custom img { object-fit: cover; }
.app-copy { min-width: 0; flex: 1; }
.app-name {
  display: block;
  width: 100%;
  height: 24px;
  margin-left: -6px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 5px;
  outline: 0;
  background: transparent;
  color: #e8ecef;
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  transition: background 120ms ease, border-color 120ms ease;
}
.app-name:hover { background: #1e2226; }
.app-name:focus { background: #1c2024; border-color: #3a4758; }
.app-copy small {
  display: block;
  margin-top: 2px;
  overflow: hidden;
  color: #7e868e;
  font-size: 9.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.app-actions { gap: 2px; }
.mini-button {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  background: transparent;
  color: #8d959d;
  transition: background 120ms ease, color 120ms ease;
}
.mini-button svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.mini-button:hover:not(:disabled) { background: #262b31; color: #e6ebef; }
.mini-button:disabled { opacity: .25; cursor: default; }
.mini-button.danger { color: #b97f86; }
.mini-button.danger:hover:not(:disabled) { background: rgba(170, 90, 100, .12); color: #dda5ab; }
.fixed-list { margin-top: 16px; }
.fixed-title { margin-bottom: 6px; color: #7e868e; font-size: 10px; letter-spacing: .03em; }
.fixed-row { justify-content: space-between; padding: 8px 2px; color: #aab1b8; font-size: 11px; }
.fixed-row small { color: #7e868e; }

.info-card { justify-content: flex-start; align-self: start; }
.info-card h2 { margin-top: 0; }
.info-card p { max-width: 380px; font-size: 11px; line-height: 1.7; }
.info-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.button.small { height: 28px; padding: 0 10px; font-size: 10.5px; }
.icon-button { color: #8d959d; }
.config-path {
  margin-top: 14px;
  padding: 9px 11px;
  border-radius: 6px;
  background: #1a1e22;
  color: #7e868e;
  font-size: 9.5px;
}
.contact-note {
  margin-top: 18px;
  padding-top: 13px;
  border-top: 1px solid var(--line-soft);
  color: #858d95;
  font-size: 10.5px;
  line-height: 1.65;
}
.contact-note span { color: #b6cbe8; white-space: nowrap; }

.settings-toast {
  position: fixed;
  left: 50%;
  bottom: 24px;
  translate: -50% 0;
  padding: 9px 15px;
  border-radius: 8px;
  background: #1a1e22;
  border: 1px solid #2f353b;
  color: #edf1f4;
  font-size: 11px;
  box-shadow: 0 10px 26px rgba(0, 0, 0, .35);
}
.toast-enter-active,.toast-leave-active { transition: opacity 150ms ease, translate 150ms ease; }
.toast-enter-from,.toast-leave-to { opacity: 0; translate: -50% 6px; }

.button:focus-visible,
.mini-button:focus-visible,
.nav-item:focus-visible,
.switch:focus-visible {
  outline: 2px solid rgba(111, 149, 216, .55);
  outline-offset: 2px;
}

@media (max-width: 980px) {
  .settings-shell { grid-template-columns: 196px minmax(0, 1fr); }
  .settings-topbar { padding: 0 20px; }
  .settings-content { padding: 20px; }
  .panel-grid { gap: 12px; }
  .setting-card { padding: 22px 18px; }
  .preview-copy { max-width: 280px; }
  .preview-title { font-size: 22px; }
  .preview-stage { left: 54%; right: 16px; }
  .preview-metrics { gap: 12px; }
  .preview-metrics span + span { padding-left: 12px; }
  .live-state { display: none; }
}
@media (max-width: 820px) {
  .settings-shell { grid-template-columns: 176px minmax(0, 1fr); }
  .rail-brand { padding-left: 6px; padding-right: 6px; }
  .nav-item { padding: 10px 9px; }
  .nav-copy small { display: none; }
  .panel-grid { grid-template-columns: 1fr; }
  .full-span { grid-column: auto; }
  .preview-stage { top: 16px; bottom: auto; left: auto; right: 14px; }
  .preview-copy { max-width: 260px; }
}
</style>
