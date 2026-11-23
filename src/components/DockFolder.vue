<script setup>
import { computed, ref, watch } from 'vue';
import { needsRoundedSquareFrame } from '../utils/iconShape.js';

const props = defineProps({
  kind: { type: String, required: true },
  items: { type: Array, default: () => [] },
  size: { type: Number, default: 56 },
  left: { type: Number, default: 0 },
  bottom: { type: Number, default: 0 },
  open: { type: Boolean, default: false },
  systemIcons: { type: Object, default: () => ({}) },
  containerWidth: { type: Number, default: 0 }
});

const emit = defineEmits(['toggle', 'launch', 'restore', 'close']);
const api = window.dockApi;
const resolved = ref({});
const frameStates = ref({});
const failedSources = ref({});
const iconCache = new Map();
const resolving = new Set();

function itemKey(item) {
  return props.kind === 'app' ? `app:${item.id}` : `min:${item.h}`;
}

function normalizeIcon(icon) {
  if (!icon) return '';
  if (icon.startsWith('data:')) return icon;
  return './' + icon.replace(/^\.\//, '');
}

function isCustomIcon(item) {
  return !!(props.kind === 'app' && item.iconCustom && item.customIcon);
}

function iconOf(item) {
  const key = itemKey(item);
  let icon = '';
  if (props.kind === 'app') {
    if (isCustomIcon(item)) icon = normalizeIcon(item.customIcon);
    else icon = normalizeIcon(props.systemIcons[item.id] || resolved.value[key] || item.icon || '');
  } else {
    icon = resolved.value[key] || '';
  }
  return icon && failedSources.value[key] !== icon ? icon : '';
}

function labelOf(item) {
  return item.name || item.t || '应用';
}

async function resolveIcon(item, force = false) {
  if (!api?.extractIcon) return;
  const key = itemKey(item);
  if (resolving.has(key) && !force) return;
  const sourcePath = props.kind === 'app' ? item.path : item.e;
  if (!sourcePath || String(sourcePath).startsWith('shell:')) return;
  resolving.add(key);
  try {
    const cacheKey = `${props.kind}:${sourcePath}`;
    let url = iconCache.get(cacheKey);
    if (url === undefined || force) {
      try { url = (await api.extractIcon(sourcePath)) || ''; } catch (err) { url = ''; }
      if (url) iconCache.set(cacheKey, url);
    }
    if (url) {
      resolved.value = { ...resolved.value, [key]: url };
      if (failedSources.value[key] && failedSources.value[key] !== url) {
        const failed = { ...failedSources.value };
        delete failed[key];
        failedSources.value = failed;
      }
    }
  } finally {
    resolving.delete(key);
  }
}

function resolveAllIcons() {
  const next = { ...resolved.value };
  for (const item of props.items) {
    const key = itemKey(item);
    if (props.kind === 'app') {
      if (isCustomIcon(item)) continue;
      const systemIcon = normalizeIcon(props.systemIcons[item.id] || '');
      if (systemIcon) next[key] = systemIcon;
      else if (!item.icon && !next[key]) resolveIcon(item);
    } else {
      if (!next[key]) resolveIcon(item);
    }
  }
  resolved.value = next;
}

watch(() => props.items.map(item => itemKey(item)).join(','), () => {
  const keep = {};
  for (const item of props.items) {
    const key = itemKey(item);
    if (resolved.value[key]) keep[key] = resolved.value[key];
  }
  resolved.value = keep;
  const failed = {};
  for (const item of props.items) {
    const key = itemKey(item);
    if (failedSources.value[key]) failed[key] = failedSources.value[key];
  }
  failedSources.value = failed;
  resolveAllIcons();
}, { immediate: true });

watch(() => props.systemIcons, () => {
  resolveAllIcons();
}, { deep: true });

function onIconLoad(item, event) {
  const key = itemKey(item);
  frameStates.value = {
    ...frameStates.value,
    [key]: isCustomIcon(item) ? false : needsRoundedSquareFrame(event.currentTarget)
  };
  if (failedSources.value[key]) {
    const failed = { ...failedSources.value };
    delete failed[key];
    failedSources.value = failed;
  }
}

function onIconError(item) {
  const key = itemKey(item);
  const failedSource = iconOf(item);
  if (failedSource) {
    failedSources.value = { ...failedSources.value, [key]: failedSource };
  }
  resolveIcon(item, true);
}

function pick(item) {
  if (props.kind === 'app') emit('launch', item.id);
  else emit('restore', item);
  emit('close');
}

const previewItems = computed(() => props.items.slice(0, 4));
const extraCount = computed(() => Math.max(0, props.items.length - previewItems.value.length));

// 弹层以文件夹图标为锚点正上方展开，并夹在 Dock 的可用宽度内，避免跑到左侧。
const popoverWidth = computed(() => {
  const base = props.containerWidth > 0 ? props.containerWidth : window.innerWidth;
  return Math.max(0, Math.min(360, base - 16));
});
const popoverLeft = computed(() => {
  const base = props.containerWidth > 0 ? props.containerWidth : window.innerWidth;
  const center = props.left + props.size / 2;
  const maxLeft = Math.max(8, base - popoverWidth.value - 8);
  return Math.max(8, Math.min(maxLeft, center - popoverWidth.value / 2));
});
</script>

<template>
  <div
    class="dock-folder"
    :style="{ left: left + 'px', bottom: bottom + 'px', width: size + 'px', height: size + 'px' }"
    @pointerdown.stop
    @click.stop="emit('toggle', kind)"
  >
    <span class="folder-tile">
      <span class="folder-preview">
        <span
          v-for="item in previewItems"
          :key="itemKey(item)"
          class="folder-preview-cell"
        >
          <img
            v-if="iconOf(item)"
            :src="iconOf(item)"
            alt=""
            draggable="false"
            @error="onIconError(item)"
          />
          <span v-else>{{ labelOf(item).slice(0, 1) }}</span>
        </span>
      </span>
      <span v-if="extraCount" class="folder-count">+{{ extraCount }}</span>
    </span>
  </div>

  <transition name="folder">
    <div
      v-if="open"
      class="folder-popover"
      :style="{
        left: popoverLeft + 'px',
        width: popoverWidth + 'px',
        bottom: (bottom + size + 10) + 'px'
      }"
      @pointerdown.stop
      @click.stop
    >
      <div class="folder-popover-title">
        {{ kind === 'app' ? '更多应用' : '更多窗口' }}
      </div>
      <div class="folder-popover-grid">
        <button
          v-for="item in items"
          :key="itemKey(item)"
          class="folder-entry"
          type="button"
          :title="labelOf(item)"
          @click.stop="pick(item)"
        >
          <span
            class="folder-entry-icon"
            :class="{ 'has-icon-frame': frameStates[itemKey(item)] && !isCustomIcon(item), 'is-custom-icon': isCustomIcon(item) }"
          >
            <img
              v-if="iconOf(item)"
              :src="iconOf(item)"
              alt=""
              draggable="false"
              @load="onIconLoad(item, $event)"
              @error="onIconError(item)"
            />
            <span v-else>{{ labelOf(item).slice(0, 1) }}</span>
          </span>
          <span class="folder-entry-label">{{ labelOf(item) }}</span>
        </button>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.dock-folder {
  position: absolute;
  display: grid;
  place-items: center;
  pointer-events: auto;
  cursor: pointer;
}

.folder-tile {
  position: relative;
  box-sizing: border-box;
  width: 88%;
  height: 88%;
  overflow: hidden;
  border-radius: 22%;
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.3), rgba(126, 139, 160, 0.22));
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.4),
    inset 0 1px 0 rgba(255, 255, 255, 0.22);
}

.folder-preview {
  position: absolute;
  inset: 16%;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  grid-template-rows: repeat(2, 1fr);
  gap: 7%;
}

.folder-preview-cell {
  min-width: 0;
  min-height: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: 20%;
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
  font-size: 7px;
  font-weight: 700;
}

.folder-preview-cell img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.folder-count {
  position: absolute;
  right: 4px;
  bottom: 3px;
  min-width: 13px;
  height: 13px;
  padding: 0 3px;
  border-radius: 7px;
  background: rgba(10, 12, 18, 0.72);
  color: #fff;
  font-size: 7px;
  line-height: 13px;
  text-align: center;
}

.folder-popover {
  position: absolute;
  z-index: 20;
  box-sizing: border-box;
  max-height: 176px;
  padding: 12px;
  border-radius: 18px;
  background: rgba(30, 32, 38, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.18);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14);
  overflow: auto;
  color: #f5f5f7;
  pointer-events: auto;
}

.folder-popover-title {
  margin: 0 2px 9px;
  font-size: 11px;
  font-weight: 600;
  opacity: 0.72;
}

.folder-popover-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(56px, 1fr));
  gap: 8px;
}

.folder-entry {
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.folder-entry-icon {
  box-sizing: border-box;
  width: 38px;
  height: 38px;
  margin: 0 auto 4px;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: 22%;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
}

.folder-entry-icon.has-icon-frame {
  padding: 5px;
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.26), rgba(138, 149, 168, 0.18));
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.32);
}

.folder-entry-icon img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.folder-entry-icon.is-custom-icon {
  background: rgba(255, 255, 255, 0.14);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.2);
}

.folder-entry-icon.is-custom-icon img {
  object-fit: cover;
  border-radius: inherit;
}

.folder-entry-label {
  display: block;
  overflow: hidden;
  font-size: 9px;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder-enter-active,
.folder-leave-active {
  transition: opacity 130ms ease, transform 130ms ease;
}

.folder-enter-from,
.folder-leave-to {
  opacity: 0;
  transform: translateY(5px) scale(0.97);
}
</style>
