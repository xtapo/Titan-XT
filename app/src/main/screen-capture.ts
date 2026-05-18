import { ipcMain, desktopCapturer, screen, session } from 'electron';
import { MonitorInfo } from '../shared/types';

/**
 * ScreenCapture — Manages screen capture sources for WebRTC streaming
 * Supports multi-monitor selection
 */

// Currently-selected desktop source id. Updated whenever the viewer requests
// a monitor switch; consumed the next time the renderer calls getDisplayMedia.
// `null` means "let the handler pick the primary screen".
let selectedSourceId: string | null = null;

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
  // Register display media request handler so navigator.mediaDevices.getDisplayMedia()
  // works inside Electron renderer (without this it throws NotSupportedError).
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 },
        });
        if (sources.length === 0) {
          callback({});
          return;
        }
        // If the viewer asked for a specific monitor, honor it. Otherwise default
        // to the primary screen (first source). The renderer re-invokes
        // getDisplayMedia after a monitor switch via PeerConnection.replaceVideoTrack.
        let chosen = sources[0];
        if (selectedSourceId) {
          const match = sources.find((s) => s.id === selectedSourceId);
          if (match) chosen = match;
        }
        callback({ video: chosen, audio: 'loopback' });
      } catch (err) {
        console.error('[Screen] Display media handler error:', err);
        callback({});
      }
    },
    { useSystemPicker: false }
  );

  // Get available monitors
  ipcMain.handle('screen:getSources', async () => {
    try {
      return await getScreenSources();
    } catch (err: any) {
      console.error('[Screen] Error getting sources:', err);
      return [];
    }
  });

  // Select which source the next getDisplayMedia call should bind to. The
  // renderer first calls this, then re-invokes getDisplayMedia and pipes the
  // resulting track into the existing peer connection via replaceTrack.
  ipcMain.handle('screen:selectSource', (_event, sourceId: string | null) => {
    selectedSourceId = typeof sourceId === 'string' && sourceId.length > 0 ? sourceId : null;
    return { success: true, sourceId: selectedSourceId };
  });

  ipcMain.handle('screen:getSelectedSource', () => {
    return selectedSourceId;
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
