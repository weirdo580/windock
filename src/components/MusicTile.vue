<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

const props = defineProps({
  item: { type: Object, required: true },
  width: { type: Number, default: 226 },
  height: { type: Number, default: 56 },
  left: { type: Number, default: 0 },
  bottom: { type: Number, default: 0 }
});

const api = window.dockApi;
const media = reactive({
  empty: true,
  title: '',
  artist: '',
  playing: false,
  position: 0,
  duration: 0,
  canNext: true,
  canPrev: true
});
const lyricLines = ref([]);
const lyricKey = ref('');
const lyricIndex = ref(-1);
const hover = ref(false);
const art = ref('');
let artKey = '';
let badArt = '';
let artRetry = 0;
let artTimer = 0;
let clockBase = 0;
let clockAt = 0;
let optimisticPlaying = null;
let optimisticUntil = 0;
let mediaTimer = 0;
let lyricTimer = 0;
let pollTimer = 0;

const hasSong = computed(() => !media.empty && !!media.title);
const title = computed(() => (hasSong.value ? media.title : '未在播放'));
const artist = computed(() => (hasSong.value && media.artist ? media.artist : (hasSong.value ? '本地媒体' : '播放音乐后自动接入')));

function makeFallbackArt(trackTitle, trackArtist) {
  const source = `${trackTitle || ''}|${trackArtist || ''}` || 'WinDock Music';
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hue = Math.abs(hash) % 360;
  const hue2 = (hue + 54) % 360;
  const initial = Array.from(String(trackTitle || '').trim())[0] || '♪';
  const safeInitial = initial.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="hsl(${hue} 72% 58%)"/><stop offset="1" stop-color="hsl(${hue2} 64% 36%)"/>
    </linearGradient><radialGradient id="r" cx=".2" cy=".12" r=".9">
      <stop stop-color="#fff" stop-opacity=".46"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient></defs>
    <rect width="96" height="96" rx="22" fill="url(#g)"/><rect width="96" height="96" rx="22" fill="url(#r)"/>
    <circle cx="76" cy="20" r="18" fill="#fff" fill-opacity=".09"/>
    <path d="M36 65a8 8 0 1 0 4 6.9V37l28-6v24.8a8 8 0 1 0 4 6.9V23L36 30.5z" fill="#fff" fill-opacity=".86"/>
    <text x="73" y="27" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei UI, sans-serif" font-size="17" font-weight="700" fill="#fff" fill-opacity=".9">${safeInitial}</text>
  </svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

const fallbackArt = computed(() => makeFallbackArt(media.title, media.artist));
const coverSrc = computed(() => art.value || fallbackArt.value);

const currentLyric = computed(() => {
  if (!lyricLines.value.length) return '';
  const i = lyricIndex.value;
  return i >= 0 ? lyricLines.value[i].text : '';
});

const progress = computed(() => {
  if (!media.duration) return 0;
  return Math.max(0, Math.min(1, clockPosition.value / media.duration));
});

const clockPosition = computed(() => {
  if (!media.playing) return media.position;
  const dt = (Date.now() - clockAt) / 1000;
  return Math.min(media.duration || 1e9, clockBase + dt);
});


function applyMedia(state) {
  if (!state) return;
  if (state.empty) {
    media.empty = true;
    media.title = '';
    media.artist = '';
    media.playing = false;
    lyricLines.value = [];
    lyricIndex.value = -1;
    lyricKey.value = '';
    art.value = '';
    artKey = '';
    badArt = '';
    optimisticPlaying = null;
    optimisticUntil = 0;
    return;
  }
  const reportedPlaying = !!state.playing;
  const now = Date.now();
  if (optimisticPlaying !== null) {
    if (reportedPlaying === optimisticPlaying || now >= optimisticUntil) {
      optimisticPlaying = null;
      optimisticUntil = 0;
    }
  }
  const nextTitle = state.title || '';
  const nextArtist = state.artist || '';
  const nextKey = `${nextTitle}|${nextArtist}`;
  const changedTitle = nextTitle !== media.title || nextArtist !== media.artist;
  media.empty = false;
  media.title = nextTitle;
  media.artist = nextArtist;
  media.playing = optimisticPlaying !== null ? optimisticPlaying : reportedPlaying;
  media.position = Number(state.position) || 0;
  media.duration = Number(state.duration) || 0;
  media.canNext = state.canNext !== false;
  media.canPrev = state.canPrev !== false;
  clockBase = media.position;
  clockAt = Date.now();
  if (changedTitle) {
    art.value = '';
    artKey = nextKey;
    badArt = '';
    loadLyrics();
  }
  const systemCover = typeof state.cover === 'string' ? state.cover : '';
  if (systemCover && systemCover !== badArt && (art.value !== systemCover || artKey !== nextKey)) {
    art.value = systemCover;
    artKey = nextKey;
  }
}

function preloadArt(url, key) {
  if (!url || url === badArt) return;
  const probe = new Image();
  probe.referrerPolicy = 'no-referrer';
  probe.onload = () => {
    if (key !== lyricKey.value) return;   // 换歌了，丢弃旧结果
    art.value = url;
    artKey = key;
  };
  probe.onerror = () => {
    if (key !== lyricKey.value) return;
    if (art.value === url) art.value = '';
  };
  probe.src = url;
}

function onArtError() {
  badArt = art.value;
  art.value = '';
  artKey = lyricKey.value;
}

async function loadLyrics(retry) {
  if (!retry) {
    lyricLines.value = [];
    lyricIndex.value = -1;
    artRetry = 0;
  }
  const key = `${media.title}|${media.artist}`;
  lyricKey.value = key;
  if (!api || !api.mediaLyrics || !media.title) return;
  try {
    const res = await api.mediaLyrics({ title: media.title, artist: media.artist });
    if (key !== lyricKey.value) return;
    lyricLines.value = res && Array.isArray(res.lines) ? res.lines : [];
    // 新封面先预加载，加载成功才替换；失败则保留当前封面，不会出现“透明方块”
    if (res && res.cover && res.cover !== badArt) {
      if (res.cover !== art.value) preloadArt(res.cover, key);
    } else if (!art.value || artKey !== key) {
      art.value = '';
      artKey = key;
    }
    // 封面偶尔第一把取不到（搜索接口抽风），隔几秒补一次，最多 2 次
    if (!art.value && artRetry < 2) {
      artRetry += 1;
      clearTimeout(artTimer);
      artTimer = setTimeout(() => { if (!art.value && key === lyricKey.value) loadLyrics(true); }, 3500);
    }
  } catch (err) {
    lyricLines.value = [];
  }
}

function syncLyric() {
  if (!lyricLines.value.length) {
    if (lyricIndex.value !== -1) lyricIndex.value = -1;
    return;
  }
  const t = clockPosition.value;
  let idx = -1;
  for (let i = 0; i < lyricLines.value.length; i++) {
    if (lyricLines.value[i].t <= t + 0.15) idx = i;
    else break;
  }
  if (idx !== lyricIndex.value) lyricIndex.value = idx;
}

async function poll() {
  if (!api || !api.mediaGet) return;
  try {
    const state = await api.mediaGet();
    applyMedia(state);
  } catch (err) { /* 忽略 */ }
}

async function control(action, e) {
  if (e) { e.stopPropagation(); e.preventDefault(); }
  if (!api || !api.mediaControl) return;
  if (action !== 'playpause') {
    await api.mediaControl(action);
    setTimeout(poll, 240);
    return;
  }

  const previousPlaying = media.playing;
  const previousPosition = Math.min(media.duration || 1e9, clockPosition.value);
  const nextPlaying = !previousPlaying;
  media.position = previousPosition;
  clockBase = previousPosition;
  clockAt = Date.now();
  media.playing = nextPlaying;
  optimisticPlaying = nextPlaying;
  optimisticUntil = Date.now() + 1800;

  try {
    const result = await api.mediaControl(action);
    if (result && result.ok === false) throw new Error(result.error || 'media-control-failed');
  } catch (err) {
    if (optimisticPlaying === nextPlaying) {
      optimisticPlaying = null;
      optimisticUntil = 0;
      media.position = previousPosition;
      clockBase = previousPosition;
      clockAt = Date.now();
      media.playing = previousPlaying;
    }
  }
}

function onTap(e) {
  e.stopPropagation();
  if (!hasSong.value) return;
  control('playpause', e);
}

onMounted(() => {
  poll();
  mediaTimer = setInterval(poll, 900);
  lyricTimer = setInterval(syncLyric, 260);
});

onBeforeUnmount(() => {
  clearInterval(mediaTimer);
  clearInterval(lyricTimer);
  clearTimeout(pollTimer);
  clearTimeout(artTimer);
});

watch(() => media.title + media.artist, () => { syncLyric(); });
</script>

<template>
  <div
    class="music-tile"
    :style="{ left: left + 'px', bottom: bottom + 'px', width: width + 'px', height: height + 'px' }"
    @pointerenter="hover = true"
    @pointerleave="hover = false"
    @pointerdown.stop="onTap"
  >
    <div class="music-cover" :class="{ 'has-art': !!art }">
      <img class="music-art" :src="coverSrc" alt="" draggable="false" referrerpolicy="no-referrer" @error="onArtError" />
    </div>

    <div class="music-meta">
      <div class="music-title">{{ title }}</div>
      <div class="music-sub">
        <span v-if="currentLyric" class="music-lyric">{{ currentLyric }}</span>
        <span v-else class="music-artist">{{ artist }}</span>
      </div>
    </div>

            <div v-if="hasSong" class="music-controls" @pointerdown.stop>
        <button class="music-btn" title="上一首" :disabled="!media.canPrev" @click.stop="control('prev', $event)">
          <svg viewBox="0 0 24 24" width="14" height="14"><path d="M7 5v14M19 5L9 12l10 7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <button class="music-btn primary" :title="media.playing ? '暂停' : '播放'" @click.stop="control('playpause', $event)">
          <svg v-if="media.playing" viewBox="0 0 24 24" width="15" height="15"><path d="M8 5v14M16 5v14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
          <svg v-else viewBox="0 0 24 24" width="15" height="15"><path d="M7 4l13 8-13 8z" fill="currentColor"/></svg>
        </button>
        <button class="music-btn" title="下一首" :disabled="!media.canNext" @click.stop="control('next', $event)">
          <svg viewBox="0 0 24 24" width="14" height="14"><path d="M17 5v14M5 5l10 7-10 7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
      </div>

    <div class="music-progress"><span :style="{ width: (progress * 100) + '%' }"></span></div>
  </div>
</template>

<style scoped>
.music-tile {
  position: absolute;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 8px;
  border-radius: 14px;
  overflow: hidden;
  pointer-events: auto;
  cursor: pointer;
  color: #1b1b1f;
  /* 和 Dock 同一种玻璃：不再自己画白霜底板/描边/投影，完全透明地站在 Dock 玻璃上 */
  background: transparent;
  border: none;
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.42),
    inset 0 1px 0 rgba(255, 255, 255, 0.36),
    0 0 0 0.5px rgba(18, 30, 48, 0.14);
  transform: translateX(0px);
  transition: background 220ms ease, box-shadow 220ms ease;
}

.music-tile:hover {
  background: rgba(255, 255, 255, 0.07);
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.56),
    inset 0 1px 0 rgba(255, 255, 255, 0.44),
    0 0 0 0.5px rgba(18, 30, 48, 0.16);
}

.music-cover {
  position: relative;
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  overflow: hidden;
  display: grid;
  place-items: center;
  /* 没有封面时：一块看得见的霜面圆角方块 + 音符，绝不出现“透明方块” */
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.62), rgba(198, 203, 216, 0.42));
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.62),
    0 0 0 1px rgba(25, 38, 58, 0.12),
    0 2px 5px rgba(0, 0, 0, 0.12);
}

.music-note {
  color: rgba(44, 48, 60, 0.72);
  display: block;
}

.music-cover.has-art {
  background: #2a2a30;
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.32),
    0 0 0 1px rgba(20, 32, 50, 0.18),
    0 2px 5px rgba(0, 0, 0, 0.18);
}

.music-art {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.music-meta {
  min-width: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.music-title {
  font-size: 11.5px;
  font-weight: 600;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  letter-spacing: 0.2px;
}

.music-sub {
  font-size: 10.5px;
  line-height: 1.25;
  padding-right: 46px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: rgba(30, 30, 38, 0.56);
}

.music-lyric {
  color: rgba(30, 30, 38, 0.72);
  font-weight: 500;
}

.music-artist {
  color: rgba(30, 30, 38, 0.5);
}

.music-controls {
  position: absolute;
  right: 5px;
  bottom: 3px;
  display: flex;
  align-items: center;
  gap: 1px;
}

.music-btn {
  width: 15px;
  height: 15px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: rgba(20, 20, 26, 0.82);
  cursor: pointer;
  padding: 0;
  transition: background 140ms ease, transform 140ms ease;
}

.music-btn:hover { background: rgba(20, 20, 30, 0.08); }
.music-btn:active { transform: scale(0.94); }
.music-btn:disabled { opacity: 0.32; cursor: default; }
.music-btn.primary { background: rgba(10, 132, 255, 0.92); color: #fff; }
.music-btn.primary:hover { background: rgba(10, 132, 255, 1); }

.music-progress {
  position: absolute;
  left: 8px;
  right: 48px;
  bottom: 3px;
  height: 2px;
  border-radius: 2px;
  background: rgba(30, 30, 40, 0.1);
  overflow: hidden;
}

.music-progress span {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: rgba(10, 132, 255, 0.75);
  transition: width 240ms linear;
}

.ctl-enter-active, .ctl-leave-active { transition: opacity 160ms ease, transform 160ms ease; }
.ctl-enter-from, .ctl-leave-to { opacity: 0; transform: translateY(-50%) scale(0.92); }

@media (prefers-color-scheme: dark) {
  .music-tile {
    color: #f2f2f6;
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.34),
      inset 0 1px 0 rgba(255, 255, 255, 0.26),
      0 0 0 0.5px rgba(0, 0, 0, 0.24);
  }
  .music-sub { color: rgba(255, 255, 255, 0.62); }
  .music-lyric { color: rgba(255, 255, 255, 0.86); }
  .music-btn { color: rgba(255, 255, 255, 0.86); }
}
.music-btn svg { width: 10px; height: 10px; }
</style>

