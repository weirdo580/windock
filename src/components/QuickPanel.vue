<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';

const api = window.dockApi;

const state = reactive({
  wifi: { connected: false, ssid: '', signal: 0 },
  battery: null,
  brightness: 100,
  volume: 40,
  muted: false,
  powerSaver: false,
  radio: { wifi: 'Unknown' },
  airplane: false,
  // 进飞行模式前的 Wi-Fi 开关记忆，退出时按它还原（不是无条件全开）
  preAir: { wifi: true },
  // 硬件能力：没有的模块直接不显示（台式机没电池/外接屏没亮度/没有无线网卡）
  caps: { battery: true, brightness: true, wifi: true, ime: true }
});

const brightness = ref(100);
const volume = ref(40);
let timer = 0;
let tileTick = 0;
let dragging = '';
let offStatus = null;
let lastDataAt = 0;
// 自己刚改过的值在短时间内不接受推送覆盖（避免拖完被旧采样拽回去）
let localUntil = 0;
// 指针是否停在小圆点上
const near = ref('');

// 节流：立即发一次，再在窗口末尾补发最新值，拖动时跟手但不刷爆进程
function makeThrottle(ms, fn) {
  let last = 0;
  let pending = 0;
  return function () {
    const now = Date.now();
    const gap = now - last;
    if (gap >= ms) { last = now; fn(); return; }
    if (pending) return;
    pending = setTimeout(() => { pending = 0; last = Date.now(); fn(); }, ms - gap);
  };
}

// 二级小窗（点瓦片后原地展开，不跳系统设置）
const sub = ref('');
const subBusy = ref(false);
const subMsg = ref('');
// 省电模式切换失败时，在瓦片那一行短暂说明原因（不弹系统对话框）
const powerMsg = ref('');
let powerMsgTimer = 0;
function showPowerMsg(t) {
  powerMsg.value = t || '切换失败';
  clearTimeout(powerMsgTimer);
  powerMsgTimer = setTimeout(() => { powerMsg.value = ''; }, 2600);
}
const closing = ref(false);
const subKey = ref(0);
// 起始矩形 = 被点的那块瓦片；结束矩形 = 整块小窗，动画在这两个矩形之间插值
const fromRect = ref({ x: 0, y: 0, w: 120, h: 54 });
const toRect = ref({ x: 10, y: 10, w: 352, h: 378 });
// 起点要长得和那块瓦片一模一样，才像是“瓦片自己长大”
const skinBg = ref('rgba(255,255,255,0.13)');
// transform 形变参数：位移 + 非等比缩放（起点正好是被点瓦片的大小和位置）
const morph = ref({ mx: 0, my: 0, msx: 1, msy: 1 });
let morphCell = null;
let morphTile = null;
const skinEl = ref(null);
// Wi-Fi：输密码连接（就地展开，不走系统原生弹窗）
const pwTarget = ref(null);
const pwValue = ref('');
const pwBusy = ref(false);
const pwInput = ref(null);
let wifiTimer = 0;
let wifiScanning = false;
// 只留 Wi-Fi、飞行模式、省电模式三块瓦片
const subData = reactive({
  current: '',
  networks: [],
  plans: []
});

const subTitles = {
  wifi: 'Wi-Fi',
  airplane: '飞行模式',
  power: '电源模式'
};

function applyStatus(s) {
  if (!s) return;
  const hold = Date.now() < localUntil;
  if (s.radio) {
    state.radio = s.radio;
    if (!hold) {
      // 飞行模式只认系统事实：Wi-Fi 无线关掉即为开启
      if (s.radio.wifi === 'On') state.airplane = false;
      else if (s.radio.wifi === 'Off') state.airplane = true;
    }
  }
  if (s.power && !hold) state.powerSaver = s.power === 'saver';
  if (s.wifi && !hold) state.wifi = s.wifi;
  if (typeof s.battery !== 'undefined') state.battery = s.battery;
  if (s.caps) state.caps = { ...state.caps, ...s.caps };
  if (typeof s.brightness === 'number' && s.brightness !== null) {
    state.brightness = s.brightness;
    if (dragging !== 'brightness' && !hold) brightness.value = s.brightness;
  }
  if (s.volume && s.volume.level !== null && s.volume.level !== undefined) {
    state.volume = s.volume.level;
    state.muted = !!s.volume.muted;
    if (dragging !== 'volume' && !hold) volume.value = s.volume.level;
  } else if (s.volume && s.volume.muted !== undefined) {
    state.muted = !!s.volume.muted;
  }
  lastDataAt = Date.now();
}

async function refresh(force) {
  if (!api || !api.statusGet) return;
  if (!force && Date.now() - lastDataAt < 1000) return;
  try { applyStatus(await api.statusGet(!!force)); } catch (err) { /* 保留上一次状态 */ }
}

function close() { stopWifiScan(); if (api && api.statusPanel) api.statusPanel(false); }

function openSettings() { if (api && api.statusAction) api.statusAction('settings'); }

// 瓦片左半块：直接执行开/关，不展开小窗；开了变蓝、关了透明，不弹任何提示
const tileBusy = ref('');

// 上次查到的瓦片状态存本地，下次打开面板先按这个显示，不用等进程
function saveTileCache() {
  try {
    localStorage.setItem('windock-tiles', JSON.stringify({
      powerSaver: state.powerSaver, airplane: state.airplane,
      preAir: state.preAir
    }));
  } catch (err) { /* 忽略 */ }
}
function loadTileCache() {
  try {
    const c = JSON.parse(localStorage.getItem('windock-tiles') || '{}');
    if (typeof c.powerSaver === 'boolean') state.powerSaver = c.powerSaver;
    if (typeof c.airplane === 'boolean') state.airplane = c.airplane;
    if (c.preAir && typeof c.preAir.wifi === 'boolean') state.preAir = { wifi: !!c.preAir.wifi };
  } catch (err) { /* 忽略 */ }
}
loadTileCache();

// 把各瓦片的开/关状态拉一遍（电源计划没有实时推送，只能主动查）
async function readTileStates() {
  if (!api || !api.quickRun) return;
  const pw = await api.quickRun('power-list', '').catch(() => null);
  if (pw) {
    // 以主进程算出来的 saver 为准（它读的是 getactivescheme + 电源模式，被隐藏的「节能」方案也能认出来）
    if (typeof pw.saver === 'boolean') state.powerSaver = pw.saver;
    else if (pw.plans) {
      const active = pw.plans.find(p => p && p.active);
      state.powerSaver = !!(active && (/省电|节能|Power saver/.test(active.name || '') || active.guid === 'a1841308-3541-4fab-bc81-f71556f20b4a'));
    }
  }
  saveTileCache();
}

// 点一下先本地翻转（立刻看到变化），再让系统跟上；不等 PowerShell 回来才变色。
// 不用「忙不忙」挡点击——原先的 tileBusy 会把连点吞掉，看起来像点了没反应、要按两次。
// radio 类命令（Wi-Fi / 飞行模式）按「最后一次意图」串行执行：
// 点击仍然立刻生效，但系统命令不会并发打架（并发时 wifi 的 on 可能比 off 后到，结果就反了）
const radioJob = { running: false, next: null };
function sendRadio(cmd) {
  if (radioJob.running) { radioJob.next = cmd; return; }
  radioJob.running = true;
  (async () => {
    let cur = cmd;
    while (cur) {
      try { await api.quickRun('radio-set', cur); } catch (err) { /* 静默 */ }
      cur = radioJob.next;
      radioJob.next = null;
      if (!cur) radioJob.running = false;
    }
  })();
}

const tileSeq = {};
async function tileToggle(kind) {
  if (!api || !api.quickRun) return;
  const my = (tileSeq[kind] = (tileSeq[kind] || 0) + 1);
  // radio/电源类采样是每 3 秒一轮，短时间内的旧帧会把刚点的结果盖回去，所以多挡一会儿
  localUntil = Date.now() + 3500;
  try {
    if (kind === 'wifi') {
      // 和 Windows 快速设置里的 Wi-Fi 开关同一个接口：直接开关无线 radio。
      // 不能用「断开」，那样 Windows 会按已保存的配置自己连回来。
      const on = state.radio.wifi !== 'On';
      state.radio = { wifi: on ? 'On' : 'Off' };
      state.wifi = on
        ? { connected: true, ssid: state.wifi.ssid, signal: state.wifi.signal }
        : { connected: false, ssid: '', signal: 0 };
      if (on) { state.airplane = false; state.preAir = { wifi: true }; }
      saveTileCache();
      sendRadio(on ? 'wifi:on' : 'wifi:off');
    } else if (kind === 'power') {
      const on = !state.powerSaver;
      state.powerSaver = on;
      powerMsg.value = '';
      saveTileCache();
      const r = await api.quickRun('power-saver', '').catch(() => null);
      if (my === tileSeq.power) {
        if (r && typeof r.on === 'boolean') { state.powerSaver = r.on; saveTileCache(); }
        // 系统真的没切过去：别让瓦片继续显示「已开启」骗人，退回原状态并给出原因
        if (r && r.ok === false) {
          state.powerSaver = !on;
          saveTileCache();
          showPowerMsg((r.message || '切换失败').slice(0, 14));
        }
      }
    }
    // 点击后不再追加三个 PowerShell 查询（会让面板卡一拍），状态由常驻状态流补齐
  } catch (err) { /* 静默 */ }
}

// 飞行模式：整块瓦片。点一下「同时」——方块立刻变蓝，飞机同步飞出右边、从左边回位；
// 真正关掉的是 Wi-Fi 无线（和 Windows 设置里飞行模式对 Wi-Fi 的作用一致）
const planeFly = ref(false);
const airplaneOn = computed(() => state.airplane);
function toggleAirplane() {
  // 连点不吞：立刻翻转，动画重播
  if (!api || !api.quickRun) return;
  const turnOn = !airplaneOn.value;
  let cmd = '';
  if (turnOn) {
    // 进飞行模式前先把 Wi-Fi 的当前状态记下来，退出时按原样还原，
    // 而不是不管三七二十一全开（这是之前「退出飞行模式后网络没回来」的另一半原因）
    state.preAir = { wifi: state.radio.wifi === 'On' };
    state.airplane = true;
    state.radio = { wifi: 'Off' };
    state.wifi = { connected: false, ssid: '', signal: 0 };
    cmd = 'wifi:off';
  } else {
    const p = state.preAir || { wifi: true };
    state.airplane = false;
    state.radio = { wifi: p.wifi ? 'On' : 'Off' };
    state.wifi = p.wifi
      ? { connected: true, ssid: state.wifi.ssid, signal: state.wifi.signal }
      : { connected: false, ssid: '', signal: 0 };
    cmd = `wifi:${p.wifi ? 'on' : 'off'}`;
  }
  localUntil = Date.now() + 3500;
  saveTileCache();
  planeFly.value = true;
  sendRadio(cmd);
  setTimeout(() => { planeFly.value = false; }, 760);
}

const sendBright = makeThrottle(55, () => {
  if (api && api.statusBrightness) api.statusBrightness(Number(brightness.value));
});
const sendVol = makeThrottle(55, () => {
  if (!api || !api.statusVolume) return;
  api.statusVolume({ value: Number(volume.value) }).then(res => {
    if (res) {
      if (typeof res.level === 'number') state.volume = res.level;
      state.muted = !!res.muted;
    }
  }).catch(() => {});
});

function onBrightInput() {
  localUntil = Date.now() + 800;
  state.brightness = Number(brightness.value);
  sendBright();
}

function onVolInput() {
  localUntil = Date.now() + 800;
  state.volume = Number(volume.value);
  sendVol();
}

function endDrag() {
  dragging = '';
  localUntil = Date.now() + 400;
}

// 只有指针落在小圆点（滑块拇指）附近才亮数值；指在轨道其他地方不显示
const THUMB_R = 8;
function onNear(kind, e) {
  const input = e.currentTarget.querySelector('input');
  if (!input) return;
  const rect = input.getBoundingClientRect();
  const w = rect.width;
  if (!w) return;
  const val = Math.min(100, Math.max(0, Number(kind === 'brightness' ? brightness.value : volume.value)));
  const center = THUMB_R + (w - THUMB_R * 2) * (val / 100);
  const x = e.clientX - rect.left;
  near.value = Math.abs(x - center) <= THUMB_R + 4 ? kind : '';
}

function toggleMute() {
  if (!api || !api.statusVolume) return;
  api.statusVolume({ mute: true }).then(res => {
    if (res) { state.muted = !!res.muted; if (typeof res.level === 'number') state.volume = res.level; }
  });
}

const wifiBars = computed(() => {
  if (!state.wifi.connected) return 0;
  if (state.wifi.signal >= 67) return 3;
  if (state.wifi.signal >= 33) return 2;
  return 1;
});

// 电池配色规则（和 Dock 状态区一致）：插电 ≤20 红、>20 绿，拔电白，拔电 + 省电黄；只染格子，不染外框
const BAT_TONE = { low: '#ff453a', ok: '#30d158', saver: '#ffd60a', idle: '#ffffff' };
const batteryTone = computed(() => {
  const b = state.battery;
  if (!b) return 'idle';
  const plugged = typeof b.ac === 'boolean' ? b.ac : !!b.charging;
  if (plugged) return b.percent <= 20 ? 'low' : 'ok';
  return state.powerSaver ? 'saver' : 'idle';
});
const batteryColor = computed(() => BAT_TONE[batteryTone.value]);

const batteryFill = computed(() => {
  const b = state.battery;
  if (!b) return 0;
  // 内腔宽 16.8（x 2.6 → 19.4），满了就铺满整格
  return b.full || b.percent >= 100 ? 16.8 : Math.max(1.4, 16.8 * b.percent / 100);
});

// 小窗从被点的瓦片“长”出来：起点取瓦片的真实矩形，终点铺满整块面板
function openSub(kind, e) {
  const el = e && e.currentTarget ? e.currentTarget : null;
  const panelEl = document.querySelector('.panel');
  if (panelEl) {
    const p = panelEl.getBoundingClientRect();
    toRect.value = { x: 10, y: 10, w: Math.round(p.width) - 20, h: Math.round(p.height) - 20 };
    if (el) {
      // 一律以那块「瓦片」本身的矩形为准：点到的可能是里头的箭头/图标，不能拿它的尺寸当起点
      const tileEl = el.closest('.tile') || el;
      const r = tileEl.getBoundingClientRect();
      fromRect.value = {
        x: Math.round(r.left - p.left),
        y: Math.round(r.top - p.top),
        w: Math.round(r.width),
        h: Math.round(r.height)
      };
      // 起点外观直接取那块瓦片的实际底色（Wi-Fi 已连接是蓝色渐变，其余是半透明玻璃）
      const cs = getComputedStyle(tileEl);
      skinBg.value = (cs.backgroundImage && cs.backgroundImage !== 'none')
        ? cs.backgroundImage
        : (cs.backgroundColor || 'rgba(255,255,255,0.13)');
      // 被点的那格先藏起来，避免出现“瓦片 + 另一个窗口”两层
      if (morphCell) morphCell.style.opacity = '';
      morphCell = el.closest('.cell');
      morphTile = tileEl;
      if (morphCell) morphCell.style.opacity = '0';
    } else {
      fromRect.value = { x: toRect.value.w / 2, y: toRect.value.h / 2, w: 60, h: 30 };
    }
    // 换算成 transform：先把小窗的中心挪到瓦片中心，再非等比压到瓦片大小
    const c2x = toRect.value.x + toRect.value.w / 2;
    const c2y = toRect.value.y + toRect.value.h / 2;
    const c1x = fromRect.value.x + fromRect.value.w / 2;
    const c1y = fromRect.value.y + fromRect.value.h / 2;
    morph.value = {
      mx: Math.round(c1x - c2x),
      my: Math.round(c1y - c2y),
      msx: Math.min(1.4, Math.max(0.05, fromRect.value.w / toRect.value.w)),
      msy: Math.min(1.4, Math.max(0.05, fromRect.value.h / toRect.value.h)),
      // 缩小后的圆角会被拉伸成椭圆，这里反向放大，视觉上仍是那块瓦片的 12px 圆角
      r0x: Math.round(Math.min(240, 12 / Math.max(0.05, fromRect.value.w / toRect.value.w))),
      r0y: Math.round(Math.min(240, 12 / Math.max(0.05, fromRect.value.h / toRect.value.h)))
    };
  }
  document.title = 'WinDock 快捷面板';
  closing.value = false;
  // 换 key 强制重建：即使上一个子窗还开着，也能重新播一遍“瓦片长大”的动画
  subKey.value += 1;
  sub.value = kind;
  subMsg.value = '';
  loadSub();
}

function closeSub() {
  if (!sub.value || closing.value) return;
  stopWifiScan();
  pwTarget.value = null;
  pwValue.value = '';
  // 收尾时让上面这层皮肤直接变成那块瓦片的原样（克隆同一块 DOM，像素级对齐），
  // 所以缩到瓦片大小后是“玻璃化开 → 瓦片露出来”，不会出现两层叠着的重影
  if (skinEl.value) {
    skinEl.value.innerHTML = '';
    if (morphTile) {
      const wrap = document.createElement('div');
      wrap.className = 'skin-tile';
      // 尺寸全部走内联样式，保证克隆出来的瓦片一定撑满这块皮肤（不受 scoped 样式影响）
      wrap.style.position = 'absolute';
      wrap.style.inset = '0';
      const clone = morphTile.cloneNode(true);
      clone.style.opacity = '1';
      clone.style.width = '100%';
      clone.style.height = '100%';
      clone.style.boxSizing = 'border-box';
      clone.style.borderRadius = 'inherit';
      wrap.appendChild(clone);
      skinEl.value.appendChild(wrap);
    }
  }
  closing.value = true;
  setTimeout(() => {
    sub.value = '';
    closing.value = false;
    subMsg.value = '';
    if (morphCell) { morphCell.style.opacity = ''; morphCell = null; }
    morphTile = null;
  }, 380);
}

async function loadSub() {
  const k = sub.value;
  if (!k || !api || !api.quickRun) return;
  if (k !== 'wifi') stopWifiScan();
  subBusy.value = true;
  try {
    if (k === 'wifi') {
      await scanWifi();
      // 列表自动跟着现场网络走：进来先扫，之后每 3 秒再扫一遍
      startWifiScan();
    } else if (k === 'power') {
      const r = await api.quickRun('power-list');
      subData.plans = r.plans || [];
    }
  } catch (err) { subMsg.value = '读取失败'; }
  subBusy.value = false;
}

// ---- Wi-Fi：自动扫描 / 输密码连接 / 忘记网络 ----
async function scanWifi() {
  if (!api || !api.quickRun || wifiScanning) return;
  wifiScanning = true;
  try {
    const r = await api.quickRun('wifi-scan');
    if (r && r.networks) {
      subData.current = r.current || '';
      subData.networks = r.networks;
    }
  } catch (err) { }
  wifiScanning = false;
}

function startWifiScan() {
  stopWifiScan();
  wifiTimer = setInterval(() => {
    // 正在输密码/正在连接时不刷新，免得列表在手指底下动
    if (pwTarget.value || pwBusy.value || subBusy.value || closing.value) return;
    scanWifi();
  }, 3000);
}

function stopWifiScan() {
  if (wifiTimer) { clearInterval(wifiTimer); wifiTimer = 0; }
}

// 列表右侧的状态文字：已连接 > 已保存 > 开放 > 需要密码
function wifiTag(n) {
  if (n.current) return '已连接';
  if (n.saved) return '已保存';
  if (n.kind === 'open') return '开放';
  if (n.kind === 'ent') return '企业';
  return '需要密码';
}

function openPw(n) {
  pwTarget.value = n;
  pwValue.value = '';
  subMsg.value = '';
  nextTick(() => { if (pwInput.value) pwInput.value.focus(); });
}

function closePw() {
  if (pwBusy.value) return;
  pwTarget.value = null;
  pwValue.value = '';
}

async function connectWifi(n, password) {
  if (!api || !api.quickRun || !n) return false;
  pwBusy.value = true;
  subMsg.value = '正在连接 ' + n.ssid + '…';
  let r = null;
  try {
    r = await api.quickRun('wifi-connect', JSON.stringify({ ssid: n.ssid, password: password || '', kind: n.kind || '' }));
  } catch (err) { }
  pwBusy.value = false;
  if (r && r.ok) {
    subMsg.value = r.message || ('已连接 ' + n.ssid);
    pwTarget.value = null;
    pwValue.value = '';
    setTimeout(scanWifi, 1200);
    return true;
  }
  subMsg.value = (r && r.message) || '连接失败';
  return false;
}

async function wifiPick(n) {
  if (pwBusy.value || !n) return;
  if (n.current) { subMsg.value = '已连接到 ' + n.ssid; return; }
  if (n.kind === 'ent') { subMsg.value = '学校/企业的网络要账号，得走系统设置'; return; }
  if (n.saved || n.kind === 'open' || !n.secure) {
    const ok = await connectWifi(n, '');
    // 已保存的密码过期了：就地让人重输，输对了会覆盖这份配置
    if (!ok && n.saved) openPw(n);
    return;
  }
  openPw(n);
}

function submitPw() {
  if (!pwTarget.value || pwBusy.value) return;
  if (!pwValue.value) { subMsg.value = '请输入网络安全密钥'; return; }
  connectWifi(pwTarget.value, pwValue.value);
}

async function forgetWifi(n) {
  if (!api || !api.quickRun || !n || pwBusy.value) return;
  subMsg.value = '正在忘记 ' + n.ssid + '…';
  let r = null;
  try { r = await api.quickRun('wifi-forget', n.ssid); } catch (err) { }
  subMsg.value = (r && r.ok) ? ('已忘记网络 ' + n.ssid) : ((r && r.message) || '忘记失败');
  // 成功的就先从列表里摘掉，不用等下一轮扫描
  if (r && r.ok) subData.networks = subData.networks.filter(x => x.ssid !== n.ssid);
  setTimeout(scanWifi, 900);
}

async function runSub(action, value) {
  if (!api || !api.quickRun) return;
  subMsg.value = '处理中…';
  const r = await api.quickRun(action, value);
  if (action === 'wifi-connect') {
    subMsg.value = r && r.ok ? ('正在连接 ' + value) : '连接失败';
    setTimeout(loadSub, 1500);
  } else if (action === 'power-set') {
    subMsg.value = r && r.ok ? '已切换电源模式' : '切换失败（可能需要管理员权限）';
    loadSub();
  } else if (action === 'wifi-toggle') {
    subMsg.value = r && r.ok ? (value === 'off' ? '已关闭无线' : '已开启无线') : '需要管理员权限，未能修改';
  }
}

function onKey(e) {
  if (e.key !== 'Escape') return;
  if (sub.value) closeSub(); else close();
}

onMounted(() => {
  refresh(false);
  refresh(true);
  readTileStates();
  if (api && api.onStatus) offStatus = api.onStatus(applyStatus);
  timer = setInterval(() => refresh(false), 2500);
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  clearInterval(timer);
  clearInterval(tileTick);
  stopWifiScan();
  window.removeEventListener('keydown', onKey);
  if (typeof offStatus === 'function') offStatus();
});
</script>

<template>
  <div class="panel">
    <div class="glass">
      <span class="glass-veil" aria-hidden="true"></span>
      <span class="glass-rim" aria-hidden="true"></span>
    </div>
    <div class="panel-body">
    <div class="tiles">
      <div v-if="state.caps.wifi" class="cell">
        <div class="tile split" :class="{ on: state.wifi.connected }">
          <button class="z" @click="tileToggle('wifi')" title="点击断开/重新连接 Wi-Fi">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
              <path v-if="wifiBars >= 1" d="M3.6 9.4a13.6 13.6 0 0 1 16.8 0" />
              <path v-if="wifiBars >= 2" d="M6.6 12.6a9.4 9.4 0 0 1 10.8 0" />
              <path v-if="wifiBars >= 3" d="M9.6 15.8a5.2 5.2 0 0 1 4.8 0" />
              <circle cx="12" cy="18.4" r="1.3" fill="currentColor" stroke="none" />
            </svg>
          </button>
          <button class="z arrow" @click="openSub('wifi', $event)" title="展开 Wi-Fi">
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4 2l4 4-4 4"/></svg>
          </button>
        </div>
        <div class="label">{{ state.wifi.connected ? state.wifi.ssid : 'Wi-Fi 未连接' }}</div>
      </div>

      <div v-if="state.caps.wifi" class="cell">
        <button
          class="tile air"
          :class="{ on: airplaneOn }"
          @click="toggleAirplane"
          title="点击开启/关闭飞行模式"
        >
          <span class="plane" :class="{ fly: planeFly }">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 4.5c.9 0 1.4.9 1.4 2v3.6l6 3.4v1.9l-6-1.6v3.8l2 1.4v1.6l-3.4-1-3.4 1v-1.6l2-1.4v-3.8l-6 1.6v-1.9l6-3.4V6.5c0-1.1.5-2 1.4-2z" />
            </svg>
          </span>
        </button>
        <div class="label">飞行模式</div>
      </div>

      <div class="cell span2">
        <div class="tile wide split" :class="{ on: state.powerSaver }">
          <button class="z main" @click="tileToggle('power')" title="点击开启/关闭省电模式">
            <span class="wide-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="7.5" width="14.5" height="9.5" rx="2" />
                <path d="M19.8 10.4h.7a1.2 1.2 0 0 1 1.2 1.2v1.4a1.2 1.2 0 0 1-1.2 1.2h-.7" />
                <path d="M7 14.6c-.3-2.5 1.2-4.5 3.9-4.8-.2 2.6-1.5 4.5-3.9 4.8z" />
              </svg>
            </span>
            <span class="wide-text">
              <span class="wide-name">省电模式</span>
              <span class="wide-state">{{ powerMsg || (state.powerSaver ? '已开启' : '已关闭') }}</span>
            </span>
          </button>
          <button class="z arrow" @click="openSub('power', $event)" title="选择电源模式">
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4 2l4 4-4 4"/></svg>
          </button>
        </div>
      </div>
    </div>


    <div class="divider"></div>

    <div v-if="state.caps.brightness" class="slider-row">
      <svg class="row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
        <circle cx="12" cy="12" r="4.2" />
        <path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7" />
      </svg>
      <div class="slider-wrap" @pointermove="onNear('brightness', $event)" @pointerleave="near = ''">
        <span class="slider-val" :class="{ hot: dragging === 'brightness' || near === 'brightness' }" :style="{ '--p': brightness + '%' }">{{ brightness }}</span>
        <input
          class="slider"
          type="range"
          min="0"
          max="100"
          step="1"
          v-model="brightness"
          :style="{ '--p': brightness + '%' }"
          @input="onBrightInput"
          @pointerdown="dragging = 'brightness'"
          @pointerup="endDrag"
          @pointercancel="endDrag"
        />
      </div>
    </div>

    <div class="slider-row">
      <svg class="row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 9.5v5h3.4L11.6 18V6L7.4 9.5H4z" fill="currentColor" stroke="none" />
        <path v-if="!state.muted" d="M14.8 9.4a4 4 0 0 1 0 5.2M17.2 7.2a7 7 0 0 1 0 9.6" />
        <path v-else d="M15 9.6l4.6 4.8M19.6 9.6l-4.6 4.8" />
      </svg>
      <div class="slider-wrap" @pointermove="onNear('volume', $event)" @pointerleave="near = ''">
        <span class="slider-val" :class="{ hot: dragging === 'volume' || near === 'volume' }" :style="{ '--p': (state.muted ? 0 : volume) + '%' }">{{ state.muted ? '静音' : volume }}</span>
        <input
          class="slider"
          type="range"
          min="0"
          max="100"
          step="1"
          v-model="volume"
          :style="{ '--p': volume + '%' }"
          @input="onVolInput"
          @pointerdown="dragging = 'volume'"
          @pointerup="endDrag"
          @pointercancel="endDrag"
        />
      </div>
      <button class="mini" :title="state.muted ? '取消静音' : '静音'" @click="toggleMute">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M4 2l4 4-4 4"/></svg>
      </button>
    </div>

    <div class="divider"></div>

    <div class="footer">
      <div v-if="state.caps.battery" class="battery">
        <svg viewBox="0 0 26 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <rect x="1.2" y="2.2" width="19.6" height="9.6" rx="2" />
          <path d="M23.4 5.4v3.2" />
          <rect :x="2.6" y="4" :width="batteryFill" height="6" rx="1" :fill="batteryColor" stroke="none" />
        </svg>
        <span>{{ state.battery ? state.battery.percent + '%' : '—' }}</span>
        <span v-if="state.battery && state.battery.charging" class="charging" :style="{ color: batteryColor }">充电中</span>
      </div>
      <button class="mini gear" title="WinDock 设置" @click="openSettings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
          <circle cx="12" cy="12" r="3.1" />
          <path d="M12 4.6v2M12 17.4v2M4.6 12h2M17.4 12h2M6.8 6.8l1.4 1.4M15.8 15.8l1.4 1.4M17.2 6.8l-1.4 1.4M8.2 15.8l-1.4 1.4" />
        </svg>
      </button>
    </div>
    </div>

    <!-- 二级小窗：从被点瓦片的位置“滴”出来 -->
    <div
      v-if="sub"
      :key="subKey"
      class="sub"
      ref="subEl"
      :class="{ closing }"
      :style="{
        '--sx': fromRect.x + 'px', '--sy': fromRect.y + 'px', '--sw': fromRect.w + 'px', '--sh': fromRect.h + 'px',
        '--ex': toRect.x + 'px', '--ey': toRect.y + 'px', '--ew': toRect.w + 'px', '--eh': toRect.h + 'px',
        '--mx': morph.mx + 'px', '--my': morph.my + 'px', '--msx': morph.msx, '--msy': morph.msy,
        '--r0x': morph.r0x + 'px', '--r0y': morph.r0y + 'px',
        '--sbg': skinBg
      }"
    >
      <span class="sub-skin" ref="skinEl" aria-hidden="true"></span>
      <div class="sub-head">
        <button class="back" @click="closeSub">
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 2l-4 4 4 4"/></svg>
        </button>
        <span class="sub-title">{{ subTitles[sub] }}</span>
        <button
          v-if="sub === 'wifi' || sub === 'power'"
          class="refresh"
          :class="{ spin: subBusy }"
          @click="loadSub"
        >
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <path d="M12.2 7a5.2 5.2 0 1 1-1.6-3.7" />
            <path d="M12.4 2.4v3h-3" />
          </svg>
        </button>
      </div>

      <div class="sub-body">
        <!-- Wi-Fi -->
        <template v-if="sub === 'wifi'">
          <!-- 输密码：就在列表的位置展开，不弹系统原生窗口 -->
          <div v-if="pwTarget" class="pw">
            <div class="pw-head">连接到 <b>{{ pwTarget.ssid }}</b></div>
            <input
              ref="pwInput"
              v-model="pwValue"
              class="pw-input"
              type="password"
              placeholder="网络安全密钥"
              spellcheck="false"
              autocomplete="off"
              @keyup.enter="submitPw"
            />
            <div class="pw-actions">
              <button class="pw-btn" @click="closePw">取消</button>
              <button class="pw-btn primary" :disabled="pwBusy" @click="submitPw">
                {{ pwBusy ? '连接中…' : '连接' }}
              </button>
            </div>
            <div v-if="subMsg" class="pw-msg">{{ subMsg }}</div>
            <div class="pw-hint">连上后会存进这台电脑的 Wi-Fi 配置，下次自动连；不用的网络点行尾的 × 忘记。</div>
          </div>

          <template v-else>
            <div v-if="subData.current" class="sub-note">已连接 {{ subData.current }}</div>
            <div
              v-for="n in subData.networks"
              :key="n.ssid"
              class="row wifi-row"
              :class="{ cur: n.current, dim: !n.reachable }"
              role="button"
              tabindex="0"
              @click="wifiPick(n)"
              @keydown.enter.prevent="wifiPick(n)"
            >
              <span class="dot" :class="{ on: n.current }"></span>
              <span class="name">{{ n.ssid }}</span>
              <span class="tag">{{ wifiTag(n) }}</span>
              <span
                v-if="n.saved"
                class="forget"
                role="button"
                tabindex="0"
                title="忘记这个网络"
                @click.stop="forgetWifi(n)"
                @keydown.enter.stop.prevent="forgetWifi(n)"
              >×</span>
            </div>
            <div v-if="!subData.networks.length" class="empty">正在扫描附近的网络…</div>
          </template>
        </template>

        <!-- 飞行模式 -->
        <template v-else-if="sub === 'airplane'">
          <div class="sub-note">飞行模式会关闭无线网卡（需要管理员权限）</div>
          <button class="row" @click="runSub('wifi-toggle', 'off')">
            <span class="name">关闭无线</span>
            <span class="tag">飞行模式</span>
          </button>
          <button class="row" @click="runSub('wifi-toggle', 'on')">
            <span class="name">开启无线</span>
            <span class="tag">正常</span>
          </button>
        </template>

        <!-- 电源模式 -->
        <template v-else-if="sub === 'power'">
          <button
            v-for="p in subData.plans"
            :key="p.guid"
            class="row"
            :class="{ cur: p.active }"
            @click="runSub('power-set', p.guid)"
          >
            <span class="dot" :class="{ on: p.active }"></span>
            <span class="name">{{ p.name }}</span>
            <span class="tag">{{ p.active ? '使用中' : '' }}</span>
          </button>
          <div v-if="!subData.plans.length" class="empty">正在读取…</div>
        </template>
      </div>

      <div class="sub-foot" v-if="subMsg">{{ subMsg }}</div>
    </div>
  </div>
</template>

<style scoped>
/* 整块玻璃面板：与 Dock 同款液态玻璃 + 白色图标文字 */
.panel {
  position: relative;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  border-radius: 20px;
  overflow: hidden;
  color: rgba(255, 255, 255, 0.94);
  font-family: 'Segoe UI', 'Microsoft YaHei UI', sans-serif;
}

/* 液态玻璃：窗口真透明，桌面直接透出来；这里叠一层薄雾 + 高光 + 亮边 */
.glass {
  position: absolute;
  inset: 0;
  z-index: 1;
  border-radius: 20px;
  overflow: hidden;
  pointer-events: none;
}

.glass-veil {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(158deg,
      rgba(255, 255, 255, 0.10) 0%,
      rgba(255, 255, 255, 0.03) 40%,
      rgba(255, 255, 255, 0.015) 70%,
      rgba(255, 255, 255, 0.05) 100%),
    radial-gradient(120% 90% at 18% 8%,
      rgba(18, 22, 32, 0.46) 0%,
      rgba(12, 15, 22, 0.54) 60%,
      rgba(8, 10, 16, 0.60) 100%);
}

/* 桌面帧：放大 + 模糊，边缘不会露白，整块就是毛玻璃底 */
.glass-rim {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.30),
    inset 0 1px 0 rgba(255, 255, 255, 0.58),
    inset 0 -1px 0 rgba(255, 255, 255, 0.16),
    inset 0 0 24px rgba(255, 255, 255, 0.10);
}

.panel-body {
  position: relative;
  z-index: 3;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: 18px 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.tiles {
  display: grid;
  width: 100%;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.cell.span2 { grid-column: 1 / -1; }

/* 省电模式：整条横瓦片，左边图标 + 文字，右边箭头展开电源模式 */
.tile.wide { height: 64px; }
.tile.wide .z.main {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 12px;
  padding: 0 16px;
  text-align: left;
}
.tile.wide .z.arrow { flex: 0 0 46px; }
.wide-icon {
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.10);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.24);
  flex: 0 0 auto;
}
.wide-icon svg { width: 18px; height: 18px; }
.tile.on .wide-icon {
  background: rgba(255, 255, 255, 0.22);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.38);
}
.wide-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.wide-name { font-size: 13px; letter-spacing: 0.3px; }
.wide-state { font-size: 11px; opacity: 0.74; }

.tile.air {
  overflow: visible;
  align-items: center;
  justify-content: center;
}
.plane { display: inline-flex; align-items: center; justify-content: center; }
.plane svg { width: 22px; height: 22px; transform: rotate(90deg); }
.plane.fly { animation: plane-fly 760ms cubic-bezier(0.35, 0, 0.25, 1); }
@keyframes plane-fly {
  0% { transform: translateX(0); opacity: 1; }
  38% { transform: translateX(190%); opacity: 0; }
  40% { transform: translateX(-190%); opacity: 0; }
  100% { transform: translateX(0); opacity: 1; }
}
.tile:not(.split) { align-items: center; justify-content: center; }
.cell { display: flex; flex-direction: column; align-items: center; gap: 7px; min-width: 0; }

.tile {
  position: relative;
  width: 100%;
  height: 60px;
  display: flex;
  align-items: stretch;
  border: none;
  border-radius: 12px;
  background: rgba(10, 14, 22, 0.30);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.34);
  color: rgba(255, 255, 255, 0.95);
  cursor: pointer;
  transition: background 140ms ease, transform 140ms ease, box-shadow 140ms ease;
  overflow: hidden;
}

.tile:hover { background: rgba(255, 255, 255, 0.14); }
.tile:active { transform: scale(0.97); }
.tile:focus,
.tile:focus-visible { outline: none; }

/* 左右两块：左边图标（点一下直接开/关），右边箭头（点一下展开） */
.tile .z {
  flex: 1 1 50%;
  min-width: 0;
  display: grid;
  place-items: center;
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  transition: background 120ms ease;
}
.tile .z:hover { background: rgba(255, 255, 255, 0.08); }
.tile .z:active { background: rgba(255, 255, 255, 0.16); }
.tile .z:focus,
.tile .z:focus-visible { outline: none; }
/* 中间那条分隔线 */
.tile.split .z.arrow { box-shadow: inset 1px 0 0 rgba(255, 255, 255, 0.28); }
.tile.split .z.arrow svg { width: 11px; height: 11px; opacity: 0.75; }

/* 开 = 蓝色实心，关 = 全透明 */
.tile.on {
  background: linear-gradient(180deg, #2f9bff 0%, #0a6cff 100%);
  color: #fff;
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.28),
    0 2px 8px rgba(10, 108, 255, 0.42);
}
.tile.on:hover { background: linear-gradient(180deg, #3aa4ff 0%, #1a78ff 100%); }
.tile.on .z.arrow { box-shadow: inset 1px 0 0 rgba(255, 255, 255, 0.34); }
.tile.on .z:hover { background: rgba(255, 255, 255, 0.12); }

.tile svg { width: 22px; height: 22px; }

.chev {
  position: absolute;
  right: 7px;
  top: 50%;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  color: rgba(255, 255, 255, 0.62);
}

.chev svg { width: 10px; height: 10px; }

.label {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.92);
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

.divider { height: 1px; background: rgba(255, 255, 255, 0.16); }

.slider-row { display: flex; align-items: center; gap: 12px; position: relative; padding: 8px 0; }

.row-icon {
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  color: rgba(255, 255, 255, 0.92);
}

.slider-wrap {
  position: relative;
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  min-width: 0;
}

/* 拖动时浮在滑块上方的数值 */
.slider-val {
  position: absolute;
  top: -7px;
  left: clamp(11px, var(--p, 50%), calc(100% - 11px));
  transform: translate(-50%, -100%);
  padding: 1px 7px;
  border-radius: 7px;
  font-size: 11px;
  line-height: 15px;
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.92);
  background: rgba(18, 20, 26, 0.62);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16);
  pointer-events: none;
  white-space: nowrap;
  opacity: 0;
  transition: opacity 150ms ease;
}

/* 只在拖动、或指针停在小圆点上时出现 */
.slider-val.hot { opacity: 1; }

.slider {
  flex: 1 1 auto;
  width: 100%;
  margin: 0;
  -webkit-appearance: none;
  appearance: none;
  height: 5px;
  border-radius: 3px;
  background: linear-gradient(to right, #38a3ff 0%, #0a6cff var(--p, 50%), rgba(255, 255, 255, 0.24) var(--p, 50%), rgba(255, 255, 255, 0.24) 100%);
  outline: none;
  cursor: pointer;
}

.slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.5), 0 2px 6px rgba(0, 0, 0, 0.32);
  cursor: pointer;
}

.mini {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  border-radius: 7px;
  color: rgba(255, 255, 255, 0.8);
  cursor: pointer;
}

.mini:hover { background: rgba(255, 255, 255, 0.16); color: #fff; }
.mini:focus,
.mini:focus-visible { outline: none; }
.mini svg { width: 12px; height: 12px; }

.footer { display: flex; align-items: center; justify-content: space-between; }

.battery {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.92);
}
.battery svg { width: 26px; height: 14px; }
.charging { font-size: 11.5px; color: #7df0a6; }

.gear svg { width: 17px; height: 17px; }

/* ---------- 二级小窗 ---------- */
.sub {
  position: absolute;
  z-index: 6;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  overflow: hidden;
  border-radius: 16px;
  padding: 10px;
  background:
    linear-gradient(158deg, rgba(255, 255, 255, 0.10) 0%, rgba(255, 255, 255, 0.03) 45%, rgba(255, 255, 255, 0.07) 100%),
    radial-gradient(120% 90% at 20% 6%, rgba(36, 40, 50, 0.96) 0%, rgba(14, 16, 22, 0.98) 100%);
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.32),
    inset 0 1px 0 rgba(255, 255, 255, 0.55),
    0 10px 26px rgba(0, 0, 0, 0.34);
  left: var(--ex);
  top: var(--ey);
  width: var(--ew);
  height: var(--eh);
  /* 用真实矩形插值：宽高在变，圆角是实打实的 px，缩到瓦片大小时不会被压成直角 */
  animation: grow-from-tile 380ms linear both;
  will-change: left, top, width, height, border-radius;
}

/* 从瓦片那块玻璃“涨”成整块小窗：矩形和圆角一起插值，一路顺滑撑开，只留一点点过冲 */
@keyframes grow-from-tile {
  0% {
    left: var(--sx);
    top: var(--sy);
    width: var(--sw);
    height: var(--sh);
    border-radius: 12px;
    animation-timing-function: cubic-bezier(0.22, 0.86, 0.32, 1);
  }
  62% {
    left: calc(var(--ex) - 5px);
    top: calc(var(--ey) - 2px);
    width: calc(var(--ew) + 10px);
    height: calc(var(--eh) + 4px);
    border-radius: 19px;
    animation-timing-function: cubic-bezier(0.34, 0.6, 0.4, 1);
  }
  100% {
    left: var(--ex);
    top: var(--ey);
    width: var(--ew);
    height: var(--eh);
    border-radius: 16px;
  }
}

/* 返回：反向缩回那块瓦片，带一点回弹 */
.sub.closing {
  animation: shrink-to-tile 360ms linear both;
  /* 收缩时彻底去掉描边和外投影：那圈 1px 高光缩到瓦片大小后会变成瓦片上沿的一道线 */
  box-shadow: none;
}

/* 收进瓦片：先收到瓦片大小，再轻轻弹大一点点，最后落正——全程都不比瓦片小，不会露出空缺 */
@keyframes shrink-to-tile {
  0% {
    left: var(--ex);
    top: var(--ey);
    width: var(--ew);
    height: var(--eh);
    border-radius: 16px;
    animation-timing-function: cubic-bezier(0.5, 0, 0.72, 1);
  }
  58% {
    left: var(--sx);
    top: var(--sy);
    width: var(--sw);
    height: var(--sh);
    border-radius: 12px;
    animation-timing-function: cubic-bezier(0.3, 0, 0.35, 1);
  }
  82% {
    left: calc(var(--sx) - 3px);
    top: calc(var(--sy) - 2px);
    width: calc(var(--sw) + 6px);
    height: calc(var(--sh) + 4px);
    border-radius: 14px;
    animation-timing-function: cubic-bezier(0.3, 0, 0.3, 1);
  }
  100% {
    left: var(--sx);
    top: var(--sy);
    width: var(--sw);
    height: var(--sh);
    border-radius: 12px;
  }
}
.sub-head, .sub-body, .sub-foot {
  animation: inner-in 190ms 110ms both;
  position: relative;
  z-index: 1;
}
.sub.closing .sub-head,
.sub.closing .sub-body,
.sub.closing .sub-foot {
  animation: none;
  opacity: 0;
  transition: opacity 130ms ease;
}

@keyframes inner-in {
  0% { opacity: 0; transform: translateY(6px) scale(0.97); }
  60% { opacity: 1; transform: translateY(-2px) scale(1.01); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}

/* 起手先是一块“瓦片”：位置尺寸和底色都取自被点的那格，再淡出成小窗的玻璃 */
.sub-skin {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  overflow: hidden;
  background: var(--sbg, rgba(255, 255, 255, 0.13));
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.2),
    inset 0 1px 0 rgba(255, 255, 255, 0.26);
  pointer-events: none;
  opacity: 0;
  animation: skin-out 220ms 20ms ease both;
}

@keyframes skin-out {
  from { opacity: 1; }
  to { opacity: 0; }
}

.sub.closing .sub-skin {
  /* 收缩后段把这块皮肤换成瓦片原样淡入：缩到瓦片大小时它和底下要回来的瓦片完全重合 */
  animation: skin-in 150ms 160ms ease both;
  box-shadow: none;
}

/* 皮肤里放的“瓦片克隆”：跟皮肤同尺寸，缩到瓦片大小时与真瓦片完全重合 */
.skin-tile {
  position: absolute;
  inset: 0;
}
.skin-tile .tile {
  width: 100%;
  height: 100%;
  cursor: default;
}

@keyframes skin-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

.sub-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px 8px;
  flex: 0 0 auto;
}

.back, .refresh {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.9);
  cursor: pointer;
}

.back:hover, .refresh:hover { background: rgba(255, 255, 255, 0.22); }
.back:focus, .refresh:focus, .back:focus-visible, .refresh:focus-visible { outline: none; }
.back svg, .refresh svg { width: 11px; height: 11px; }

.refresh { margin-left: auto; }
.refresh.spin svg { animation: spin 900ms linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.sub-title {
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

.sub-body {
  flex: 1 1 auto;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-right: 2px;
}

.sub-body::-webkit-scrollbar { width: 4px; }
.sub-body::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.28); border-radius: 3px; }

.sub-note {
  font-size: 11.5px;
  color: rgba(255, 255, 255, 0.66);
  padding: 2px 4px 4px;
}

.row {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 9px;
  height: 34px;
  padding: 0 9px;
  border: none;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.09);
  color: rgba(255, 255, 255, 0.94);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  transition: background 130ms ease, transform 130ms ease;
}

.row:hover { background: rgba(255, 255, 255, 0.17); }
.row:active { transform: scale(0.985); }
.row:focus, .row:focus-visible { outline: none; }
.row.cur { background: rgba(47, 155, 255, 0.34); }
.row.static { cursor: default; }

.dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.35);
}
.dot.on { background: #57c7ff; box-shadow: 0 0 6px rgba(87, 199, 255, 0.8); }

.name {
  flex: 1 1 auto;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.tag {
  flex: 0 0 auto;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.62);
}

/* Wi-Fi 行：悬停时右侧状态淡出、同一位置浮出「忘记」按钮，行高宽度都不变 */
.wifi-row { position: relative; }
.wifi-row.dim { opacity: 0.62; }
.wifi-row .tag { transition: opacity 120ms ease; }
.wifi-row:hover .tag,
.wifi-row:focus-within .tag { opacity: 0; }
.wifi-row .forget {
  position: absolute;
  right: 5px;
  top: 50%;
  width: 22px;
  height: 22px;
  margin-top: -11px;
  display: grid;
  place-items: center;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.16);
  color: rgba(255, 255, 255, 0.8);
  font-size: 13px;
  line-height: 1;
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease, background 120ms ease;
}
.wifi-row:hover .forget,
.wifi-row:focus-within .forget { opacity: 1; pointer-events: auto; }
.wifi-row .forget:hover { background: rgba(255, 255, 255, 0.32); color: #fff; }

/* 输密码卡片（就地展开，尺寸随内容，不改变小窗尺寸） */
.pw {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px 10px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.09);
}
.pw-head { font-size: 12px; color: rgba(255, 255, 255, 0.78); }
.pw-head b { font-weight: 600; color: #fff; }
.pw-input {
  height: 28px;
  padding: 0 9px;
  border: 1px solid rgba(255, 255, 255, 0.26);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.22);
  color: #fff;
  font-size: 12.5px;
  outline: none;
}
.pw-input::placeholder { color: rgba(255, 255, 255, 0.42); }
.pw-input:focus { border-color: rgba(87, 199, 255, 0.85); box-shadow: 0 0 0 2px rgba(87, 199, 255, 0.22); }
.pw-actions { display: flex; justify-content: flex-end; gap: 6px; }
.pw-btn {
  height: 26px;
  padding: 0 11px;
  border: none;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
  transition: background 120ms ease;
}
.pw-btn:hover { background: rgba(255, 255, 255, 0.26); }
.pw-btn.primary { background: rgba(47, 155, 255, 0.62); }
.pw-btn.primary:hover { background: rgba(47, 155, 255, 0.82); }
.pw-btn:disabled { opacity: 0.7; cursor: default; }
.pw-msg { font-size: 11.5px; color: rgba(255, 255, 255, 0.7); }
.pw-hint { font-size: 11px; line-height: 1.5; color: rgba(255, 255, 255, 0.45); }

.empty {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
  padding: 10px 4px;
}

.sub-foot {
  flex: 0 0 auto;
  padding: 6px 4px 2px;
  font-size: 11.5px;
  color: rgba(255, 255, 255, 0.7);
}
</style>
