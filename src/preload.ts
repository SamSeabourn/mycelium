import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('diffish', {
  pickProject: () => ipcRenderer.invoke('pick-project'),
  analyse: (opts: { base: string; compare: string }) =>
    ipcRenderer.invoke('analyse', opts),
  fileDiff: (opts: {
    base: string;
    compare: string;
    file: string;
    range?: [number, number];
    baseRange?: [number, number];
  }) =>
    ipcRenderer.invoke('file-diff', opts),
  openFile: (relative: string) => ipcRenderer.invoke('open-file', relative),
});
