// ==================== preload.js - IPC 桥梁 ====================
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // 扫描音乐来源
    scanSource: (url, name) => ipcRenderer.invoke('scan-source', url, name),
    cacheSourceName: (url, name) => ipcRenderer.invoke('cache-source-name', url, name),
    selectFolder: () => ipcRenderer.invoke('select-folder-dialog'),
    // 窗口控制
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close')
});
