<script setup>
import { computed, ref, watch } from 'vue';
import { needsRoundedSquareFrame } from '../utils/iconShape.js';

const props = defineProps({
  item: { type: Object, required: true },
  systemIcon: { type: String, default: '' },
  size: { type: Number, default: 56 },
  left: { type: Number, default: 0 },
  bottom: { type: Number, default: 14 },
  running: { type: Boolean, default: false },
  dragging: { type: Boolean, default: false },
  bouncing: { type: Boolean, default: false }
});

const isCustomIcon = computed(() => !!(props.item.iconCustom && props.item.customIcon));

const iconSrc = computed(() => {
  if (isCustomIcon.value) return props.item.customIcon;
  const icon = props.systemIcon || props.item.icon || '';
  if (!icon) return '';
  if (icon.startsWith('data:')) return icon;
  return './' + icon.replace(/^\.\//, '');
});

const needsFrame = ref(false);
const iconReady = ref(false);

watch(iconSrc, src => {
  iconReady.value = !src;
  needsFrame.value = false;
}, { immediate: true });

function onIconLoad(event) {
  needsFrame.value = isCustomIcon.value ? false : needsRoundedSquareFrame(event.currentTarget);
  iconReady.value = true;
}

const initial = computed(() => (props.item.name || '?').trim().slice(0, 1).toUpperCase());

const style = computed(() => ({
  left: props.left.toFixed(2) + 'px',
  bottom: props.bottom.toFixed(2) + 'px',
  width: props.size.toFixed(2) + 'px',
  height: props.size.toFixed(2) + 'px'
}));
</script>

<template>
  <div class="dock-icon" :class="{ 'is-dragging': dragging }" :style="style">
    <div
      class="dock-icon-inner"
      :class="{ 'is-bouncing': bouncing, 'has-icon-frame': needsFrame, 'is-custom-icon': isCustomIcon, 'is-pending': !iconReady }"
    >
      <img
        v-if="iconSrc"
        class="dock-icon-img"
        :src="iconSrc"
        alt=""
        draggable="false"
        @load="onIconLoad"
      />
      <span v-else class="dock-icon-fallback">{{ initial }}</span>
    </div>
    <span v-if="running" class="dock-run-dot"></span>
  </div>
</template>
