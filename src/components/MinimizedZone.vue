<script setup>
import { computed, ref, watch } from 'vue';
import { needsRoundedSquareFrame } from '../utils/iconShape.js';

const props = defineProps({
  items: { type: Array, default: () => [] },
  size: { type: Number, default: 56 },
  gap: { type: Number, default: 8 },
  left: { type: Number, default: 0 },
  bottom: { type: Number, default: 0 },
  width: { type: Number, default: 0 }
});

const emit = defineEmits(['restored']);
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

async function restore(it, e) {
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
  >
    <transition-group name="min" tag="div" class="min-row" :style="{ gap: gap + 'px' }">
      <button
        v-for="it in items"
        :key="it.h"
        class="min-item"
        :style="{ width: size + 'px', height: size + 'px' }"
        :title="it.t"
        @pointerdown.stop
        @click.stop="restore(it, $event)"
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
    </transition-group>
  </div>
</template>

<style scoped>
.min-zone {
  position: absolute;
  display: flex;
  align-items: center;
  pointer-events: auto;
}

.min-row {
  display: flex;
  align-items: center;
}

.min-item {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  pointer-events: auto;
  overflow: hidden;
  transform-origin: 50% 100%;
  transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1), opacity 180ms ease, filter 180ms ease;
}

.min-item:hover {
  transform: scale(1.06);
}

.min-visual {
  box-sizing: border-box;
  width: 88%;
  height: 88%;
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
  width: 84%;
  height: 84%;
  display: grid;
  place-items: center;
  border-radius: inherit;
  background: linear-gradient(160deg, #6e6e73, #3a3a3c);
  color: #fff;
  font-size: 20px;
  font-weight: 600;
}

.min-enter-from {
  opacity: 0;
  transform: translateY(-46px) scale(0.42);
  filter: blur(2px);
}

.min-enter-active {
  transition: transform 280ms cubic-bezier(0.22, 1, 0.36, 1), opacity 200ms ease, filter 220ms ease;
}

.min-leave-active {
  position: absolute;
  transition: transform 200ms cubic-bezier(0.22, 1, 0.36, 1), opacity 200ms ease, filter 200ms ease;
}

.min-leave-to {
  opacity: 0;
  transform: translateY(-16px) scale(1.14);
  filter: blur(1.5px);
}

.min-move {
  transition: transform 280ms cubic-bezier(0.22, 1, 0.36, 1);
}
</style>
