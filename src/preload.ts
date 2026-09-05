import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('diffish', {
  pickProject: () => ipcRenderer.invoke('pick-project'),
  analyse: (opts: { mode: 'diff' | 'repo' | 'functions'; base: string; compare: string }) =>
    ipcRenderer.invoke('analyse', opts),
  fileDiff: (opts: { base: string; compare: string; file: string }) =>
    ipcRenderer.invoke('file-diff', opts),
  openFile: (relative: string) => ipcRenderer.invoke('open-file', relative),
});
