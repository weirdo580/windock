'use strict';

/**
 * 主进程：透明置顶窗口、桌面采样、配置读写、启动程序、右键菜单。
 * 渲染进程只负责界面与动画，所有系统能力都走这里的 IPC。
 */

const { app, BrowserWindow, ipcMain, screen, desktopCapturer, session, Menu, shell, dialog, nativeImage, Tray } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const https = require('https');

const CONFIG_NAME = 'app-config.json';
const isDev = !!process.env.VITE_DEV_SERVER_URL;
const isPackaged = app.isPackaged;

app.setName('WinDock');
if (process.platform === 'win32') app.setAppUserModelId('com.windock.desktop');

let win = null;
let settingsWin = null;
let quickWin = null;          // Dock 右侧状态区弹出的快捷面板窗口
let quickShownAt = 0;
// 面板里最近一次「点开关」的时间戳：这段时间内失焦不关闭窗口
let quickLastActAt = 0;
let volLevel = null;          // 音量估算（系统音量键 2% 步进）
let volMuted = false;
let tray = null;
let cfg = null;
let captureProtection = null;
let cfgPath = null;
// 首次启动（本机还没有用户配置）：打开设置页给一次上手引导
let firstRun = false;
let firstRunChecked = false;
let previewDirty = false;      // 设置页正在实时预览、但尚未写入磁盘
let captureCache = null;
const runningPids = new Map(); // 应用 id -> 子进程 pid
let zBridgeActive = false;     // win-bridge.ps1 接管 Dock 层级后为 true

const FALLBACK_CONFIG = {
  apps: [
    { id: 'trash', name: '废纸篓', path: 'shell:RecycleBinFolder', icon: 'icons/trash.svg' },
    { id: 'notepad', name: '记事本', path: '%WINDIR%\\System32\\notepad.exe', icon: 'icons/notepad.svg' },
    { id: 'explorer', name: '文件资源管理器', path: '%WINDIR%\\explorer.exe', icon: 'icons/explorer.svg' },
    { type: 'separator', id: 'music-separator' },
    { type: 'music', id: 'music', name: '音乐' },
    { type: 'separator', id: 'windows-separator' },
    { type: 'minimized', id: 'minimized', name: '最小化窗口' }
  ],
  glass: {
    refraction: 0,
    fresnel: 0.39,
    blur: 1.06,
    opacity: 0,
    shadow: 0,
    radius: 30,
    saturation: 1,
    captureInterval: 100,
    // 0 = 自动：按主屏物理宽度算，避免 4K 屏被压到 1920 而发糊
    captureWidth: 0,
    captureWidthAuto: true
  },
  dock: {
    height: 52,
    iconSize: 36,
    maxScale: 1.36,
    magnification: true,
    effectStrength: 0.05,
    animationDuration: 80,
    autoHide: false,
    autoHideDelay: 650,
    autoHideDuration: 460,
    bounce: false,
    // 0 = 自动：按任务栏实际高度算，任务栏在底部/顶部、开自动隐藏都不会压住 Dock
    bottomMargin: 0,
    gap: 14,
    padding: 8
  },
  global: { alwaysOnTop: true, tooltip: true, autoStart: false }
};

/** 深合并，保证用户配置缺字段时也能补上默认值 */
function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!patch || typeof patch !== 'object') return out;
  for (const key of Object.keys(patch)) {
    const bv = out[key];
    const pv = patch[key];
    if (Array.isArray(pv)) out[key] = pv.slice();
    else if (pv && typeof pv === 'object') out[key] = deepMerge(bv && typeof bv === 'object' && !Array.isArray(bv) ? bv : {}, pv);
    else out[key] = pv;
  }
  return out;
}

function resolveConfigPath() {
  // 未打包时读写项目根目录的配置，打包后写到用户目录并保留一份初始模板
  if (!isPackaged) {
    const devCfg = path.join(app.getAppPath(), CONFIG_NAME);
    // 第一次启动（还没有用户配置）：打开设置页给一次上手引导
    if (!firstRunChecked) { firstRun = !fs.existsSync(devCfg); firstRunChecked = true; }
    return devCfg;
  }
  const userCfg = path.join(app.getPath('userData'), CONFIG_NAME);
  if (!firstRunChecked) {
    firstRun = !fs.existsSync(userCfg);
    firstRunChecked = true;
  }
  if (!fs.existsSync(userCfg)) {
    const seed = path.join(process.resourcesPath, CONFIG_NAME);
    try {
      if (fs.existsSync(seed)) fs.copyFileSync(seed, userCfg);
    } catch (err) {
      console.warn('[config] 拷贝初始配置失败', err);
    }
  }
  return userCfg;
}

function loadConfig() {
  cfgPath = resolveConfigPath();
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[config] 读取失败，使用默认配置', err.message);
  }
  cfg = deepMerge(FALLBACK_CONFIG, raw || {});
  if (!Array.isArray(cfg.apps)) cfg.apps = [];
  if (cfg.glass) cfg.glass.shadow = 0;
  // 始终置顶由设置里的开关决定，默认保持开启
  if (cfg.global && typeof cfg.global.alwaysOnTop !== 'boolean') cfg.global.alwaysOnTop = true;
  syncBottomMarginIntent();
  return cfg;
}

// ---------------- 屏幕自适应 ----------------
// 底边留白 / 采样宽度都支持“自动”：按当前这台电脑的主屏算，而不是写死一套数值。
let bottomMarginAuto = false;

function taskbarInset() {
  try {
    const d = screen.getPrimaryDisplay();
    const inset = Math.max(
      Math.max(0, Math.round(d.size.height - d.workArea.height)),
      Math.max(0, Math.round(d.size.width - d.workArea.width))
    );
    return inset > 0 ? inset : 48; // 自动隐藏任务栏时读不到，退一个常见高度
  } catch (err) { return 48; }
}

function autoBottomMargin() {
  return Math.max(18, taskbarInset() + 12);
}

/** 用户在设置里把底边留白写死（>0 且和自动值不同）就尊重用户，否则按屏幕算 */
function syncBottomMarginIntent(incoming) {
  const raw = incoming !== undefined
    ? Number(incoming)
    : Number(cfg && cfg.dock && cfg.dock.bottomMargin);
  if (Number.isFinite(raw)) {
    if (raw <= 0) bottomMarginAuto = true;
    else if (Math.abs(raw - autoBottomMargin()) > 2) bottomMarginAuto = false;
  }
  if (bottomMarginAuto && cfg && cfg.dock) cfg.dock.bottomMargin = autoBottomMargin();
}

/** 用户在设置里把采样宽度写死（和自动值不同）就按用户的来，写回 0 则恢复自动 */
function syncCaptureWidthIntent(incoming) {
  if (incoming === undefined || incoming === null) return;
  const raw = Number(incoming);
  if (!Number.isFinite(raw)) return;
  if (raw <= 0) {
    if (cfg && cfg.glass) { cfg.glass.captureWidthAuto = true; cfg.glass.captureWidth = 0; }
    return;
  }
  if (Math.abs(raw - glassCaptureWidth()) > 2 && cfg && cfg.glass) cfg.glass.captureWidthAuto = false;
}

/** 主屏物理宽度：4K/2K 屏不再被写死的 1920 压糊 */
function displayPhysicalWidth() {
  try {
    const d = screen.getPrimaryDisplay();
    return Math.round(d.size.width * (d.scaleFactor || 1));
  } catch (err) { return 1920; }
}

function saveConfig(next) {
  const incomingMargin = next && next.dock ? next.dock.bottomMargin : undefined;
  const incomingWidth = next && next.glass ? next.glass.captureWidth : undefined;
  cfg = deepMerge(FALLBACK_CONFIG, next || cfg);
  if (!Array.isArray(cfg.apps)) cfg.apps = [];
  if (cfg.glass) cfg.glass.shadow = 0;
  // 始终置顶的开关由用户决定，这里不再强制改写
  if (cfg.global && typeof cfg.global.alwaysOnTop !== 'boolean') cfg.global.alwaysOnTop = true;
  syncBottomMarginIntent(incomingMargin);
  syncCaptureWidthIntent(incomingWidth);
  previewDirty = false;
  const tmp = cfgPath + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tmp, cfgPath); // 原子替换，避免写坏配置
  } catch (err) {
    console.warn('[config] 保存失败', err);
  }
  relayout();
  syncAutoStart();
  return cfg;
}

let autoStartApplied = null;

/**
 * 把配置里的开机自启动状态同步到 Windows 登录项。
 * 开发态启动 electron.exe 时需要补上项目目录参数，打包后直接启动 exe。
 */
function syncAutoStart(force = false) {
  if (process.platform !== 'win32') return;
  const enabled = cfg && cfg.global && cfg.global.autoStart === true;
  if (!force && autoStartApplied === enabled) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      name: 'WinDock',
      path: process.execPath,
      args: isPackaged ? [] : [`"${app.getAppPath()}"`]
    });
    autoStartApplied = enabled;
  } catch (err) {
    console.warn('[autostart] 同步失败', err);
  }
}

/**
 * 设置页实时预览：把草稿配置立即套用到 Dock，但不写磁盘。
 * 设置页停止操作后会自动保存；若关闭时还没落盘，closed 回调会补一次保存。
 */
function previewConfig(next) {
  const incomingMargin = next && next.dock ? next.dock.bottomMargin : undefined;
  const incomingWidth = next && next.glass ? next.glass.captureWidth : undefined;
  cfg = deepMerge(FALLBACK_CONFIG, next || cfg);
  if (!Array.isArray(cfg.apps)) cfg.apps = [];
  if (cfg.glass) cfg.glass.shadow = 0;
  syncBottomMarginIntent(incomingMargin);
  syncCaptureWidthIntent(incomingWidth);
  previewDirty = true;
  relayout();
  return cfg;
}

// ---------------- 窗口几何 ----------------

function itemWidth(item) {
  if (!item) return 0;
  if (item.type === 'separator') {
    // 右侧“最小化窗口”区的分隔线，在没有最小化窗口时一起隐藏
    if (item.id === 'windows-separator' && minimizedWidth() === 0) return 0;
    return 13;
  }
  if (item.type === 'music') return 168;
  if (item.type === 'minimized') return minimizedWidth();
  return cfg.dock.iconSize;
}

function dockWidth() {
  const d = cfg.dock;
  const vis = cfg.apps.filter(it => itemWidth(it) > 0);
  const n = vis.length;
  let w = d.padding * 2 + Math.max(0, n - 1) * d.gap;
  vis.forEach(it => { w += itemWidth(it); });
  // 渲染进程末尾固定追加的右侧状态区（标准分隔线 + 中/Wi-Fi/音量/电池）
  w += d.gap + 13 + d.gap + 94;
  return Math.round(w);
}

/**
 * 窗口刚好罩住 Dock 以及它上方 Tooltip / 图标放大的空间。
 * 透明区域通过鼠标穿透交给桌面，只有图标带会拦截点击。
 */
function computeBounds() {
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  const d = cfg.dock;
  const grow = d.iconSize * ((d.magnification === false ? 1 : d.maxScale) - 1);
  const folderRoom = 190;
  // 底板会跟着图标一起变宽，窗口只需再留一点余量和 Tooltip 空间
  const spread = Math.ceil(grow * 1.8 + 28);
  const width = Math.min(area.width, Math.ceil(dockWidth() + spread * 2));
  const height = Math.ceil(d.bottomMargin + d.height + grow + Math.max(56, folderRoom));
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + area.height - height),
    width,
    height
  };
}

function dockZonePath() {
  return path.join(app.getPath('temp'), 'tahoe-liquid-dock-zone.json');
}

/**
 * 把 Dock 底板在窗口里的位置写给 z 序守护进程（win-bridge.ps1）。
 * 用比例而不是绝对像素：Win32 窗口矩形是物理像素、Electron 是 DIP，
 * 在 125%/150% 缩放下绝对值会对不上；比例天然无关缩放。
 */
function writeDockZone(bounds) {
  const d = cfg.dock;
  const w = Math.max(1, bounds.width);
  const h = Math.max(1, bounds.height);
  const baseW = Math.max(1, Math.min(w, dockWidth()));
  const baseH = Math.max(1, Number(d.height) || 1);
  const offX = Math.max(0, (w - baseW) / 2);
  const offY = Math.max(0, h - (Number(d.bottomMargin) || 0) - baseH);
  const zone = {
    ox: offX / w,
    oy: offY / h,
    ow: baseW / w,
    oh: baseH / h,
    top: cfg.global && cfg.global.alwaysOnTop === false ? 0 : 1,
    hide: d.autoHide === true ? 1 : 0
  };
  try {
    fs.writeFileSync(dockZonePath(), JSON.stringify(zone), 'utf8');
  } catch (err) {
    console.warn('[layout] 写入 Dock 区域失败', err && err.message);
  }
}

function glassNeedsProtectedCapture() {
  // 以前开背景模糊时会把窗口设成“禁止截屏（WDA_EXCLUDEFROMCAPTURE）”，
  // 用来防止桌面采样把 Dock 自己拍进玻璃里。副作用是用户自己截图时 Dock 也一起消失。
  // 现在改成渲染层采样时整体上移一点（取 Dock 上方那截桌面），玻璃里不会出现 Dock 重影，
  // 也就不需要禁止截屏了，截图/录屏里 Dock 正常出现。
  return false;
}

// 只在真正切换时调用，避免拖动滑杆的每一帧都重复设置导致 Dock 闪一下。
function applyContentProtection() {
  if (!win || win.isDestroyed()) return;
  const next = glassNeedsProtectedCapture();
  if (captureProtection === next) return;
  captureProtection = next;
  try { win.setContentProtection(next); } catch (err) { /* ignore */ }
  // 让渲染层丢掉切换前那帧（里面可能还带着 Dock 图标），等干净帧再显示效果。
  try {
    if (win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('capture:reset', { protected: next, at: Date.now() });
    }
  } catch (err) { /* ignore */ }
}

// 上一次真正下发的窗口矩形/区域文件/配置指纹。设置页拖滑杆时每 50ms 就会预览一次，
// 其中绝大多数只是观感参数变化，窗口大小和位置完全没变；原来每次都 setBounds
// 并重写 zone 文件，Dock 会被反复挤一下，拖动手感因此一顿一顿。
let lastZoneKey = '';
let lastCfgKey = '';
let lastBoundsKey = '';

/** zone 文件的内容取决于这些值：几何 + 置顶/自动隐藏 + 底板尺寸 */
function zoneKey(b) {
  return [
    b.x, b.y, b.width, b.height,
    cfg.global && cfg.global.alwaysOnTop === false ? 0 : 1,
    cfg.dock.autoHide === true ? 1 : 0,
    dockWidth(),
    Number(cfg.dock.height) || 0,
    Number(cfg.dock.bottomMargin) || 0
  ].join(',');
}

/** 便宜的配置指纹：只关心几何/观感参数和图标是否变化，不比较 base64 图标内容 */
function cfgKey(c) {
  const apps = (c.apps || []).map(a => [
    a.id, a.path, a.name, a.type || '', a.width || 0,
    // 图标内容变了但长度没变的情况（换图）也要能识别，取短哈希而不是整串 base64
    (a.icon ? crypto.createHash('sha1').update(String(a.icon)).digest('hex').slice(0, 10) : '')
  ].join('\u0001')).join('\u0002');
  return `${JSON.stringify([c.dock, c.glass, c.global])}#${apps}`;
}

function relayout() {
  if (!win || win.isDestroyed()) return;
  // 底边留白是自动档时，跟着任务栏/分辨率重新算一遍
  if (bottomMarginAuto && cfg && cfg.dock) {
    const next = autoBottomMargin();
    if (Math.abs(Number(cfg.dock.bottomMargin) - next) > 1) cfg.dock.bottomMargin = next;
  }
  // 设置页改了“刷新间隔/采样宽度”、或换了显示器时，按新参数重建屏幕捕获
  syncWgcGeometry();
  // “始终置顶”开关要即时生效，不能等 z 序守护进程下一轮（约 200ms）才动作；
  // 守护进程随后仍会按配置维持层级。
  if (win.setAlwaysOnTop) {
    const top = cfg.global ? cfg.global.alwaysOnTop !== false : true;
    win.setAlwaysOnTop(top, top ? 'screen-saver' : 'normal');
  }
  // 只有背景模糊/饱和度开启时才把 Dock 自身排除在桌面采样之外；
  // 这样映射层只拿得到壁纸/其他窗口，不会复制 Dock 图标形成重影。
  applyContentProtection();
  const b = computeBounds();
  const bKey = `${b.x},${b.y},${b.width},${b.height}`;
  const zKey = zoneKey(b);
  // 只有区域文件真的会变才重写（置顶/自动隐藏开关也在里面，不能漏）
  if (zKey !== lastZoneKey) {
    lastZoneKey = zKey;
    writeDockZone(b);
  }
  // 窗口矩形只有真变了才重新摆，避免拖动观感参数时 Dock 被反复挤
  const boundsChanged = bKey !== lastBoundsKey;
  if (boundsChanged) {
    lastBoundsKey = bKey;
    try {
      const was = win.isResizable();
      if (!was) win.setResizable(true);
      win.setBounds(b);
      if (!was) win.setResizable(false);
    } catch (err) {
      console.warn('[layout] resize failed', err && err.message);
    }
  }
  const cKey = cfgKey(cfg);
  if (!boundsChanged && cKey === lastCfgKey) return; // 真的没变，别打扰渲染层
  lastCfgKey = cKey;
  win.webContents.send('config:updated', { config: cfg, configPath: cfgPath });
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('config:updated', { config: cfg, configPath: cfgPath });
  }
}

// ---------------- 窗口 ----------------

function appIconPath() {
  const packed = path.join(process.resourcesPath, 'icon.ico');
  if (app.isPackaged && fs.existsSync(packed)) return packed;
  return path.join(__dirname, '..', 'build', 'icon.ico');
}

function appIcon() {
  const file = appIconPath();
  try {
    const image = nativeImage.createFromPath(file);
    if (!image.isEmpty()) return image;
  } catch (err) { /* 回退到路径，交给 Electron 自己读取 */ }
  return file;
}

let winDockIconData = '';

/** 最小化区里的设置窗口缩略图标，使用 WinDock 自己的图标而不是 electron.exe 的旧图标 */
function winDockIconDataUrl() {
  if (winDockIconData) return winDockIconData;
  try {
    const image = nativeImage.createFromPath(appIconPath());
    if (!image.isEmpty()) {
      winDockIconData = image.resize({ width: 128, height: 128 }).toDataURL();
    }
  } catch (err) { /* ignore */ }
  return winDockIconData;
}

function createWindow() {
  const bounds = computeBounds();
  win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: cfg.global ? cfg.global.alwaysOnTop !== false : true,
    icon: appIcon(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  win.setMenu(null);
  // 窗口先以 0 透明度存在，等首帧透明合成完成后再恢复可见，避免启动白底闪现。
  // 只影响显示时机，不改 Dock 的任何视觉和功能。
  win.setOpacity(0);
  const keepTop = cfg.global ? cfg.global.alwaysOnTop !== false : true;
  if (win.setAlwaysOnTop) win.setAlwaysOnTop(keepTop, keepTop ? 'screen-saver' : 'normal');
  // 告诉 z 序守护进程 Dock 底板的实际位置（窗口随即可能被沉到软件窗口下面）
  writeDockZone(bounds);
  // 采样时按需排除 Dock 窗口自身，避免把图标/组件复制进玻璃背景造成色散重影。
  applyContentProtection();
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // 初始全部穿透，鼠标移入图标带后由渲染进程关掉穿透
  win.setIgnoreMouseEvents(true, { forward: true });

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
  }

  win.once('ready-to-show', () => {
    // 透明无边框窗口在 Windows 上首次显示时，DWM 会先画出一张白色初始表面。
    // 这段白底只存在于 show 后的极短时间，因此先以 0 透明度显示，
    // 等透明帧稳定后再恢复 opacity=1；不改 Dock 本身的视觉和功能。
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      win.showInactive();
      setTimeout(() => {
        if (win && !win.isDestroyed()) win.setOpacity(1);
      }, 180);
    }, 360);
  });
  win.on('closed', () => { win = null; });
}

function openSettingsWindow(options) {
  const wantWelcome = !!(options && options.welcome);
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    // 已经开着的设置页：直接让它把引导展开
    if (wantWelcome) {
      try { settingsWin.webContents.send('ui:action', { type: 'welcome' }); } catch (err) {}
    }
    return;
  }

  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1060, Math.max(720, area.width - 40));
  const height = Math.min(760, Math.max(560, area.height - 40));
  settingsWin = new BrowserWindow({
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
    minWidth: Math.min(860, width),
    minHeight: Math.min(600, height),
    title: 'WinDock 设置',
    icon: appIcon(),
    backgroundColor: '#101218',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // 设置页靠 50ms 一次的预览把改动送到 Dock。窗口被别的窗口挡住/失焦时，
      // Chromium 会把定时器压到 1 秒一次，拖滑杆就变成 Dock 一顿一顿地追，
      // 最后关窗时还可能留下没送出去的草稿。这里关掉后台节流，让同步跟手。
      backgroundThrottling: false
    }
  });
  settingsWin.setMenu(null);
  if (isDev) {
    settingsWin.loadURL(`${process.env.VITE_DEV_SERVER_URL}${wantWelcome ? '?welcome=1' : ''}#settings`);
  } else {
    settingsWin.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'), {
      hash: 'settings',
      query: wantWelcome ? { welcome: '1' } : {}
    });
  }
  settingsWin.once('ready-to-show', () => {
    if (!settingsWin || settingsWin.isDestroyed()) return;
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
  });
  settingsWin.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (!settingsWin || settingsWin.isDestroyed()) return;
      if (settingsWin.isMinimized()) settingsWin.restore();
      settingsWin.show();
    }, 150);
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
    // 设置页现在是自动保存；若关闭时还有刚预览、尚未落盘的改动，直接补一次保存。
    if (previewDirty) {
      saveConfig(cfg);
    }
  });
}

// ---------------- 快捷面板（Dock 右侧状态区弹出） ----------------

const QUICK_W = 372;
const QUICK_H = 398;

function quickPanelPosition() {
  const area = screen.getPrimaryDisplay().workArea;
  const panelW = QUICK_W;
  const panelH = QUICK_H;
  let right = area.x + area.width / 2;
  let barTop = area.y + area.height - 60;
  if (win && !win.isDestroyed()) {
    const b = win.getBounds();
    // Dock 底板在窗口里水平居中，宽度 dockWidth()，底边距 bottomMargin
    right = b.x + (b.width + dockWidth()) / 2;
    barTop = b.y + b.height - (Number(cfg?.dock?.bottomMargin) || 0) - (Number(cfg?.dock?.height) || 52);
  }
  const x = Math.round(Math.min(area.x + area.width - panelW - 12, Math.max(area.x + 12, right - panelW)));
  const y = Math.round(Math.max(area.y + 12, barTop - panelH - 10));
  return { x, y, width: panelW, height: panelH };
}

function ensureQuickWindow() {
  if (quickWin && !quickWin.isDestroyed()) return quickWin;
  const pos = quickPanelPosition();
  quickWin = new BrowserWindow({
    x: pos.x,
    y: pos.y,
    width: pos.width,
    height: pos.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    roundedCorners: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    title: 'WinDock 快捷面板',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // 面板不总是前台窗口，关掉后台节流，动画才不会卡在半路
      backgroundThrottling: false
    }
  });
  quickWin.setMenu(null);
  quickWin.setAlwaysOnTop(true, 'pop-up-menu');
  if (isDev) {
    quickWin.loadURL(`${process.env.VITE_DEV_SERVER_URL}#quick`);
  } else {
    quickWin.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'), { hash: 'quick' });
  }
  // 失焦即关闭，和系统弹层一致；但「刚点完某个开关」的那一小段时间不关：
  // 操作会拉起 PowerShell / 系统对话框，Windows 可能把焦点抢走一下，面板就会自己缩回去
  quickWin.on('blur', () => {
    if (Date.now() - quickShownAt < 1200) return;
    if (Date.now() - quickLastActAt < 2200) {
      // 刚操作过：把焦点抢回来，别让面板消失
      try { if (quickWin.isVisible()) quickWin.focus(); } catch (err) { /* 静默 */ }
      return;
    }
    if (quickWin && !quickWin.isDestroyed() && quickWin.isVisible()) quickWin.hide();
  });
  quickWin.on('closed', () => { quickWin = null; stopQuickCursorWatch(); });
  quickWin.on('closed', () => { quickWin = null; });
  return quickWin;
}

async function toggleQuickPanel(open) {
  try {
    const w = ensureQuickWindow();
    if (!w || w.isDestroyed()) return { open: false, error: 'no-window' };
    const wantOpen = open === true ? true : open === false ? false : !w.isVisible();
    if (!wantOpen) {
      w.hide();
      return { open: false };
    }
    const pos = quickPanelPosition();
    w.setBounds(pos);
    quickShownAt = Date.now();
    // 必须真正激活窗口：Electron 在 Windows 下对「不激活窗口」不派发鼠标事件，
    // 之前的 showInactive 会让面板整块点不动
    w.show();
    w.focus();
    return { open: true };
  } catch (err) {
    return { open: false, error: String(err && err.message || err) };
  }
}

// ---------------- 托盘 ----------------

function createTrayIcon() {
  if (tray) return;
  try {
    tray = new Tray(appIconPath());
    tray.setToolTip('WinDock');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开设置', click: openSettingsWindow },
      { label: '显示 Dock', click: () => { if (win && !win.isDestroyed()) win.showInactive(); } },
      { type: 'separator' },
      { label: '退出 WinDock', click: () => app.quit() }
    ]));
    tray.on('double-click', openSettingsWindow);
  } catch (err) {
    console.error('create tray failed', err);
  }
}

// ---------------- 启动程序 ----------------

function expandEnv(p) {
  if (typeof p !== 'string') return '';
  return p.replace(/%([^%]+)%/g, (m, name) => process.env[name] || m);
}

function launchItem(item) {
  if (!item) return { ok: false, error: '找不到该图标配置' };
  const raw = item.path || '';
  const target = expandEnv(raw);

  if (raw.startsWith('shell:')) {
    try {
      const child = spawn('explorer.exe', [raw], { detached: true, stdio: 'ignore' });
      child.on('error', () => shell.openPath(target).catch(() => {}));
      child.unref();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  if (/\.exe$/i.test(target)) {
    try {
      const child = spawn(target, [], {
        detached: true,
        stdio: 'ignore',
        cwd: path.dirname(target)
      });
      child.on('error', () => {});
      if (child.pid) runningPids.set(item.id, child.pid);
      child.unref();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  if (!target || !fs.existsSync(target)) {
    return { ok: false, error: '路径不存在：' + target };
  }
  shell.openPath(target).catch(err => console.warn('[launch] 打开失败', err));
  return { ok: true };
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// ---------------- 运行状态 ----------------

let procCache = { at: 0, names: new Set() };

function listProcessNames() {
  const now = Date.now();
  if (now - procCache.at < 1200) return Promise.resolve(procCache.names);
  return new Promise(resolve => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      const names = new Set();
      if (!err && stdout) {
        stdout.split(/\r?\n/).forEach(line => {
          const m = line.match(/^"([^"]+)"/);
          if (m) names.add(m[1].toLowerCase());
        });
      }
      procCache = { at: Date.now(), names };
      resolve(names);
    });
  });
}

function processNameOf(item) {
  if (!item || !item.path || item.path.startsWith('shell:')) return '';
  const target = expandEnv(item.path);
  const base = path.basename(target);
  return /\.exe$/i.test(base) ? base.toLowerCase() : '';
}

// ---------------- 桌面采样 ----------------

// Windows Graphics Capture：在捕获源头关闭鼠标指针（cursorCapture:false）。
// Chromium 的桌面捕获在指针压到受保护窗口上时仍会把指针录进画面，导致玻璃里出现第二个指针。
let wgcScreen = null;
let wgcControl = null;
let wgcIntervalApplied = 0;
let wgcWidthApplied = 0;
let wgcRestartTimer = 0;
let wgcLatest = null;
let wgcLastEmit = 0;

function glassCaptureInterval() {
  const n = Number(cfg && cfg.glass && cfg.glass.captureInterval);
  return Math.max(100, Math.min(60000, Number.isFinite(n) ? n : 1000));
}

/** WGC 源头要的帧间隔：跟设置页的“刷新间隔”一致，最低 100ms */
function wgcTargetInterval() {
  return Math.max(100, Math.min(60000, Math.round(glassCaptureInterval())));
}

/** 设置里的刷新间隔或采样宽度改了，捕获会话要按新参数重建 */
function syncWgcGeometry() {
  if (!wgcScreen) return;
  if (wgcTargetInterval() === wgcIntervalApplied && glassCaptureWidth() === wgcWidthApplied) return;
  clearTimeout(wgcRestartTimer);
  wgcRestartTimer = setTimeout(restartWgcCapture, 350);
}

async function restartWgcCapture() {
  clearTimeout(wgcRestartTimer);
  const target = wgcTargetInterval();
  const width = glassCaptureWidth();
  if (!wgcScreen || (target === wgcIntervalApplied && width === wgcWidthApplied)) return;
  const old = wgcScreen;
  wgcScreen = null; // 让旧循环自己退出
  wgcLatest = null;
  wgcLastEmit = 0;
  try { if (wgcControl && wgcControl.stop) await wgcControl.stop(); } catch (err) { /* 忽略 */ }
  try { if (old && old.stop) await old.stop(); } catch (err) { /* 忽略 */ }
  wgcControl = null;
  wgcIntervalApplied = 0;
  wgcWidthApplied = 0;
  await startWgcCapture();
}

function glassCaptureWidth() {
  // 默认自动：按主屏物理宽度采，4K/2K 屏不会因为写死 1920 而发糊；
  // 上限 2560 是为了在 4K 屏上也不把 JPEG 编码拖得太重。
  if (!cfg || !cfg.glass || cfg.glass.captureWidthAuto !== false) {
    return Math.max(320, Math.min(2560, displayPhysicalWidth()));
  }
  const n = Number(cfg.glass && cfg.glass.captureWidth);
  const fallback = displayPhysicalWidth();
  return Math.max(320, Math.min(2560, Math.round(Number.isFinite(n) && n > 0 ? n : fallback)));
}

async function startWgcCapture() {
  if (process.platform !== 'win32' || wgcScreen) return;
  try {
    const { ScreenCapture, ImageFormat } = require('@screen-capture/node');
    const capture = new ScreenCapture({
      monitorIndex: 1,
      cursorCapture: false,
      drawBorder: false,
      colorFormat: 'bgra8',
      // 只按设置页要的节奏要帧（100ms~60s 可选），上层 WGC 就不会按 30fps
      // 整屏回传 BGRA 帧；调小更跟手，调大更省 CPU。
      minimumUpdateIntervalMs: wgcTargetInterval()
    });
    wgcScreen = capture;
    wgcLastEmit = 0;
    wgcIntervalApplied = wgcTargetInterval();
    wgcWidthApplied = glassCaptureWidth();
    wgcControl = await capture.start();
    (async () => {
      for await (const frame of capture) {
        if (wgcScreen !== capture) break;
        const now = Date.now();
        // 设置页的“采样间隔”控制玻璃背景的刷新频率。
        if (now - wgcLastEmit < glassCaptureInterval()) continue;
        // 画面完全没变（静止壁纸/静止桌面）就不必重新编码 JPEG 再 base64 推一遍：
        // 玻璃看到的是同一张图，省掉的只是纯浪费的主进程开销。
        try {
          const dirty = frame.dirtyRegions;
          if (wgcLatest && Array.isArray(dirty) && dirty.length === 0) continue;
        } catch (err) { /* 拿不到脏区就按正常流程走 */ }
        const display = screen.getPrimaryDisplay();
        // 玻璃只显示 Dock 那一条，没必要每帧解码整屏；抓底部一条即可。
        const stripH = Math.min(380, Math.max(240, Math.round(display.size.height * 0.4)));
        const physicalTop = Math.max(0, frame.height - Math.round(stripH * frame.height / Math.max(1, display.size.height)));
        const strip = frame.crop(0, physicalTop, frame.width, frame.height);
        let jpeg = strip.encode(ImageFormat.Jpeg);
        const targetWidth = glassCaptureWidth();
        if (targetWidth < strip.width) {
          try {
            const image = nativeImage.createFromBuffer(jpeg);
            if (!image.isEmpty()) jpeg = image.resize({ width: targetWidth, quality: 'good' }).toJPEG(88);
          } catch (err) { /* 缩放失败时保留原始帧 */ }
        }
        wgcLastEmit = now;
        wgcLatest = {
          at: now,
          payload: {
            dataUrl: 'data:image/jpeg;base64,' + jpeg.toString('base64'),
            display: {
              x: display.bounds.x,
              y: display.bounds.y,
              width: display.size.width,
              height: display.size.height,
              scaleFactor: display.scaleFactor
            },
            strip: {
              y: display.size.height - stripH,
              height: stripH
            },
            capturedAt: now,
            source: 'wgc'
          }
        };
      }
    })().catch(err => {
      console.warn('[wgc] 捕获循环结束', err && err.message);
    });
  } catch (err) {
    wgcScreen = null;
    console.warn('[wgc] 启动失败，退回桌面缩略图', err && err.message);
  }
}

function stopWgcCapture() {
  const capture = wgcScreen;
  wgcScreen = null;
  if (capture) {
    try { capture.stop(); } catch (err) {}
  }
}
async function captureDesktop() {
  if (wgcLatest) return wgcLatest.payload;
  const display = screen.getPrimaryDisplay();
  const now = Date.now();
  const interval = glassCaptureInterval();
  if (captureCache && now - captureCache.at < interval) return captureCache.payload;

  // 缩略图兜底同样遵守设置页的采样宽度。
  const width = glassCaptureWidth();
  const height = Math.round(width * display.size.height / Math.max(1, display.size.width));

  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
      fetchWindowIcons: false
    });
    const source = sources.find(s => s.display_id === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) return null;
    const jpeg = source.thumbnail.toJPEG(88);
    const payload = {
      dataUrl: 'data:image/jpeg;base64,' + jpeg.toString('base64'),
      display: {
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.size.width,
        height: display.size.height,
        scaleFactor: display.scaleFactor
      },
      capturedAt: now
    };
    captureCache = { at: now, payload };
    return payload;
  } catch (err) {
    console.warn('[capture] 桌面采样失败', err.message);
    return null;
  }
}

// ---------------- 图标提取 ----------------
const iconFileMem = new Map();

// 受保护的系统程序（任务管理器等）app.getFileIcon 会返回空，这里用 PowerShell 抽内嵌大图标兜底
function extractIconViaPS(exe) {
  return new Promise(resolve => {
    if (!exe) return resolve(null);
    let stamp = 0;
    try {
      const stat = fs.statSync(exe);
      stamp = Math.max(stat.mtimeMs, stat.ctimeMs, 0);
    } catch (err) {
      return resolve(null);
    }
    const cached = iconFileMem.get(exe);
    if (cached && cached.stamp === stamp) return resolve(cached.url);
    const script = app.isPackaged
      ? path.join(process.resourcesPath, 'icon-extract.ps1')
      : path.join(__dirname, 'icon-extract.ps1');
    if (!fs.existsSync(script)) return resolve(null);
    // 临时文件名必须按完整路径哈希，不能只取前 20 个十六进制字符：
    // 同一个用户目录下的快捷方式前缀完全相同，会互相覆盖导致图标串号。
    const out = path.join(app.getPath('temp'), 'dockicon-' + crypto.createHash('sha1').update(exe).digest('hex') + '.png');
    try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch (err) {}
    execFile(MEDIA_PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, exe, out], { windowsHide: true, timeout: 10000 }, () => {
      try {
        const img = nativeImage.createFromPath(out);
        if (img && !img.isEmpty()) {
          const url = img.resize({ width: 128, height: 128 }).toDataURL();
          iconFileMem.set(exe, { url, stamp });
          try { fs.unlinkSync(out); } catch (err) {}
          return resolve(url);
        }
      } catch (err) { /* 忽略 */ }
      return resolve(null);
    });
  });
}

async function extractIcon(filePath) {
  if (!filePath) return null;
  const ext = path.extname(filePath).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.ico', '.webp', '.svg'].includes(ext)) {
    const img = nativeImageSafe(filePath);
    if (img && !img.isEmpty()) return img.resize({ width: 128, height: 128 }).toDataURL();
  }
  // exe 优先走 PowerShell 抽 256px 大图标：app.getFileIcon 只给 32px，
  // 任务管理器这类浅色小图标缩放到 Dock 尺寸后几乎看不见
  if (/\.(exe|lnk)$/i.test(filePath)) {
    const url = await extractIconViaPS(filePath);
    if (url) return url;
  }
  try {
    const img = await app.getFileIcon(filePath, { size: 'large' });
    if (img && !img.isEmpty()) return img.toDataURL();
  } catch (err) { /* 忽略 */ }
  return null;
}

function nativeImageSafe(p) {
  try {
    const { nativeImage } = require('electron');
    return nativeImage.createFromPath(p);
  } catch (err) {
    return null;
  }
}

// ---------------- 右键菜单 ----------------

function showMenu(type, id, x, y) {
  const send = (action, extra) => {
    if (win && !win.isDestroyed()) win.webContents.send('ui:action', Object.assign({ action, id }, extra || {}));
  };

  let template = [];
  if (type === 'icon') {
    const item = cfg.apps.find(it => it.id === id);
    const isTrash = id === 'trash' || (item && item.path === 'shell:RecycleBinFolder');
    if (isTrash) {
      template = [
        { label: '打开回收站', click: () => launchItem(item) },
        { label: '清空回收站', click: () => send('empty-trash') },
        { type: 'separator' },
        { label: '从 Dock 移除', click: () => send('remove') }
      ];
    } else {
      template = [
        { label: '打开', click: () => launchItem(item) },
        {
          label: '在资源管理器中显示',
          enabled: !!item && fs.existsSync(expandEnv(item.path || '')),
          click: () => {
            if (item) shell.showItemInFolder(expandEnv(item.path));
          }
        },
        { label: '重命名', click: () => send('rename') },
        { type: 'separator' },
        { label: '从 Dock 移除', click: () => send('remove') }
      ];
    }
  } else {
    template = [
      { label: '打开设置', click: openSettingsWindow },
      { type: 'separator' },
      { label: '打开配置文件', click: () => shell.openPath(cfgPath) },
      {
        label: '自动隐藏 Dock',
        type: 'checkbox',
        checked: !!cfg.dock.autoHide,
        click: () => send('toggle-autohide')
      },
      { label: '重新载入配置', click: () => { loadConfig(); relayout(); } },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ];
  }

  Menu.buildFromTemplate(template).popup({ window: win, x: Math.round(x), y: Math.round(y) });
}

// ---------------- 鼠标穿透 ----------------
// Windows 下 ignoreMouseEvents 开启后渲染层收不到指针事件，
// 所以由主进程定时读取光标位置，命中交互区域时才关闭穿透。

let hitRects = [];
let ignoreNow = true;
let hitTimer = null;

function applyHitState() {
  if (!win || win.isDestroyed()) return;
  const point = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const lx = point.x - b.x;
  const ly = point.y - b.y;
  let inside = false;
  for (const r of hitRects) {
    if (lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h) { inside = true; break; }
  }
  const wantIgnore = !inside;
  if (wantIgnore !== ignoreNow) {
    ignoreNow = wantIgnore;
    win.setIgnoreMouseEvents(wantIgnore, { forward: true });
    // 光标进出 Dock 时都把位置告诉渲染层：
    //  - 进入：渲染层还没收到 mousemove，直接送出位置才会有放大和标签
    //  - 离开：Dock 变鼠标穿透后 DOM 收不到 pointerleave，指针状态会一直停在
    //    最后一次“在 Dock 上”，那颗图标就永久保持放大、空闲动画循环也停不下来
    if (win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('cursor:at', { x: lx, y: ly, out: wantIgnore });
    }
  }
}

// ---------------- IPC ----------------

function wireIPC() {
  ipcMain.handle('config:get', () => ({ config: cfg, configPath: cfgPath }));
  ipcMain.handle('config:save', (e, next) => ({ config: saveConfig(next), configPath: cfgPath }));
  ipcMain.handle('config:preview', (e, next) => ({ config: previewConfig(next), configPath: cfgPath }));
  ipcMain.handle('config:open', () => shell.openPath(cfgPath));
  ipcMain.handle('config:reload', () => {
    previewDirty = false;
    loadConfig();
    relayout();
    return { config: cfg, configPath: cfgPath };
  });

  ipcMain.handle('app:launch', (e, id) => launchItem(cfg.apps.find(it => it.id === id)));
  ipcMain.handle('app:choose', async () => {
    const result = await dialog.showOpenDialog(settingsWin || win, {
      title: '选择要添加到 Dock 的软件',
      properties: ['openFile'],
      filters: [
        { name: '应用程序', extensions: ['exe', 'lnk', 'url'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    return {
      name: path.basename(filePath, path.extname(filePath)),
      path: filePath,
      icon: (await extractIcon(filePath)) || ''
    };
  });
  ipcMain.handle('icon:choose', async () => {
    const result = await dialog.showOpenDialog(settingsWin || win, {
      title: '选择图标图片',
      properties: ['openFile'],
      filters: [{ name: '图标图片', extensions: ['png', 'ico', 'svg', 'jpg', 'jpeg', 'webp'] }]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    const ext = path.extname(filePath).toLowerCase();
    const mime = {
      '.png': 'image/png',
      '.ico': 'image/x-icon',
      '.svg': 'image/svg+xml',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp'
    }[ext] || 'image/png';
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > 3 * 1024 * 1024) return { error: '图标文件超过 3 MB' };
      const buffer = fs.readFileSync(filePath);
      return { icon: `data:${mime};base64,${buffer.toString('base64')}`, name: path.basename(filePath) };
    } catch (err) {
      return { error: err.message };
    }
  });
  ipcMain.handle('settings:open', () => {
    openSettingsWindow();
    return { ok: true };
  });
  ipcMain.handle('apps:running', async () => {
    runningPids.forEach((pid, id) => {
      if (!isAlive(pid)) runningPids.delete(id);
    });
    const names = await listProcessNames();
    const ids = [];
    cfg.apps.forEach(item => {
      if (item.type === 'separator') return;
      if (runningPids.has(item.id)) { ids.push(item.id); return; }
      const proc = processNameOf(item);
      if (proc && names.has(proc)) ids.push(item.id);
    });
    return ids;
  });

  ipcMain.handle('desktop:capture', () => captureDesktop());

  ipcMain.handle('window:info', (e) => {
    const target = (e && e.sender && BrowserWindow.fromWebContents(e.sender)) || win;
    const bounds = target && !target.isDestroyed() ? target.getBounds() : win.getBounds();
    const display = screen.getDisplayMatching(bounds);
    return {
      bounds,
      display: {
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.size.width,
        height: display.size.height,
        scaleFactor: display.scaleFactor
      },
      dpr: display.scaleFactor
    };
  });

  ipcMain.handle('window:mouse-through', (e, ignore) => {
    if (!win || win.isDestroyed()) return false;
    ignoreNow = !!ignore;
    win.setIgnoreMouseEvents(!!ignore, { forward: true });
    return true;
  });

  ipcMain.handle('window:hit-rects', (e, rects) => {
    hitRects = Array.isArray(rects) ? rects : [];
    applyHitState();
    return true;
  });

  ipcMain.handle('window:menu', (e, payload) => {
    showMenu(payload.type, payload.id, payload.x, payload.y);
    return true;
  });

  // ---- 右侧系统状态区：真实状态采集 + 快捷面板 ----
  function fallbackStatus() {
    return {
      wifi: { connected: false, ssid: '', signal: 0 },
      battery: null,
      radio: { wifi: 'Unknown' },
      power: 'normal',
      ime: 'zh',
      brightness: null,
      volume: { level: volLevel, muted: false },
      // 这台机器有没有对应硬件：探测进程会覆盖，读不到时先按“有”处理
      caps: { battery: true, brightness: true, wifi: true, ime: true }
    };
  }
  let statusCache = { at: 0, data: null };
  let statusWatch = null;
  let statusWatchReady = false;

  // 常驻状态进程：每 tick 输出一行 JSON，主进程解析后主动推给 Dock 和快捷面板，
  // 只有内容真的变了才推，避免每秒都让两个窗口重绘一遍（这是之前卡的根源之一）
  let lastBroadcastKey = '';
  function broadcastStatus(data) {
    const payload = withVolume(data);
    let key = '';
    try {
      key = JSON.stringify([
        payload.wifi, payload.battery, payload.radio, payload.power,
        payload.brightness, payload.volume, payload.caps
      ]);
    } catch (err) { key = ''; }
    if (key && key === lastBroadcastKey) return;
    lastBroadcastKey = key;
    const targets = [win, quickWin];
    for (const w of targets) {
      if (w && !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed()) {
        try { w.webContents.send('status:update', payload); } catch (err) {}
      }
    }
  }
  function startStatusWatch() {
    if (statusWatch) return;
    const script = helperScript('status-watch.ps1');
    if (!fs.existsSync(script)) return;
    try {
      statusWatch = spawn(MEDIA_PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-SelfPid', String(process.pid), '-IntervalMs', '1000'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      statusWatchReady = false;
      statusWatch.stdout.setEncoding('utf8');
      statusWatch.stdout.on('data', chunk => {
        for (const line of String(chunk).split('\n')) {
          const text = line.trim();
          if (!text || text[0] !== '{') continue;
          try {
            const prevBright = statusCache.data ? statusCache.data.brightness : null;
            const data = Object.assign(fallbackStatus(), JSON.parse(text));
            // watcher 不再每拍读亮度（由常驻控制进程回读），这里保留上一拍的亮度值
            if (typeof data.brightness !== 'number' && typeof prevBright === 'number') data.brightness = prevBright;
            statusCache = { at: Date.now(), data };
            statusWatchReady = true;
            broadcastStatus(data);
          } catch (err) { /* 半行或坏行直接丢掉 */ }
        }
      });
      statusWatch.on('exit', () => {
        statusWatch = null;
        statusWatchProcess = null;
        statusWatchReady = false;
        // 进程异常退出时 3 秒后重启，保证状态一直在同步
        setTimeout(() => { if (!statusWatch) startStatusWatch(); }, 3000);
      });
      statusWatchProcess = statusWatch;
    } catch (err) {
      statusWatch = null;
    }
  }
  function stopStatusWatch() {
    const w = statusWatch;
    statusWatch = null;
    statusWatchProcess = null;
    statusWatchReady = false;
    if (w) { try { w.kill(); } catch (err) {} }
  }
  // 启动后由 wireIPC 拉到常驻状态进程；这里交给调用方在窗口就绪后触发
  setTimeout(() => {
    try { startStatusWatch(); } catch (err) {}
    try { startStatusCtl(); } catch (err) {}
    // 先把真实音量灌进缓存，面板一打开就是系统当前值
    ctlCmd('get').then(res => {
      if (res && res.volume) {
        volLevel = res.volume.level;
        volMuted = !!res.volume.muted;
        if (statusCache.data) broadcastStatus(statusCache.data);
      }
    }).catch(() => {});
  }, 0);

  // ---- 亮度 / 音量：常驻控制进程（一次启动，之后每条命令只写 stdin，毫秒级生效）----
  function startStatusCtl() {
    if (ctlProc && !ctlProc.killed) return;
    const script = helperScript('status-ctl.ps1');
    if (!fs.existsSync(script)) return;
    try {
      ctlProc = spawn(MEDIA_PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore']
      });
      ctlProcess = ctlProc;
      ctlProc.stdout.setEncoding('utf8');
      let buf = '';
      ctlProc.stdout.on('data', chunk => {
        buf += chunk;
        const parts = buf.split('\n');
        buf = parts.pop();
        for (const line of parts) {
          const text = line.trim();
          if (!text || text[0] !== '{') continue;
          try {
            const res = JSON.parse(text);
            if (!res || !res.id) continue;
            const waiter = ctlWaiters.get(res.id);
            if (waiter) { ctlWaiters.delete(res.id); waiter(res); }
          } catch (err) { /* 半行丢弃 */ }
        }
      });
      ctlProc.on('exit', () => {
        ctlProc = null;
        ctlProcess = null;
        for (const [, waiter] of ctlWaiters) waiter(null);
        ctlWaiters.clear();
        setTimeout(() => { if (!ctlProc) startStatusCtl(); }, 3000);
      });
      // 每秒从系统真实读一次音量和亮度：用户按键盘音量键 / 系统滑杆改的也能立刻跟上
      if (!ctlTickTimer) {
        ctlTickTimer = setInterval(() => {
          if (!ctlProc) return;
          ctlCmd('get').then(res => {
            if (!res) return;
            let changed = false;
            if (res.volume) {
              if (res.volume.level !== volLevel) { volLevel = res.volume.level; changed = true; }
              if (!!res.volume.muted !== volMuted) { volMuted = !!res.volume.muted; changed = true; }
            }
            if (typeof res.brightness === 'number' && statusCache.data
                && statusCache.data.brightness !== res.brightness) {
              statusCache.data.brightness = res.brightness;
              changed = true;
            }
            // 只有真的变了才推，避免每秒白重渲染一次
            if (changed && statusCache.data) { statusCache.at = Date.now(); broadcastStatus(statusCache.data); }
          }).catch(() => {});
        }, 1000);
      }
    } catch (err) { ctlProc = null; }
  }

  // 一条命令 = 一行 JSON；返回 null 表示常驻进程没起来（调用方自己回退）
  function ctlCmd(cmd, v) {
    return new Promise(resolve => {
      startStatusCtl();
      if (!ctlProc) return resolve(null);
      const id = ++ctlSeq;
      let done = false;
      const finish = res => { if (done) return; done = true; ctlWaiters.delete(id); resolve(res); };
      ctlWaiters.set(id, finish);
      try { ctlProc.stdin.write(JSON.stringify({ id, cmd, v }) + '\n'); } catch (err) { finish(null); }
      setTimeout(() => finish(null), 2500);
    });
  }

  // ---- 中/英 切换：常驻轻量进程，点一下立刻打一个真实 Shift，不用每次起 powershell ----
  let imeHelper = null;
  let imeReply = null;

  function startImeHelper() {
    if (imeHelper && !imeHelper.killed) return;
    const script = helperScript('ime-listen.ps1');
    if (!fs.existsSync(script)) return;
    try {
      imeHelper = spawn(MEDIA_PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-SelfPid', String(process.pid)], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore']
      });
      imeHelper.stdout.setEncoding('utf8');
      imeHelper.stdout.on('data', chunk => {
        for (const line of String(chunk).split('\n')) {
          const text = line.trim();
          if (!text) continue;
          const cb = imeReply;
          imeReply = null;
          if (cb) cb(text);
        }
      });
      imeHelper.on('exit', code => {
        imeHelper = null;
        imeHelperProcess = null;
        const cb = imeReply;
        imeReply = null;
        if (cb) cb('fail');
      });
      imeHelperProcess = imeHelper;
    } catch (err) {
      imeHelper = null;
    }
  }

  function tapIme() {
    return new Promise(resolve => {
      startImeHelper();
      if (!imeHelper) return resolve({ ok: false });
      let done = false;
      const finish = reply => {
        if (done) return;
        done = true;
        imeReply = null;
        const text = String(reply || '');
        if (text.indexOf('ok') !== 0) return resolve({ ok: false });
        resolve({ ok: true, ime: text.indexOf('en') > 0 ? 'en' : 'zh' });
      };
      imeReply = finish;
      try { imeHelper.stdin.write('ime\n'); } catch (err) { finish('fail'); }
      setTimeout(() => finish('fail'), 1200);
    });
  }

  function readSystemStatus(force) {
    return new Promise(resolve => {
      const now = Date.now();
      // 常驻进程刚刚推过帧：直接用，保证和系统一致（force 时跳过缓存，面板刚打开时用）
      if (!force && statusWatchReady && statusCache.data && now - statusCache.at < 1500) return resolve(withVolume(statusCache.data));
      if (!force && statusCache.data && now - statusCache.at < 1500) return resolve(withVolume(statusCache.data));
      const script = helperScript('status-bridge.ps1');
      if (!fs.existsSync(script)) { statusCache = { at: now, data: fallbackStatus() }; return resolve(withVolume(statusCache.data)); }
      execFile(MEDIA_PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-SelfPid', String(process.pid)], { windowsHide: true, timeout: 6000 }, (err, stdout) => {
        let data = fallbackStatus();
        try {
          if (stdout && String(stdout).trim()) {
            const parsed = JSON.parse(String(stdout).trim());
            data = Object.assign(data, parsed);
          }
        } catch (parseErr) { /* 保留兜底 */ }
        statusCache = { at: Date.now(), data };
        resolve(withVolume(data));
      });
    });
  }
  function withVolume(data) {
    return Object.assign({}, data, { volume: { level: volLevel, muted: volMuted } });
  }
  function runStatusAction(kind) {
    try {
      if (kind === 'wifi') {
        shell.openExternal('ms-settings:network-wifi').catch(() => {});
      } else if (kind === 'airplane') {
        shell.openExternal('ms-settings:network-airplanemode').catch(() => {});
      } else if (kind === 'saver') {
        shell.openExternal('ms-settings:batterysaver').catch(() => {});
      } else if (kind === 'access') {
        shell.openExternal('ms-settings:easeofaccess').catch(() => {});
      } else if (kind === 'project') {
        shell.openExternal('ms-settings:display').catch(() => {});
      } else if (kind === 'settings' || kind === 'ime') {
        openSettingsWindow();
      }
    } catch (err) { /* 忽略打开失败 */ }
  }
  ipcMain.handle('status:get', (e, force) => readSystemStatus(!!force));
  ipcMain.handle('status:action', (e, kind) => { runStatusAction(String(kind || '')); return { ok: true }; });

  // 点“中/英”：交给常驻进程——它把前台交还给你自己的窗口再打一个真实 Shift，
  // 并把切换后的中/英状态回传，Dock 上的字直接跟着真实结果走
  ipcMain.handle('status:ime', async () => {
    let res = await tapIme();
    if (!res || !res.ok) {
      // 常驻进程没起来时退回一次性脚本，保证功能不丢
      const script = helperScript('status-act.ps1');
      if (fs.existsSync(script)) {
        const ok = await new Promise(resolve => {
          execFile(MEDIA_PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', 'ime', '-SelfPid', String(process.pid)], { windowsHide: true, timeout: 6000 }, (err, stdout) => {
            resolve(!err && String(stdout || '').indexOf('ime-ok') >= 0);
          });
        });
        if (ok) res = { ok: true };
      }
    }
    return res || { ok: false };
  });

  // 亮度：优先走常驻进程（毫秒级），拿不到结果再回退一次性脚本
  ipcMain.handle('status:brightness', async (e, value) => {
    const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    const res = await ctlCmd('brightness', v);
    if (!res || !res.ok) {
      const script = helperScript('status-act.ps1');
      if (fs.existsSync(script)) {
        execFile(MEDIA_PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', 'brightness', '-Value', String(v)], { windowsHide: true, timeout: 5000 }, () => {});
      }
    }
    // 立刻把新亮度写给面板和 Dock，不等下一个采样周期
    if (statusCache.data) {
      statusCache.data = Object.assign({}, statusCache.data, { brightness: v });
      statusCache.at = Date.now();
      broadcastStatus(statusCache.data);
    }
    return { ok: true, value: v };
  });

  // 音量：常驻进程直接写 Core Audio（不再靠敲音量键，拖动时即时跟手）
  ipcMain.handle('status:volume', async (e, payload) => {
    const p = payload || {};
    if (p.mute !== undefined) {
      const res = await ctlCmd('mute', null);
      const level = res && res.volume ? res.volume.level : volLevel;
      const muted = res && res.volume ? res.volume.muted : !volMuted;
      if (typeof level === 'number') volLevel = level;
      volMuted = !!muted;
      if (statusCache.data) broadcastStatus(statusCache.data);
      return { ok: true, level: volLevel, muted: volMuted };
    }
    const target = Math.max(0, Math.min(100, Math.round(Number(p.value) || 0)));
    const res = await ctlCmd('volume', target);
    if (!res || !res.volume) {
      // 回退：老办法 —— 敲音量键做 2% 步进
      const base = volLevel === null ? 50 : volLevel;
      const steps = Math.round((target - base) / 2);
      if (steps !== 0) {
        const script = helperScript('status-act.ps1');
        if (fs.existsSync(script)) {
          execFile(MEDIA_PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', 'volume', '-Value', String(steps)], { windowsHide: true, timeout: 8000 }, () => {});
        }
        volLevel = Math.max(0, Math.min(100, base + steps * 2));
      }
      if (volLevel > 0) volMuted = false;
    } else {
      volLevel = res.volume.level;
      volMuted = !!res.volume.muted;
    }
    if (statusCache.data) broadcastStatus(statusCache.data);
    return { ok: true, level: volLevel, muted: volMuted };
  });

  // 二级小窗的数据源：每次点开都实时取，不做缓存
  function runQuickAct(action, value) {
    return new Promise(resolve => {
      const script = helperScript('quick-act.ps1');
      if (!fs.existsSync(script)) { resolve({ ok: false, message: 'quick-act.ps1 missing' }); return; }
      execFile(MEDIA_PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action, '-Value', String(value || '')],
        { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
          const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
          const last = lines.length ? lines[lines.length - 1] : '';
          try { resolve(JSON.parse(last)); } catch (e) { resolve({ ok: false, message: String(err && err.message || last || 'error') }); }
        });
    });
  }

  ipcMain.handle('status:panel', (e, open) => toggleQuickPanel(open));

  // 快捷面板的二级小窗数据：Wi-Fi 列表 / 电源方案 / 显示模式…
  ipcMain.handle('quick:run', async (e, action, value) => {
    quickLastActAt = Date.now();
    return runQuickAct(String(action || 'ping'), value == null ? '' : String(value));
  });

  ipcMain.handle('media:get', () => mediaState);
  ipcMain.handle('media:control', async (e, action) => runMediaControl(String(action || 'playpause')));
  ipcMain.handle('media:lyrics', async (e, payload) => {
    const p = payload || {};
    try {
      const res = await getLyrics(String(p.title || ''), String(p.artist || ''));
      return { ok: true, lines: res.lines, source: res.source, cover: res.cover || '' };
    } catch (err) {
      return { ok: false, lines: [], source: '', error: err.message };
    }
  });
  // 正在播放这首歌的封面：一次网易云搜索即可拿到 picUrl，比等歌词快得多
  ipcMain.handle('media:cover', async (e, payload) => {
    const p = payload || {};
    const title = String(p.title || '').trim();
    if (!title) return { ok: true, cover: '', song: '' };
    try {
      const res = await fetchSongCover(title, String(p.artist || ''), Number(p.duration) || 0);
      return { ok: true, cover: res.cover || '', song: res.song || '', pending: !!res.pending };
    } catch (err) {
      return { ok: false, cover: '', song: '', error: err.message };
    }
  });

  ipcMain.handle('windows:minimized', () => ({ ok: true, items: minList }));
  ipcMain.handle('window:restore', async (e, h) => {
    const res = await restoreWindow(h);
    setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.send('windows:minimized', minList); }, 400);
    return res;
  });
  ipcMain.handle('window:quit', () => { app.quit(); });
  ipcMain.handle('icon:extract', (e, p) => {
    const raw = String(p || '');
    return raw.startsWith('shell:') ? null : extractIcon(expandEnv(raw));
  });

  ipcMain.handle('app:empty-trash', async () => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['取消', '清空'],
      defaultId: 0,
      cancelId: 0,
      title: '清空回收站',
      message: '确定要清空回收站吗？',
      detail: '此操作会永久删除回收站里的所有文件。'
    });
    if (response === 1) {
      try {
        const child = spawn('powershell.exe', ['-NoProfile', '-Command', 'Clear-RecycleBin -Force -ErrorAction SilentlyContinue'], { detached: true, stdio: 'ignore' });
        child.unref();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    return { ok: false, canceled: true };
  });
}

// ---------------- 预览/自检模式（仅开发用：--preview） ----------------

async function saveShot(name) {
  const img = await win.capturePage();
  const size = img.getSize();
  // capturePage 位图是预乘 alpha 的，直接 toPNG 会让半透明玻璃在图片里显得发灰；
  // 这里做一次反预乘，PNG 才是「真实颜色 + 透明度」，看起来和屏幕一致。
  const shot = img.toBitmap(); // BGRA, premultiplied
  const out = Buffer.alloc(size.width * size.height * 4);
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      const i = (y * size.width + x) * 4;
      const a = shot[i + 3];
      if (a === 0) continue;
      out[i] = Math.min(255, Math.round(shot[i] * 255 / a));
      out[i + 1] = Math.min(255, Math.round(shot[i + 1] * 255 / a));
      out[i + 2] = Math.min(255, Math.round(shot[i + 2] * 255 / a));
      out[i + 3] = a;
    }
  }
  const merged = nativeImage.createFromBitmap(out, { width: size.width, height: size.height });
  fs.writeFileSync(path.join(app.getAppPath(), name), merged.toPNG());
}

async function runPreview() {
  // WinForms 的 Cursor.Position 接收 DIP 坐标，实测 1:1，最稳
  const moveCursor = (xDip, yDip) => {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(xDip)},${Math.round(yDip)})`;
    return new Promise(resolve => {
      execFile('pwsh', ['-NoProfile', '-NonInteractive', '-Command', ps], (err, so, se) => {
        if (err || se) console.log('[preview] cursor ps', err ? err.message : '', String(se || '').slice(0, 160));
        resolve();
      });
    });
  };

  setTimeout(async () => {
    try {
      console.log('[preview] bounds', JSON.stringify(win.getBounds()), 'apps', cfg.apps.length);
      const frame = await captureDesktop();
      console.log('[preview] capture', frame ? frame.dataUrl.length + ' bytes' : 'null');
      if (frame && frame.dataUrl) {
        const b64 = frame.dataUrl.replace(/^data:image\/[a-z]+;base64,/, '');
        fs.writeFileSync(path.join(app.getAppPath(), 'desktop-sample.jpg'), Buffer.from(b64, 'base64'));
      }
      const info = await win.webContents.executeJavaScript(`(() => {
        const dock = document.querySelector('.dock');
        const icons = Array.from(document.querySelectorAll('.dock-icon')).map(el => {
          const r = el.getBoundingClientRect();
          const img = el.querySelector('img');
          return { w: Math.round(r.width), h: Math.round(r.height), src: img ? img.getAttribute('src') : 'none' };
        });
        const glassVideo = document.querySelector('.live-screen');
        const dr = dock ? dock.getBoundingClientRect() : null;
        return {
          inner: [innerWidth, innerHeight],
          dock: dr ? [Math.round(dr.x), Math.round(dr.y), Math.round(dr.width), Math.round(dr.height)] : null,
          icons,
          live: glassVideo ? {
            readyState: glassVideo.readyState,
            paused: glassVideo.paused,
            frames: Number(glassVideo.dataset.liveFrames) || 0,
            width: glassVideo.videoWidth,
            height: glassVideo.videoHeight
          } : null
        };
      })()`);
      console.log('[preview] dom', JSON.stringify(info));
      await saveShot('preview.png');
      console.log('[preview] 静态截图完成');
      try {
        const b = win.getBounds();
        const d = screen.getDisplayMatching(b);
        const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: d.bounds.width, height: d.bounds.height } });
        if (srcs && srcs[0]) {
          fs.writeFileSync(path.join(app.getAppPath(), 'screen-check.png'), srcs[0].thumbnail.toPNG());
          console.log('[preview] screen-check saved', JSON.stringify(srcs[0].thumbnail.getSize()));
        }
      } catch (err) { console.log('[preview] screen-check failed', err.message); }

      // 用真实光标定位到第 3 个图标上，这样拿到的是真实悬停态（合成事件的坐标并不可靠）
      // 带 --preview-last 时改为悬停最右侧图标，用于检查右边缘观感
      const lastIcon = process.argv.includes('--preview-last');
      const target = await win.webContents.executeJavaScript(`(() => {
        const list = Array.from(document.querySelectorAll('.dock-icon'));
        const pick = list[${lastIcon ? 'list.length - 1' : '2'}] || list[0];
        if (!pick) return null;
        const r = pick.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      const bounds = win.getBounds();
      const restore = screen.getCursorScreenPoint();
      console.log('[preview] target dip', JSON.stringify({ x: bounds.x + target.x, y: bounds.y + target.y }));
      await moveCursor(bounds.x + target.x, bounds.y + target.y);
      console.log('[preview] cursor now', JSON.stringify(screen.getCursorScreenPoint()));
      await new Promise(r => setTimeout(r, 1400));

      const tipInfo = await win.webContents.executeJavaScript(`(() => {
        const tip = document.querySelector('.glass-tooltip');
        const icons = Array.from(document.querySelectorAll('.dock-icon')).map(el => {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        });
        const dock = document.querySelector('.dock');
        const dr = dock ? dock.getBoundingClientRect() : null;
        return {
          found: !!tip,
          text: tip ? tip.textContent.trim() : '',
          dock: dr ? [Math.round(dr.x), Math.round(dr.width)] : null,
          icons
        };
      })()`);
      console.log('[preview] tip', JSON.stringify(tipInfo));
      await saveShot('preview-hover.png');
      console.log('[preview] 悬停截图完成');
      await moveCursor(restore.x, restore.y);
    } catch (err) {
      console.error('[preview] 失败', err);
    }
    app.quit();
  }, Number(process.env.DOCK_PREVIEW_DELAY || 3200));
}

// ---------------- 媒体（Windows SMTC + 本地歌词） ----------------

const MEDIA_PS = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** 打包后 helper 脚本放在 resources 根目录，开发态仍在 electron 目录。 */
function helperScript(name) {
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(__dirname, name);
}

let statusWatchProcess = null;
let imeHelperProcess = null;
let statusWatchReady = false;
// 亮度 / 音量常驻控制进程
let ctlProc = null;
let ctlProcess = null;
let ctlSeq = 0;
const ctlWaiters = new Map();
let ctlTickTimer = null;
let mediaBridge = null;
let mediaState = { ok: true, empty: true };
let lyricsCache = { key: '', lines: [], source: '', cover: '' };
const coverMem = new Map();
let mediaQuitting = false;
let mediaOutBuffer = '';
let mediaCover = '';
let mediaCoverKey = '';

function startMediaBridge() {
  const script = helperScript('media-bridge.ps1');
  if (!fs.existsSync(script) || mediaBridge) return;
  try {
    mediaBridge = spawn(MEDIA_PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    mediaBridge.stdout.setEncoding('utf8');
    mediaBridge.stdout.on('data', chunk => {
      mediaOutBuffer += chunk;
      if (mediaOutBuffer.length > 12 * 1024 * 1024) mediaOutBuffer = '';
      let newline = -1;
      while ((newline = mediaOutBuffer.indexOf('\n')) >= 0) {
        const t = mediaOutBuffer.slice(0, newline).trim();
        mediaOutBuffer = mediaOutBuffer.slice(newline + 1);
        if (!t.startsWith('{')) continue;
        try {
          const obj = JSON.parse(t);
          if (!obj || obj.ok !== true) continue;
          const coverKey = [obj.appId, obj.title, obj.artist, obj.album].map(v => String(v || '')).join('\n');
          if (obj.empty) {
            mediaCover = '';
            mediaCoverKey = '';
          } else if (Object.prototype.hasOwnProperty.call(obj, 'cover')) {
            mediaCover = String(obj.cover || '');
            mediaCoverKey = coverKey;
          } else if (coverKey !== mediaCoverKey) {
            mediaCover = '';
            mediaCoverKey = coverKey;
          }
          mediaState = { ...obj, cover: mediaCover };
          if (!obj.empty) warmLyrics(obj.title || '', obj.artist || '');
        } catch (err) { /* 忽略坏行 */ }
      }
    });
    mediaBridge.on('exit', () => {
      mediaBridge = null;
      mediaOutBuffer = '';
      if (!mediaQuitting) setTimeout(() => { if (!mediaQuitting) startMediaBridge(); }, 3000);
    });
  } catch (err) {
    mediaBridge = null;
  }
}

function stopMediaBridge() {
  mediaQuitting = true;
  try { mediaBridge && mediaBridge.kill(); } catch (err) {}
  mediaBridge = null;
}

function runMediaControl(action) {
  return new Promise(resolve => {
    const script = helperScript('media-control.ps1');
    if (!fs.existsSync(script)) return resolve({ ok: false, error: 'missing-script' });
    execFile(MEDIA_PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, action], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message });
      const m = String(stdout).match(/\{.*\}/);
      if (!m) return resolve({ ok: true });
      try { return resolve(JSON.parse(m[0])); } catch (e2) { return resolve({ ok: true }); }
    });
  });
}

// ---------------- 最小化窗口（Windows IsIconic 轮询） ----------------

let minBridge = null;
let minQuitting = false;
let minList = [];        // [{ h, t, e }]
let minLastKey = '';
const restoreGuard = new Map();   // hwnd -> 还原时间，用来抑制“闪一下”

function minimizedWidth() {
  const n = minList.length;
  if (!n) return 0;
  const d = cfg.dock;
  return n * (Number(d.iconSize) || 56) + (n - 1) * (Number(d.gap) || 8);
}

/** BrowserWindow 的 Win32 句柄（十进制），交给 PS 精确操作这一个窗口 */
function nativeHwnd(target) {
  try {
    if (!target || target.isDestroyed()) return 0;
    const buf = target.getNativeWindowHandle();
    if (!buf || !buf.length) return 0;
    const value = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
    return Number(value);
  } catch (err) {
    return 0;
  }
}

function startMinBridge() {
  const script = helperScript('win-bridge.ps1');
  if (!fs.existsSync(script) || minBridge) return;
  try {
    minBridge = spawn(MEDIA_PS, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-DockPid', String(process.pid),
      '-DockHwnd', String(nativeHwnd(win)),
      '-ZoneFile', dockZonePath()
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    minBridge.stdout.on('data', chunk => {
      String(chunk).split(/\r?\n/).forEach(line => {
        const t = line.trim();
        if (!t.startsWith('{')) return;
        let obj = null;
        try { obj = JSON.parse(t); } catch (err) { return; }
        if (!obj || obj.ok !== true) return;
        // z 字段非空说明守护进程已经接管 Dock 层级
        if (typeof obj.z === 'string' && obj.z) zBridgeActive = true;
        // 不再因为前台窗口全屏就收起 Dock：任何软件都不能盖住 Dock
        const settingsHwnd = nativeHwnd(settingsWin);
        const settingsIcon = winDockIconDataUrl();
        let items = (Array.isArray(obj.items) ? obj.items : []).map(it => ({
          h: Number(it.h) || 0,
          t: String(it.t || ''),
          e: String(it.e || ''),
          icon: settingsHwnd && Number(it.h) === settingsHwnd ? settingsIcon : ''
        })).filter(it => it.h);
        // 刚被我们还原的窗口，在它真正取消最小化之前还会被枚举出来，这里按时间屏蔽掉，
        // 否则图标会在 Dock 里“闪一下再消失”
        const now = Date.now();
        items = items.filter(it => {
          const at = restoreGuard.get(it.h);
          return !(at && now - at < 2500);
        });
        for (const [h, at] of restoreGuard) {
          if (now - at > 8000) restoreGuard.delete(h);
        }
        minList = items;
        const key = items.map(it => it.h).join(',');
        if (key !== minLastKey) {
          minLastKey = key;
          relayout();
          if (win && !win.isDestroyed()) win.webContents.send('windows:minimized', items);
        }
      });
    });
    minBridge.on('exit', () => {
      minBridge = null;
      if (!minQuitting) setTimeout(() => { if (!minQuitting) startMinBridge(); }, 3000);
    });
  } catch (err) {
    minBridge = null;
  }
}

function stopMinBridge() {
  minQuitting = true;
  try { minBridge && minBridge.kill(); } catch (err) {}
  minBridge = null;
}

function restoreWindow(hwnd) {
  restoreGuard.set(Number(hwnd) || 0, Date.now());
  // 立刻从列表里摘掉并通知渲染层，Dock 不用等下一次轮询才收回
  const h = Number(hwnd) || 0;
  minList = minList.filter(it => it.h !== h);
  minLastKey = minList.map(it => it.h).join(',');
  relayout();
  if (win && !win.isDestroyed()) win.webContents.send('windows:minimized', minList);
  return new Promise(resolve => {
    const script = helperScript('win-restore.ps1');
    if (!fs.existsSync(script)) return resolve({ ok: false, error: 'missing-script' });
    execFile(MEDIA_PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, String(hwnd)], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message });
      const m = String(stdout).match(/\{.*\}/);
      if (!m) return resolve({ ok: true });
      try { return resolve(JSON.parse(m[0])); } catch (e2) { return resolve({ ok: true }); }
    });
  });
}

// ---------- 歌词：先找本地同名 .lrc，找不到再问网易云 ----------

function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[.,'"!?()（）《》\-_]/g, '');
}

function walkLrc(dir, depth, out) {
  if (depth > 3 || !out) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/^(node_modules|AppData|\$Recycle)/.test(e.name)) continue;
      walkLrc(full, depth + 1, out);
    } else if (/\.lrc$/i.test(e.name)) {
      out.push(full);
    }
  }
}

function parseLrc(text) {
  const lines = [];
  String(text).split(/\r?\n/).forEach(raw => {
    const m = raw.match(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\](.*)$/);
    if (!m) return;
    const frac = m[3] ? Number('0.' + m[3].padEnd(3, '0').slice(0, 3)) : 0;
    const t = Number(m[1]) * 60 + Number(m[2]) + frac;
    const content = m[4].trim();
    if (!content) return;
    lines.push({ t: Math.round(t * 10) / 10, text: content });
  });
  lines.sort((a, b) => a.t - b.t);
  return lines;
}

function findLocalLyrics(title) {
  const key = normalizeName(title);
  if (!key) return null;
  const roots = [
    path.join(process.env.USERPROFILE || '', 'Music'),
    path.join(process.env.USERPROFILE || '', 'Downloads')
  ];
  const files = [];
  roots.forEach(r => walkLrc(r, 0, files));
  for (const f of files) {
    const base = normalizeName(path.basename(f, '.lrc'));
    if (base && (base.includes(key) || key.includes(base))) {
      try {
        const lines = parseLrc(fs.readFileSync(f, 'utf8'));
        if (lines.length) return { lines, source: 'local' };
      } catch (err) { /* 忽略 */ }
    }
  }
  return null;
}

function httpGetJson(url) {
  return new Promise(resolve => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Referer': 'https://music.163.com/',
        'Cookie': 'appver=2.0.2;'
      },
      timeout: 6000
    }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.headers.location) {
        res.resume();
        return httpGetJson(res.headers.location).then(resolve);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function fetchNeteaseLyrics(title, artist) {
  if (!title) return null;
  const search1 = await httpGetJson(`https://music.163.com/api/search/get/web?csrf_token=&s=${encodeURIComponent(`${title} ${artist || ''}`.trim())}&type=1&offset=0&total=true&limit=10`);
  let songs = search1 && search1.result && Array.isArray(search1.result.songs) ? search1.result.songs : [];
  if (!songs.length) {
    // 带上歌手串搜不到时，退回纯歌名再搜一次（和声版/小众版本常见）
    const search2 = await httpGetJson(`https://music.163.com/api/search/get/web?csrf_token=&s=${encodeURIComponent(title)}&type=1&offset=0&total=true&limit=10`);
    songs = search2 && search2.result && Array.isArray(search2.result.songs) ? search2.result.songs : [];
  }
  if (!songs.length) return null;

  // 在结果里挑最像原唱的一首：歌手命中 > 歌名完全一致，避免抓到翻唱
  const norm = s => String(s || '').toLowerCase().replace(/[\s\-_.·、,，()（）\[\]【】]/g, '');
  const keyTitle = norm(title);
  const keyArtist = norm(artist);
  let best = songs[0];
  let bestScore = -1;
  songs.forEach(s => {
    let score = 0;
    const names = (s.artists || []).map(a => norm(a.name));
    const sn = norm(s.name);
    // 歌名权重最高：同名原唱优先，避免「歌手命中但完全不是这首歌」
    if (keyTitle && sn === keyTitle) score += 8;
    else if (keyTitle && sn.includes(keyTitle)) score += 3;
    else if (keyTitle && (keyTitle.includes(sn) && sn.length > 1)) score += 2;
    if (keyArtist && names.some(n => n.includes(keyArtist) || keyArtist.includes(n))) score += 5;
    // 带「翻唱 / cover / 伴奏」字样的降权
    if (/翻唱|cover|伴奏|remix|dj|钢琴版|纯音乐/i.test(String(s.name || '') + (s.album ? s.album.name : ''))) score -= 3;
    if (score > bestScore) { bestScore = score; best = s; }
  });

  const id = best.id;
  // 封面走 v3 song/detail（旧 api/song/detail 已不返回 picUrl）
  let cover = await fetchCoverById(id);
  if (!cover) {
    // 兜底：只用歌名再搜一次，拿第一条结果的封面
    const s2 = await httpGetJson(`https://music.163.com/api/search/get/web?csrf_token=&s=${encodeURIComponent(title)}&type=1&offset=0&total=true&limit=5`);
    const list2 = s2 && s2.result && Array.isArray(s2.result.songs) ? s2.result.songs : [];
    for (const it of list2.slice(0, 3)) {
      cover = await fetchCoverById(it.id);
      if (cover) break;
    }
  }

  const lyric = await httpGetJson(`https://music.163.com/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`);
  const raw = lyric && lyric.lrc && lyric.lrc.lyric ? lyric.lrc.lyric : '';
  const lines = parseLrc(raw);
  return { lines, source: 'netease', cover };
}

async function fetchCoverById(id) {
  if (!id) return '';
  if (coverMem.has(id)) return coverMem.get(id);
  const detail = await httpGetJson(`https://music.163.com/api/v3/song/detail?c=${encodeURIComponent(JSON.stringify([{ id }]))}`);
  const al = detail && Array.isArray(detail.songs) && detail.songs[0] && detail.songs[0].al;
  const url = al && al.picUrl ? String(al.picUrl).replace(/^http:/, 'https:') + '?param=200y200' : '';
  coverMem.set(id, url);
  return url;
}

// ---------------- 正在播放这首歌的封面 ----------------
// 参考岛仔（xiaotang-daozai）的 cover_search：播放器自己给了缩略图就用它，
// 没给就按「歌名 + 歌手 + 时长」去网上找同一首歌的封面，宁缺毋错。
// 汽水音乐这类播放器不给 SMTC 缩略图，还会把「歌名 - 专辑/电台」整段塞进标题、
// artist 里塞「正在进行…」这种电台串，所以先把元数据洗干净再搜。
const coverInFlight = new Set();

function normSongName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[（(【\[][^)）\]】]*[)）\]】]/g, '')
    .replace(/[\s\-_.·、,，:：'"“”!！?？/\\]/g, '');
}

function songMeta(title, artist) {
  const rawTitle = String(title || '').trim();
  const rawArtist = String(artist || '').trim();
  // 「歌名 - 后续」：后续可能是专辑/电台节目，也可能是真歌手
  const split = rawTitle.match(/^(.*\S)\s+[-–—]\s+(.+)$/);
  const head = split && split[1].trim().length >= 2 ? split[1].trim() : rawTitle;
  const tail = split ? split[2].trim() : '';
  const junkArtist = !rawArtist || /^(正在进行|正在播放|未知|未知歌手|播放器|主播|电台|fm|dj)/i.test(rawArtist);
  const guests = [];
  if (!junkArtist) guests.push(rawArtist);
  if (tail.length >= 2 && normSongName(tail) !== normSongName(head)) guests.push(tail);
  return { title: head, rawTitle, guests };
}

function neteaseSearch(query, limit) {
  if (!query) return Promise.resolve([]);
  const url = `https://music.163.com/api/cloudsearch/pc?s=${encodeURIComponent(query)}&type=1&offset=0&limit=${limit || 10}`;
  return httpGetJson(url).then(data => (data && data.result && Array.isArray(data.result.songs) ? data.result.songs : []));
}

// 同一首才算：歌名一致（忽略括号版本）+ 歌手对得上 + 时长吻合（±10 秒或 3% 以内）
function pickNeteaseMatch(songs, meta, duration) {
  const kt = normSongName(meta.title);
  const secs = Number(duration) || 0;
  const versionTag = /伴奏|纯音乐|翻唱|remix|dj|live|现场|男版|女版|片段|试听|清唱/i;
  let best = null;
  let bestDiff = Infinity;
  let bestHit = false;
  for (const s of songs || []) {
    if (!s || !s.name) continue;
    if (versionTag.test(String(s.name)) && !versionTag.test(meta.rawTitle)) continue;
    if (normSongName(s.name) !== kt) continue;
    const singers = (Array.isArray(s.ar) ? s.ar : Array.isArray(s.artists) ? s.artists : [])
      .map(a => normSongName(a && a.name))
      .filter(Boolean);
    const singerName = singers.join('/');
    const artistHit = !!singerName && meta.guests.some(g => {
      const kg = normSongName(g);
      return kg && (singerName.includes(kg) || kg.includes(singerName));
    });
    const len = Number(s.dt || s.duration) ? Number(s.dt || s.duration) / 1000 : 0;
    let diff = Infinity;
    if (secs > 0 && len > 0) {
      diff = Math.abs(len - secs);
      const tol = Math.max(10, secs * 0.03);
      if (diff > tol) continue;                       // 时长差太多，肯定不是这首
    }
    if (meta.guests.length) {
      if (!artistHit) continue;                       // 有歌手信息时不认别人的版本
    } else if (secs <= 0 || len <= 0 || diff > 3) {
      continue;                                       // 没有歌手也没有可信时长时不猜
    }
    if ((artistHit && !bestHit) || (artistHit === bestHit && diff < bestDiff)) {
      best = s;
      bestDiff = diff;
      bestHit = artistHit;
    }
  }
  return best;
}

async function fetchNeteaseMatchedSong(title, artist, duration) {
  const meta = songMeta(title, artist);
  if (!meta.title) return null;
  const queries = [];
  const push = (t, a) => {
    const q = `${t || ''} ${a || ''}`.trim();
    if (q && !queries.includes(q)) queries.push(q);
  };
  meta.guests.slice(0, 2).forEach(g => push(meta.title, g));
  push(meta.title, '');
  if (meta.rawTitle !== meta.title) push(meta.rawTitle, meta.guests[0] || '');
  for (const q of queries) {
    const songs = await neteaseSearch(q, 10);
    const hit = pickNeteaseMatch(songs, meta, duration);
    if (hit) return hit;
  }
  return null;
}

function neteaseCoverUrl(song) {
  const al = song && (song.al || song.album);
  const raw = al && al.picUrl ? String(al.picUrl).replace(/^http:/, 'https:') : '';
  if (!raw) return '';
  return raw.includes('?') ? raw : `${raw}?param=300y300`;
}

// 汽水音乐自己不往系统媒体会话塞缩略图，但它把每首歌的封面存在本地媒体缓存里
// （%APPDATA%\SodaMusic\LunaCacheV2\entries.db，MessagePack 记录）。直接把它读出来，
// 拿到的封面和它界面上显示的那张完全一致，不依赖联网、不依赖歌名能不能被搜到。
const SODA_CACHE_FILE = path.join(process.env.APPDATA || '', 'SodaMusic', 'LunaCacheV2', 'entries.db');
const SODA_IMG_BASE = 'https://p3-luna.douyinpic.com/img/';
const SODA_IMG_TPL = '~tplv-b829550vbb-image.jpeg';
const SODA_IMG_MARKS = ['https://p3-luna.douyinpic.com/img/', 'https://p6-luna.douyinpic.com/img/'];
const sodaCoverMem = new Map();
let sodaBufCache = { at: 0, buf: null };

function sodaCacheBuffer() {
  const now = Date.now();
  if (sodaBufCache.buf && now - sodaBufCache.at < 4000) return sodaBufCache.buf;
  const buf = fs.readFileSync(SODA_CACHE_FILE);
  sodaBufCache = { at: now, buf };
  return buf;
}

function sodaCoverInBuffer(buf, needle, artistBuf) {
  const found = [];
  let pos = -1;
  let guard = 0;
  while (guard < 40 && (pos = buf.indexOf(needle, pos + 1)) >= 0) {
    guard += 1;
    let markPos = -1;
    for (const mk of SODA_IMG_MARKS) {
      const j = buf.indexOf(Buffer.from(mk), pos);
      if (j >= 0 && j - pos <= 900 && (markPos < 0 || j < markPos)) markPos = j;
    }
    if (markPos < 0) continue;
    const back = buf.slice(Math.max(0, markPos - 160), markPos).toString('latin1');
    const uris = back.match(/tos-cn-[A-Za-z0-9\-_/]{10,}/g);
    if (!uris) continue;
    const uri = uris[uris.length - 1];
    const after = buf.slice(markPos, Math.min(buf.length, markPos + 500));
    found.push({ uri, artistHit: !!artistBuf && artistBuf.length >= 2 && after.indexOf(artistBuf) >= 0 });
  }
  if (!found.length) return '';
  const withArtist = found.filter(f => f.artistHit);
  const pick = (withArtist.length ? withArtist : found)[0];
  return `${SODA_IMG_BASE}${pick.uri}${SODA_IMG_TPL}`;
}

function sodaLocalCover(title, artist) {
  const t = String(title || '').trim();
  if (!t) return '';
  const key = `soda:${t}|${artist || ''}`;
  if (sodaCoverMem.has(key)) return sodaCoverMem.get(key);
  let buf = null;
  try {
    buf = sodaCacheBuffer();
  } catch (err) {
    return '';
  }
  if (!buf || buf.length < 4096) return '';
  const artistBuf = artist ? Buffer.from(String(artist).trim(), 'utf8') : null;
  let cover = sodaCoverInBuffer(buf, Buffer.from(t, 'utf8'), artistBuf);
  if (!cover) {
    // 缓存里的歌名写法可能和系统给的略有出入（全角括号等），去掉括号里的版本信息再找一次
    const core = t.replace(/[（(【\[][^)）\]】]*[)）\]】]/g, '').trim();
    if (core && core !== t && core.length >= 2) cover = sodaCoverInBuffer(buf, Buffer.from(core, 'utf8'), artistBuf);
  }
  if (cover) sodaCoverMem.set(key, cover);
  return cover;
}

async function fetchSongCover(title, artist, duration) {
  const key = `m:${title}|${artist || ''}|${Math.round(Number(duration) || 0)}`;
  if (coverMem.has(key)) return { cover: coverMem.get(key), song: '' };
  if (coverInFlight.has(key)) return { cover: '', song: '', pending: true };
  coverInFlight.add(key);
  try {
    // 1) 汽水音乐自己的缓存：和它界面上的封面完全一致
    const local = sodaLocalCover(title, artist);
    if (local) {
      coverMem.set(key, local);
      return { cover: local, song: '' };
    }
    // 2) 其他播放器没有给缩略图时，在线找同一首歌
    const song = await fetchNeteaseMatchedSong(title, artist, duration);
    const cover = neteaseCoverUrl(song);
    if (cover) coverMem.set(key, cover);
    return { cover, song: song ? String(song.name || '') : '' };
  } finally {
    coverInFlight.delete(key);
  }
}

// iTunes 兜底：网易云搜不到的独立音乐人，iTunes 库里常常有
function httpGetJsonPlain(url) {
  return new Promise(resolve => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36' }, timeout: 7000 }, res => {
      if (res.statusCode >= 300 && res.headers.location) {
        res.resume();
        return httpGetJsonPlain(res.headers.location).then(resolve);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (err) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// QQ 音乐兜底：smartbox 搜索覆盖很广（很多汽水/独立音乐人的歌只有 QQ 有）
function httpGetJsonRef(url) {
  return new Promise(resolve => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Referer': 'https://y.qq.com/'
      },
      timeout: 7000
    }, res => {
      if (res.statusCode >= 300 && res.headers.location) {
        res.resume();
        return httpGetJsonRef(res.headers.location).then(resolve);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (err) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function fetchQqCover(title, artist) {
  if (!title) return '';
  const key = `qq:${title}|${artist}`;
  if (coverMem.has(key)) return coverMem.get(key);
  const norm = s => String(s || '').toLowerCase().replace(/[\s\-_.·、,，()（）\[\]【】]/g, '');
  const kt = norm(title);
  const ka = norm(artist);
  const firstArtist = String(artist || '').split(/[,，/&、]/)[0].trim();
  // smartbox 是模糊搜索：带上完整歌手串常常 n=0，所以先用纯歌名，再退到“歌名+首位歌手”
  // 另外把括号里的版本信息（和声版/伴奏/remix…）剥掉，再按空格拆词，覆盖改名/错字的情况
  const core = String(title).replace(/[（(【\[][^)）\]】]*[)）\]】]/g, '').replace(/\s*[-–—]\s.*$/, '').trim();
  const tokens = core.split(/[\s·、,，]+/).filter(t => t.length >= 2);
  const tries = [];
  const push = q => { const s = String(q || '').trim(); if (s && !tries.includes(s)) tries.push(s); };
  push(title);
  push(core);
  push(`${core} ${firstArtist}`);
  tokens.sort((a, b) => b.length - a.length).forEach(push);
  let list = [];
  for (const q of tries) {
    if (!q) continue;
    const box = await httpGetJsonRef(`https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?key=${encodeURIComponent(q)}&format=json&inCharset=utf8&outCharset=utf-8`);
    list = box && box.data && box.data.song && Array.isArray(box.data.song.itemlist) ? box.data.song.itemlist : [];
    if (list.length) break;
  }
  let best = null;
  let bestScore = -1;
  list.forEach(it => {
    let s = 0;
    const sn = norm(it.name);
    if (kt && sn === kt) s += 8;
    else if (kt && sn.includes(kt)) s += 5;
    else if (sn && sn.length >= 2 && kt.includes(sn)) s += 4;   // 歌名是完整标题的一段（拆词命中）
    if (ka && norm(it.singer).includes(ka)) s += 5;
    if (s > bestScore) { bestScore = s; best = it; }
  });
  if (bestScore < 4) best = null;
  let cover = '';
  if (best && best.mid) {
    const detail = await httpGetJsonRef(`https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=${best.mid}&format=json&platform=yqq&needNewCode=0`);
    const alb = detail && Array.isArray(detail.data) && detail.data[0] && detail.data[0].album;
    if (alb && alb.mid) cover = `https://y.qq.com/music/photo_new/T002R300x300M000${alb.mid}.jpg`;
  }
  coverMem.set(key, cover);
  return cover;
}

async function fetchItunesCover(title, artist) {
  if (!title) return '';
  const key = `it:${title}|${artist}`;
  if (coverMem.has(key)) return coverMem.get(key);
  const core = String(title).replace(/[（(【\[][^)）\]】]*[)）\]】]/g, '').replace(/\s*[-–—]\s.*$/, '').trim();
  const term = encodeURIComponent(`${title} ${artist || ''}`.trim());
  let data = await httpGetJsonPlain(`https://itunes.apple.com/search?term=${term}&entity=song&limit=8`);
  let list = data && Array.isArray(data.results) ? data.results : [];
  if (!list.length && core && core !== title) {
    data = await httpGetJsonPlain(`https://itunes.apple.com/search?term=${encodeURIComponent(core)}&entity=song&limit=8`);
    list = data && Array.isArray(data.results) ? data.results : [];
  }
  let url = '';
  const norm = s => String(s || '').toLowerCase().replace(/[\s\-_.·、,，()（）\[\]【】]/g, '');
  const kt = norm(title);
  let score = -1;
  list.forEach(it => {
    let s = 0;
    const tn = norm(it.trackName);
    if (kt && tn === kt) s += 8;
    else if (kt && tn.includes(kt)) s += 4;
    if (artist && norm(it.artistName).includes(norm(artist))) s += 5;
    if (s > score && it.artworkUrl100) { score = s; url = String(it.artworkUrl100).replace('/100x100bb', '/200x200bb'); }
  });
  coverMem.set(key, url);
  return url;
}

async function getLyrics(title, artist) {
  const key = `${title}|${artist}`;
  if (lyricsCache.key === key && (lyricsCache.lines.length || lyricsCache.cover)) return lyricsCache;
  let found = findLocalLyrics(title);
  let cover = '';
  const netease = await fetchNeteaseLyrics(title, artist);
  if (netease) {
    cover = netease.cover || '';
    if (!found && netease.lines.length) found = netease;
  }
  if (!cover) cover = await fetchQqCover(title, artist);
  if (!cover) cover = await fetchItunesCover(title, artist);
  lyricsCache = { key, lines: found ? found.lines : [], source: found ? found.source : '', cover };
  return lyricsCache;
}

function warmLyrics(title, artist) {
  const key = `${title}|${artist}`;
  if (lyricsCache.key === key) return;
  if (lyricsCache.pending === key) return;
  lyricsCache.pending = key;
  getLyrics(title, artist).catch(() => {}).finally(() => { lyricsCache.pending = ''; });
}

// ---------------- 生命周期 ----------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 再次双击程序时打开设置页，而不是只把 Dock 重新显示一下。
    openSettingsWindow();
  });

  app.on('ready', () => {
    loadConfig();
    // 第一次启动把默认配置落盘：之后启动就有用户配置，不会再弹引导
    if (firstRun) saveConfig(cfg);
    syncAutoStart(true);
    wireIPC();

    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        const primary = screen.getPrimaryDisplay();
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1, height: 1 },
          fetchWindowIcons: false
        });
        const source = sources.find(s => s.display_id === String(primary.id)) || sources[0];
        callback(source ? { video: source } : {});
      } catch (err) {
        callback({});
      }
    }, { useSystemPicker: false });

    createWindow();
    createTrayIcon();
    startWgcCapture();
    if (process.argv.includes('--settings')) {
      setTimeout(openSettingsWindow, 500);
    } else if (firstRun) {
      // 第一次使用：自动打开设置页，并展开一次上手引导（不打扰后续启动）
      setTimeout(() => openSettingsWindow({ welcome: true }), 900);
    }

    screen.on('display-metrics-changed', relayout);
    screen.on('display-added', relayout);
    screen.on('display-removed', relayout);

    // 轮询只是兜底（指针不产生 mousemove 时）；日常切换由渲染进程即时交还。
    // 周期 12ms 足够赶在一次点击之前交出穿透（鼠标移动事件本身还会即时触发一次），
    // 原来 8ms 相当于每秒 125 次 cursor/rect 查询，白白占主进程 CPU。
    hitTimer = setInterval(applyHitState, 12);
    startMediaBridge();
    startMinBridge();

    if (process.argv.includes('--preview')) runPreview();
  });

  // Dock 常驻，关掉所有窗口也不退出
  app.on('window-all-closed', (e) => { e.preventDefault && e.preventDefault(); });
  app.on('before-quit', () => {
    if (hitTimer) clearInterval(hitTimer);
    if (tray) { try { tray.destroy(); } catch (err) {} tray = null; }
    stopMediaBridge();
    stopMinBridge();
    if (statusWatchProcess) { try { statusWatchProcess.kill(); } catch (err) {} statusWatchProcess = null; }
    if (ctlProcess) { try { ctlProcess.kill(); } catch (err) {} ctlProcess = null; }
    if (ctlTickTimer) { clearInterval(ctlTickTimer); ctlTickTimer = null; }
    if (imeHelperProcess) { try { imeHelperProcess.kill(); } catch (err) {} imeHelperProcess = null; }
    stopWgcCapture();
    try { win && win.setContentProtection(false); } catch (err) {}
  });
}





