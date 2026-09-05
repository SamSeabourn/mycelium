import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('diffish', {
  pickProject: () => ipcRenderer.invoke('pick-project'),
  openFile: (relative: string) => ipcRenderer.invoke('open-file', relative),
});
