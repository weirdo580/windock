'use strict';

/**
 * 预加载脚本：只把必要能力暴露到 window.dockApi，渲染进程拿不到 Node。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('dockApi', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  previewConfig: (config) => ipcRenderer.invoke('config:preview', config),
  openConfig: () => ipcRenderer.invoke('config:open'),
  reloadConfig: () => ipcRenderer.invoke('config:reload'),

  launch: (id) => ipcRenderer.invoke('app:launch', id),
  chooseApp: () => ipcRenderer.invoke('app:choose'),
  chooseIcon: () => ipcRenderer.invoke('icon:choose'),
  openSettings: () => ipcRenderer.invoke('settings:open'),
  running: () => ipcRenderer.invoke('apps:running'),
  emptyTrash: () => ipcRenderer.invoke('app:empty-trash'),

  capture: () => ipcRenderer.invoke('desktop:capture'),

  mediaGet: () => ipcRenderer.invoke('media:get'),
  mediaControl: (action) => ipcRenderer.invoke('media:control', action),
  mediaLyrics: (payload) => ipcRenderer.invoke('media:lyrics', payload),

  minimizedGet: () => ipcRenderer.invoke('windows:minimized'),
  restoreWindow: (hwnd) => ipcRenderer.invoke('window:restore', hwnd),
  onMinimized: (cb) => {
    const listener = (e, payload) => cb(payload);
    ipcRenderer.on('windows:minimized', listener);
    return () => ipcRenderer.removeListener('windows:minimized', listener);
  },

  getWindowInfo: () => ipcRenderer.invoke('window:info'),
  setMouseThrough: (ignore) => ipcRenderer.invoke('window:mouse-through', ignore),
  setHitRects: (rects) => ipcRenderer.invoke('window:hit-rects', rects),
  showMenu: (payload) => ipcRenderer.invoke('window:menu', payload),
  quit: () => ipcRenderer.invoke('window:quit'),

  extractIcon: (filePath) => ipcRenderer.invoke('icon:extract', filePath),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch (err) { return ''; }
  },

  onAction: (cb) => {
    const listener = (e, payload) => cb(payload);
    ipcRenderer.on('ui:action', listener);
    return () => ipcRenderer.removeListener('ui:action', listener);
  },
  onConfigUpdated: (cb) => {
    const listener = (e, payload) => cb(payload);
    ipcRenderer.on('config:updated', listener);
    return () => ipcRenderer.removeListener('config:updated', listener);
  },
  onCursorAt: (cb) => {
    const listener = (e, payload) => cb(payload);
    ipcRenderer.on('cursor:at', listener);
    return () => ipcRenderer.removeListener('cursor:at', listener);
  }
});
