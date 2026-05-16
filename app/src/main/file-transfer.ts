import { ipcMain, dialog, app } from 'electron';
import fs from 'fs';
import path from 'path';

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
      return buffer.slice(0, bytesRead).toString('base64');
    } catch (err: any) {
      console.error('[File] Read error:', err);
      return null;
    }
  });

  // Save received file
  ipcMain.handle('file:saveFile', async (_event, fileName: string, base64Data: string) => {
    const downloadsPath = app.getPath('downloads');
    const savePath = path.join(downloadsPath, 'Titan-XT');

    // Ensure directory exists
    if (!fs.existsSync(savePath)) {
      fs.mkdirSync(savePath, { recursive: true });
    }

    // Avoid overwriting - add counter if file exists
    let finalPath = path.join(savePath, fileName);
    let counter = 1;
    const ext = path.extname(fileName);
    const nameWithoutExt = path.basename(fileName, ext);

    while (fs.existsSync(finalPath)) {
      finalPath = path.join(savePath, `${nameWithoutExt} (${counter})${ext}`);
      counter++;
    }

    try {
      const buffer = Buffer.from(base64Data, 'base64');
      fs.writeFileSync(finalPath, buffer);
      console.log(`[File] Saved: ${finalPath}`);
      return { success: true, path: finalPath };
    } catch (err: any) {
      console.error('[File] Save error:', err);
      return { success: false, error: err.message };
    }
  });

  // Show file in explorer
  ipcMain.handle('file:showInFolder', async (_event, filePath: string) => {
    const { shell } = require('electron');
    shell.showItemInFolder(filePath);
  });
}
