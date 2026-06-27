import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('deepseekDesktop', {
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: config => ipcRenderer.invoke('config:save', config),
  selectFolder: () => ipcRenderer.invoke('folder:select'),
  getShareStatus: () => ipcRenderer.invoke('share:status'),
  startShare: folder => ipcRenderer.invoke('share:start', folder),
  stopShare: () => ipcRenderer.invoke('share:stop'),
  addShareFolder: () => ipcRenderer.invoke('share:add-folder'),
  removeShareFolder: folder => ipcRenderer.invoke('share:remove-folder', folder),
  discoverShares: () => ipcRenderer.invoke('share:discover'),
  connectShare: (host, password) => ipcRenderer.invoke('share:connect', host, password),
  mountShare: (host, password, mountPath) => ipcRenderer.invoke('share:mount', host, password, mountPath),
  openShare: targetUrl => ipcRenderer.invoke('share:open', targetUrl),
  setComputerName: name => ipcRenderer.invoke('identity:set-name', name),
  setSharePassword: password => ipcRenderer.invoke('identity:set-password', password)
});
