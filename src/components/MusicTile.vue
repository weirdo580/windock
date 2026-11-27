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
// 封面实时跟当前这首歌：优先用播放器给的原图（SMTC 缩略图），
// 播放器不给（汽水音乐就是不给）就按「歌名 + 歌手 + 时长」去网上找同一首歌的封面。
// 换歌到新封面到达之间一直显示上一张，绝不出现空白方块。
const art = ref('');
const lastArt = ref('');
const clockTick = ref(Date.now());
let wantKey = '';
let artKey = '';
let artTries = 0;
let artTimer = 0;
let artPending = false;
let badArt = '';
let clockBase = 0;
let clockAt = 0;
let lastReportedPosition = -1;
let optimisticPlaying = null;
let optimisticUntil = 0;
let mediaTimer = 0;
let lyricTimer = 0;
let pollTimer = 0;
let clockTimer = 0;

const hasSong = computed(() => !media.empty && !!media.title);
const title = computed(() => (hasSong.value ? media.title : '未在播放'));
const artist = computed(() => (hasSong.value && media.artist ? media.artist : (hasSong.value ? '本地媒体' : '播放音乐后自动接入')));

// 只有「本次运行还一张封面都没拿到过」时才会用到这张占位图，拿到真封面后就不再出现。
function makeFallbackArt() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="hsl(208 72% 58%)"/><stop offset="1" stop-color="hsl(262 64% 40%)"/>
    </linearGradient></defs>
    <rect width="96" height="96" rx="22" fill="url(#g)"/>
    <path d="M36 65a8 8 0 1 0 4 6.9V37l28-6v24.8a8 8 0 1 0 4 6.9V23L36 30.5z" fill="#fff" fill-opacity=".86"/>
  </svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
const fallbackArt = makeFallbackArt();
const coverSrc = computed(() => art.value || lastArt.value || fallbackArt);

// 先离屏加载，加载成功才换上去：换歌瞬间不会闪白/闪空
function preloadArt(url, key) {
  return new Promise(resolve => {
    if (!url || !key) return resolve(false);
    const probe = new Image();
    probe.referrerPolicy = 'no-referrer';
    probe.onload = () => resolve(key === wantKey);
    probe.onerror = () => { badArt = url; resolve(false); };
    probe.src = url;
  });
}

function applyArt(url, key) {
  if (!url || !key || key !== wantKey) return false;
  art.value = url;
  artKey = key;
  lastArt.value = url;
  return true;
}

async function useArt(url, key) {
  const ok = await preloadArt(url, key);
  return ok ? applyArt(url, key) : false;
}

// 换歌后立刻问一次这首歌的封面；没找到再补一次（每首歌最多两次）
function requestArt(key) {
  clearTimeout(artTimer);
  artTries = 0;
  if (!api || !api.mediaCover || !key) return;
  artTimer = setTimeout(() => { fetchArt(key); }, 0);
}

async function fetchArt(key) {
  if (!api || !api.mediaCover || key !== wantKey) return;
  if (artKey === key && art.value) return;
  if (artPending) return;
  artPending = true;
  try {
    const res = await api.mediaCover({ title: media.title, artist: media.artist, duration: media.duration });
    if (key !== wantKey) return;                       // 已经换歌了，迟到的结果直接丢弃
    const url = res && res.cover ? String(res.cover) : '';
    if (url && url !== badArt && await useArt(url, key)) return;
    if (artKey !== key && artTries < 2) {
      artTries += 1;
      clearTimeout(artTimer);
      artTimer = setTimeout(() => fetchArt(key), artTries === 1 ? 1200 : 3000);
    }
  } catch (err) {
    if (artKey !== key && artTries < 2) {
      artTries += 1;
      clearTimeout(artTimer);
      artTimer = setTimeout(() => fetchArt(key), 2000);
    }
  } finally {
    artPending = false;
  }
}

function onArtError() {
  if (art.value) badArt = art.value;
  art.value = '';
  if (wantKey && artTries < 2) {
    artTries += 1;
    clearTimeout(artTimer);
    artTimer = setTimeout(() => fetchArt(wantKey), 800);
  }
}

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
  // 订阅 clockTick，让进度条按帧刷新；不能只依赖 900ms 一次的状态轮询。
  const dt = (clockTick.value - clockAt) / 1000;
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
    optimisticPlaying = null;
    optimisticUntil = 0;
    lastReportedPosition = -1;
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
  const changedTitle = nextTitle !== media.title || nextArtist !== media.artist;
  const reportedPosition = Number(state.position) || 0;
  const previousPlaying = media.playing;
  const nextPlaying = optimisticPlaying !== null ? optimisticPlaying : reportedPlaying;
  // 很多播放器（例如汽水音乐）的 SMTC 只回报开头附近的位置，之后一直是同一个值。
  // 这时不能每次轮询都把本地时钟拉回去，否则进度条会永远停在开头。
  const localPosition = media.playing
    ? Math.min(media.duration || 1e9, clockBase + (now - clockAt) / 1000)
    : media.position;
  const positionChanged = Math.abs(reportedPosition - lastReportedPosition) > 0.05;
  const playChanged = nextPlaying !== previousPlaying;
  const shouldSync = changedTitle || playChanged || (positionChanged && Math.abs(reportedPosition - localPosition) > 0.8);

  media.empty = false;
  media.title = nextTitle;
  media.artist = nextArtist;
  media.playing = nextPlaying;
  media.duration = Number(state.duration) || 0;
  media.canNext = state.canNext !== false;
  media.canPrev = state.canPrev !== false;
  if (shouldSync) {
    clockBase = reportedPosition;
    clockAt = now;
    clockTick.value = now;
    media.position = reportedPosition;
  } else {
    media.position = localPosition;
  }
  lastReportedPosition = reportedPosition;
  const songKey = `${nextTitle}|${nextArtist}`;
  const systemCover = typeof state.cover === 'string' ? state.cover : '';
  if (songKey !== wantKey) {
    wantKey = songKey;
    artTries = 0;
    badArt = '';
    artPending = false;
    clearTimeout(artTimer);
    if (!systemCover) {
      // 播放器没给图：上一张继续挂着不空白，同时立刻去抓这首歌自己的封面
      requestArt(songKey);
    }
    loadLyrics();
  }
  if (systemCover && systemCover !== art.value) {
    // 播放器自己给的缩略图和正在播的这首完全一致，拿到就立刻换上去
    clearTimeout(artTimer);
    useArt(systemCover, songKey);
  }
}

async function loadLyrics(retry) {
  if (!retry) {
    lyricLines.value = [];
    lyricIndex.value = -1;
  }
  const key = `${media.title}|${media.artist}`;
  lyricKey.value = key;
  if (!api || !api.mediaLyrics || !media.title) return;
  try {
    const res = await api.mediaLyrics({ title: media.title, artist: media.artist });
    if (key !== lyricKey.value) return;
    lyricLines.value = res && Array.isArray(res.lines) ? res.lines : [];
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
  clockTick.value = clockAt;
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
  // 用定时器而不是 rAF：Dock 是常驻非焦点窗口，rAF 可能被 Chromium 降频。
  clockTimer = setInterval(() => {
    if (media.playing) clockTick.value = Date.now();
  }, 100);
});

onBeforeUnmount(() => {
  clearInterval(mediaTimer);
  clearInterval(lyricTimer);
  clearInterval(clockTimer);
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
    <div class="music-cover has-art">
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
  height: 3px;
  border-radius: 2px;
  background: rgba(30, 30, 40, 0.16);
  overflow: hidden;
}

.music-progress span {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: rgba(10, 132, 255, 0.8);
  transition: none;
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

