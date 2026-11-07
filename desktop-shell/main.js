import { app, BrowserWindow, shell } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_NAME = 'Voice Agent · RTP Gateway';
const APP_USER_MODEL_ID = 'com.wangguoai.voice.desktop';
const VOICE_PORT = process.env.VOICE_AGENT_PORT || '8091';
const VOICE_URL = `http://127.0.0.1:${VOICE_PORT}`;

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

let mainWindow = null;
let backendProcess = null;

function resolveBackendJar() {
  const packagedJar = path.join(process.resourcesPath || '', 'backend', 'voice-agent.jar');
  if (fs.existsSync(packagedJar)) {
    return packagedJar;
  }
  return path.resolve(__dirname, '..', 'java-freeswitch-rtp-bridge', 'target', 'freeswitch-rtp-bridge-0.3.0.jar');
}

function startEmbeddedJavaBackendIfNeeded() {
  const jarPath = resolveBackendJar();
  if (!fs.existsSync(jarPath)) return;
  backendProcess = spawn('java', ['-jar', jarPath, `--server.port=${VOICE_PORT}`], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

function createDesktopWindow() {
  mainWindow = new BrowserWindow({
    title: APP_NAME,
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#f3f4f6',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(VOICE_URL);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  startEmbeddedJavaBackendIfNeeded();
  setTimeout(createDesktopWindow, 1200);
});

app.on('window-all-closed', () => {
  if (backendProcess) {
    backendProcess.kill();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
