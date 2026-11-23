<script setup>
import { computed } from 'vue';

const props = defineProps({
  label: { type: String, default: '' },
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  w: { type: Number, default: 80 },
  h: { type: Number, default: 30 }
});

const style = computed(() => ({
  left: props.x + 'px',
  top: props.y + 'px',
  width: props.w + 'px',
  height: props.h + 'px'
}));
</script>

<template>
  <div class="glass-tooltip" :style="style">{{ label }}</div>
</template>
