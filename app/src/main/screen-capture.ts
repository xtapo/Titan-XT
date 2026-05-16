import { ipcMain, desktopCapturer, screen } from 'electron';
import { MonitorInfo } from '../shared/types';

/**
 * ScreenCapture — Manages screen capture sources for WebRTC streaming
 * Supports multi-monitor selection
 */

/**
 * Get all available screen sources with thumbnails
 */
async function getScreenSources(): Promise<MonitorInfo[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 320, height: 180 },
  });

  const displays = screen.getAllDisplays();
  const primaryDisplay = screen.getPrimaryDisplay();

  return sources.map((source, index) => {
    const display = displays[index] || primaryDisplay;
    return {
      id: source.id,
      name: source.name || `Monitor ${index + 1}`,
      bounds: display.bounds,
      isPrimary: display.id === primaryDisplay.id,
      thumbnail: source.thumbnail.toDataURL(),
    };
  });
}

/**
 * Setup IPC handlers for screen capture
 */
export function setupScreenCapture(): void {
  // Get available monitors
  ipcMain.handle('screen:getSources', async () => {
    try {
      return await getScreenSources();
    } catch (err: any) {
      console.error('[Screen] Error getting sources:', err);
      return [];
    }
  });

  // Get specific monitor info
  ipcMain.handle('screen:getMonitorInfo', (_event, monitorId: string) => {
    const displays = screen.getAllDisplays();
    const display = displays.find((d) => d.id.toString() === monitorId);
    if (!display) return null;

    return {
      id: display.id.toString(),
      bounds: display.bounds,
      scaleFactor: display.scaleFactor,
      rotation: display.rotation,
    };
  });

  // Get primary display info (for coordinate mapping)
  ipcMain.handle('screen:getPrimaryDisplay', () => {
    const display = screen.getPrimaryDisplay();
    return {
      id: display.id.toString(),
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
    };
  });
}
