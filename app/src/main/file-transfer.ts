import { ipcMain, dialog, app, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { getStore } from './store';
import { AppSettings } from '../shared/types';

/**
 * Resolve the configured download folder, falling back to <Downloads>/Titan-XT
 * when the user hasn't picked one. The folder is created on demand.
 */
function resolveSaveDir(): string {
  const settings = getStore().get('settings') as AppSettings | undefined;
  const configured = settings?.downloadFolder?.trim();
  const dir = configured && configured.length > 0
    ? configured
    : path.join(app.getPath('downloads'), 'Titan-XT');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * FileTransfer — Handles file selection and saving for transfer
 */
export function setupFileTransfer(): void {
  // Select files to send
  ipcMain.handle('file:selectFiles', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      title: 'Chọn file để gửi',
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths.map((filePath) => {
      const stats = fs.statSync(filePath);
      return {
        path: filePath,
        name: path.basename(filePath),
        size: stats.size,
        type: path.extname(filePath).substring(1),
      };
    });
  });

  // Read file content for sending
  ipcMain.handle('file:readChunk', async (_event, filePath: string, offset: number, chunkSize: number) => {
    try {
      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(chunkSize);
      const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, offset);
      fs.closeSync(fd);
      return buffer.subarray(0, bytesRead).toString('base64');
    } catch (err: any) {
      console.error('[File] Read error:', err);
      return null;
    }
  });

  // Save received file
  ipcMain.handle('file:saveFile', async (event, fileName: string, base64Data: string) => {
    const settings = getStore().get('settings') as AppSettings | undefined;
    const saveDir = resolveSaveDir();
    let finalPath: string;

    if (settings?.askBeforeSave) {
      // Prompt the user. Default file is the suggested name inside saveDir.
      const win = BrowserWindow.fromWebContents(event.sender) || undefined;
      const result = await dialog.showSaveDialog(win!, {
        title: 'Lưu file',
        defaultPath: path.join(saveDir, fileName),
      });
      if (result.canceled || !result.filePath) {
        return { success: false, error: 'Người dùng đã hủy' };
      }
      finalPath = result.filePath;
    } else {
      // Silent save — auto-rename on collision so we never overwrite.
      finalPath = path.join(saveDir, fileName);
      const ext = path.extname(fileName);
      const base = path.basename(fileName, ext);
      let counter = 1;
      while (fs.existsSync(finalPath)) {
        finalPath = path.join(saveDir, `${base} (${counter})${ext}`);
        counter++;
      }
    }

    try {
      // Make sure the chosen directory exists (user may have typed a new path).
      const dir = path.dirname(finalPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const buffer = Buffer.from(base64Data, 'base64');
      fs.writeFileSync(finalPath, buffer);
      console.log(`[File] Saved: ${finalPath}`);
      return { success: true, path: finalPath };
    } catch (err: any) {
      console.error('[File] Save error:', err);
      return { success: false, error: err.message };
    }
  });

  // Pick a folder for storing received files
  ipcMain.handle('dialog:selectFolder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || undefined;
    const result = await dialog.showOpenDialog(win!, {
      title: 'Chọn thư mục lưu file nhận được',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Show file in explorer
  ipcMain.handle('file:showInFolder', async (_event, filePath: string) => {
    const { shell } = require('electron');
    shell.showItemInFolder(filePath);
  });
}
