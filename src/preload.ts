import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('mycelium', {
  pickProject: () => ipcRenderer.invoke('pick-project'),
  analyse: (opts: { base: string; compare: string; run: number }) =>
    ipcRenderer.invoke('analyse', opts),
  onProgress: (heard: (p: unknown) => void) => {
    ipcRenderer.on('progress', (_event, p) => heard(p));
  },
  fileDiff: (opts: {
    base: string;
    compare: string;
    file: string;
    range?: [number, number];
    baseRange?: [number, number];
    from?: string;
  }) =>
    ipcRenderer.invoke('file-diff', opts),
  source: (opts: { compare: string; file: string; range: [number, number] }) =>
    ipcRenderer.invoke('source', opts),
  prs: () => ipcRenderer.invoke('prs'),
  pickPr: (opts: { number: number; base: string }) => ipcRenderer.invoke('pick-pr', opts),
  prComments: (opts: { number: number }) => ipcRenderer.invoke('pr-comments', opts),
  submitReview: (opts: unknown) => ipcRenderer.invoke('submit-review', opts),
});
