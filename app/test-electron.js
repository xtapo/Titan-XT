// Simple test to check if Electron can be loaded
try {
  const electron = require('electron');
  console.log('✓ Electron loaded successfully');
  console.log('✓ electron.app:', typeof electron.app);
  console.log('✓ Electron version:', process.versions.electron);
} catch (err) {
  console.error('✗ Failed to load Electron:', err.message);
  process.exit(1);
}
