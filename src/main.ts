import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { scan, type ScanResult } from './scan';

let projectRoot = '';

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('pick-project', async (): Promise<ScanResult | null> => {
  const picked = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (picked.canceled || !picked.filePaths[0]) return null;

  const result = await scan(picked.filePaths[0]);
  if (result.ok) projectRoot = result.root;
  return result;
});

// Renderer only ever holds repo-relative paths, so main rejoins against the root.
ipcMain.handle('open-file', async (_event, relative: string): Promise<string> => {
  if (!projectRoot) return 'No project open';
  return shell.openPath(path.join(projectRoot, relative));
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
