const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');

// ─── PATHS ──────────────────────────────────────────────────────────────
const isPackaged = app.isPackaged;
const RESOURCES_DIR = isPackaged
  ? path.join(process.resourcesPath)
  : path.join(__dirname, '..');
const BIN_DIR = path.join(RESOURCES_DIR, 'bin');

const WHISPER_EXE = path.join(BIN_DIR, 'whisper-cli.exe');
const WHISPER_MODEL = path.join(BIN_DIR, 'ggml-large-v3-turbo.bin');
const FFMPEG = path.join(BIN_DIR, 'ffmpeg.exe');
const FFPROBE = path.join(BIN_DIR, 'ffprobe.exe');

let mainWindow = null;

// ─── WINDOW ─────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    backgroundColor: '#1a1a1a',
    show: false,
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile('index.html');

  // ── Security hardening (Electron docs guidance) ──
  // Block in-app navigation to any external URL and deny all new-window opens.
  // The app only ever loads its own local index.html; nothing should navigate away.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      console.warn('Blocked navigation to', url);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Open genuine external links in the user's browser, never in-app.
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Strip the default menu in production, keep DevTools in dev
  if (isPackaged) {
    Menu.setApplicationMenu(null);
  }
}

app.whenReady().then(() => {
  createWindow();
  // Auto-check for updates 3s after launch. The repo is public, so the updater
  // reads the public releases feed — no token or auth needed.
  if (isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(err => {
        console.log('Update check failed:', err.message);
      });
    }, 3000);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── SETTINGS PERSISTENCE ───────────────────────────────────────────────
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
  } catch { return {}; }
}
function saveSettings(obj) {
  try {
    const cur = loadSettings();
    const next = { ...cur, ...obj };
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('saveSettings failed:', e);
    return false;
  }
}

ipcMain.handle('get-setting', (_e, key) => {
  const s = loadSettings();
  return s[key] ?? null;
});
ipcMain.handle('set-setting', (_e, key, value) => {
  // Basic validation: key must be a plain string and not a prototype-pollution vector.
  if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) {
    return false;
  }
  return saveSettings({ [key]: value });
});

// ─── AUTO UPDATER ───────────────────────────────────────────────────────
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
// Disable electron-updater's built-in error dialog so we control the UX
autoUpdater.logger = {
  info: (m) => console.log('[updater]', m),
  warn: (m) => console.warn('[updater]', m),
  error: (m) => console.error('[updater]', m),
  debug: () => {},
};

// The repo is public, so the updater auto-detects owner/repo from package.json's
// publish config and reads the public release feed — no token or setFeedURL needed.
// (Kept as a no-op so existing call sites don't need removing.)
function applyUpdaterToken() {
  return false;
}

autoUpdater.on('update-available', (info) => {
  if (mainWindow) mainWindow.webContents.send('update-available', info);
});
autoUpdater.on('update-not-available', () => {
  if (mainWindow) mainWindow.webContents.send('update-not-available');
});
autoUpdater.on('download-progress', (progress) => {
  if (mainWindow) mainWindow.webContents.send('update-progress', progress);
});
autoUpdater.on('update-downloaded', (info) => {
  if (mainWindow) mainWindow.webContents.send('update-downloaded', info);
});
autoUpdater.on('error', (err) => {
  if (mainWindow) mainWindow.webContents.send('update-error', err.message);
});

ipcMain.handle('check-for-update', async () => {
  applyUpdaterToken();
  try {
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, info: result?.updateInfo };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('download-update', async () => {
  applyUpdaterToken();
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall();
});

ipcMain.handle('get-app-version', () => app.getVersion());

// ─── FILE DIALOGS ───────────────────────────────────────────────────────
ipcMain.handle('pick-video', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('pick-save-path', async (_e, suggestedName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: suggestedName || 'output.mp4',
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });
  return result.canceled ? null : result.filePath;
});

ipcMain.handle('show-in-folder', (_e, filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    shell.showItemInFolder(filePath);
    return true;
  }
  return false;
});

ipcMain.handle('open-in-default-app', (_e, filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    shell.openPath(filePath);
    return true;
  }
  return false;
});

// ─── FONT ENUMERATION (robust, multi-strategy) ───────────────────────────
ipcMain.handle('list-fonts', async () => {
  // Strategy 1: PowerShell + .NET InstalledFontCollection (best, but can be blocked)
  const tryPowerShell = () => new Promise((resolve) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      "Add-Type -AssemblyName System.Drawing; " +
      "(New-Object System.Drawing.Text.InstalledFontCollection).Families | " +
      "ForEach-Object { $_.Name } | Sort-Object -Unique"
    ], { windowsHide: true });

    let out = '';
    let err = '';
    const timer = setTimeout(() => { ps.kill('SIGKILL'); resolve(null); }, 10000);

    ps.stdout.on('data', d => out += d.toString());
    ps.stderr.on('data', d => err += d.toString());
    ps.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) {
        const fonts = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        if (fonts.length > 5) return resolve(fonts);
      }
      resolve(null);
    });
    ps.on('error', () => { clearTimeout(timer); resolve(null); });
  });

  // Strategy 2: Read C:\Windows\Fonts directory + strip extensions
  const tryFontsFolder = () => {
    try {
      const fontsDir = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
      if (!fs.existsSync(fontsDir)) return null;
      const files = fs.readdirSync(fontsDir);
      const names = new Set();
      for (const f of files) {
        if (!/\.(ttf|otf|ttc|fon)$/i.test(f)) continue;
        // Strip extension and common suffixes
        let name = f.replace(/\.(ttf|otf|ttc|fon)$/i, '');
        name = name.replace(/[-_](bold|italic|regular|light|medium|black|thin|semibold|extrabold|condensed)/gi, '');
        name = name.replace(/[-_]/g, ' ').trim();
        if (name) names.add(name);
      }
      return Array.from(names).sort();
    } catch {
      return null;
    }
  };

  // Strategy 3: Hardcoded common Windows fonts (last-resort fallback)
  const fallbackFonts = () => [
    'Arial', 'Arial Black', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS',
    'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Ebrima', 'Franklin Gothic',
    'Gabriola', 'Gadugi', 'Georgia', 'Impact', 'Javanese Text', 'Leelawadee UI',
    'Lucida Console', 'Lucida Sans Unicode', 'Malgun Gothic', 'Microsoft Himalaya',
    'Microsoft JhengHei', 'Microsoft New Tai Lue', 'Microsoft PhagsPa', 'Microsoft Sans Serif',
    'Microsoft Tai Le', 'Microsoft YaHei', 'MingLiU', 'Mongolian Baiti', 'MS Gothic',
    'MV Boli', 'Myanmar Text', 'Nirmala UI', 'Palatino Linotype', 'Segoe Print',
    'Segoe Script', 'Segoe UI', 'Segoe UI Emoji', 'Segoe UI Historic', 'Segoe UI Symbol',
    'SimSun', 'Sitka', 'Sylfaen', 'Symbol', 'Tahoma', 'Times New Roman', 'Trebuchet MS',
    'Verdana', 'Webdings', 'Wingdings', 'Yu Gothic'
  ];

  const ps = await tryPowerShell();
  if (ps) return { fonts: ps, source: 'powershell' };

  const folder = tryFontsFolder();
  if (folder && folder.length > 5) return { fonts: folder, source: 'folder' };

  return { fonts: fallbackFonts(), source: 'fallback' };
});

// ─── PROBE VIDEO ────────────────────────────────────────────────────────
// Safely parse ffprobe's "num/den" frame-rate string without eval.
function parseFrameRate(rate) {
  if (!rate || typeof rate !== 'string') return 30;
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(rate.trim());
  if (m) {
    const num = parseInt(m[1], 10), den = parseInt(m[2], 10);
    if (den > 0) return num / den;
    return 30;
  }
  const n = parseFloat(rate);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

ipcMain.handle('probe-video', async (_e, videoPath) => {
  if (!videoPath || typeof videoPath !== 'string') {
    return Promise.reject(new Error('No video path provided.'));
  }
  return new Promise((resolve, reject) => {
    execFile(FFPROBE, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      videoPath
    ], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const data = JSON.parse(stdout);
        const streams = Array.isArray(data.streams) ? data.streams : [];
        const v = streams.find(s => s.codec_type === 'video');
        if (!v) return reject(new Error('No video stream found in this file.'));
        resolve({
          width: v.width || 1920,
          height: v.height || 1080,
          duration: parseFloat(data.format?.duration) || 0,
          fps: parseFrameRate(v.r_frame_rate),
        });
      } catch (e) {
        reject(e);
      }
    });
  });
});

// ─── TRANSCRIBE ─────────────────────────────────────────────────────────
ipcMain.handle('transcribe', async (_e, videoPath, opts = {}) => {
  if (!videoPath || typeof videoPath !== 'string') {
    throw new Error('No video path provided for transcription.');
  }
  if (!fs.existsSync(WHISPER_MODEL)) {
    throw new Error('Whisper model not found. The installation may be incomplete — try reinstalling.');
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caphi-'));
  const wavPath = path.join(tmpDir, 'audio.wav');
  const forceMode = opts.forceMode || 'auto'; // 'auto' | 'gpu' | 'cpu'

  try {
  // Extract mono 16kHz WAV
  await new Promise((resolve, reject) => {
    execFile(FFMPEG, [
      '-y', '-i', videoPath,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      wavPath
    ], (err) => err ? reject(err) : resolve());
  });

  // Run whisper-cli with GPU + flash-attn
  // CRITICAL: cwd MUST be BIN_DIR so the Vulkan/ggml DLLs resolve
  const outBase = path.join(tmpDir, 'audio');

  // Diagnostics collected from whisper's own stderr output
  const diag = {
    backend: 'unknown',     // 'Vulkan' | 'CPU' | 'unknown'
    backendLine: '',
    gpuDevice: '',
    elapsedMs: 0,
    encodeMs: 0,
    rawLog: '',
  };

  const dbg = (msg) => { if (mainWindow) mainWindow.webContents.send('transcribe-debug', msg); };

  const runWhisper = (useGpu) => new Promise((resolve, reject) => {
    const args = [
      '-m', WHISPER_MODEL,
      '-f', wavPath,
      '-oj',
      '-of', outBase,
      '-ml', '1',
      '--print-progress',
    ];
    if (useGpu) {
      // Vulkan build uses the GPU by default; -fa (flash attention) still helps.
      args.push('-fa');
    } else {
      args.push('-ng'); // no GPU (CPU only)
    }

    dbg(`> whisper-cli ${args.join(' ')}`);
    dbg(`> cwd: ${BIN_DIR}`);
    const t0 = Date.now();

    const proc = spawn(WHISPER_EXE, args, {
      cwd: BIN_DIR,
      windowsHide: true,
    });
    let stderr = '';
    let stdout = '';
    let sawGpu = false;

    proc.stdout.on('data', d => {
      const text = d.toString();
      stdout += text;
      const m = text.match(/progress\s*=\s*(\d+)%/i);
      if (m && mainWindow) {
        mainWindow.webContents.send('transcribe-progress', parseInt(m[1], 10));
      }
    });

    proc.stderr.on('data', d => {
      const text = d.toString();
      stderr += text;
      diag.rawLog += text;
      // Forward each line to the debug panel
      text.split(/\r?\n/).forEach(line => { if (line.trim()) dbg(line.trim()); });

      // Detect Vulkan backend. whisper.cpp/ggml prints lines like:
      //   "ggml_vulkan: Found 1 Vulkan devices:"
      //   "ggml_vulkan: 0 = NVIDIA GeForce RTX 4070 (...) | ..."
      //   "using Vulkan backend"
      if (/ggml_vulkan|using Vulkan backend|Vulkan devices/i.test(text)) {
        sawGpu = true;
        diag.backend = 'Vulkan';
      }
      // Vulkan device line: "ggml_vulkan: 0 = NVIDIA GeForce RTX 4070 (NVIDIA) | ..."
      const vkDev = text.match(/ggml_vulkan:\s*\d+\s*=\s*(.+?)\s*(?:\(|\|)/i);
      if (vkDev) diag.gpuDevice = vkDev[1].trim();
      const backendMatch = text.match(/using (\w+) backend/i);
      if (backendMatch) diag.backendLine = backendMatch[0];
      const encMatch = text.match(/encode time\s*=\s*([\d.]+)\s*ms/i);
      if (encMatch) diag.encodeMs = parseFloat(encMatch[1]);
    });

    proc.on('close', (code) => {
      diag.elapsedMs = Date.now() - t0;
      if (!useGpu) diag.backend = 'CPU';
      else if (!sawGpu && diag.backend !== 'Vulkan') diag.backend = 'CPU';
      if (code === 0) resolve({ stdout, stderr, sawGpu });
      else reject(new Error(`whisper failed (exit ${code})\n${stderr.slice(-600)}`));
    });
    proc.on('error', (err) => reject(err));
  });

  let gpuWorked = false;
  if (forceMode === 'cpu') {
    await runWhisper(false);
    gpuWorked = false;
  } else {
    try {
      const r = await runWhisper(true);
      gpuWorked = r.sawGpu;
      if (!r.sawGpu && forceMode === 'auto') {
        dbg('⚠️ GPU requested but no Vulkan backend detected — whisper ran on CPU.');
      }
    } catch (gpuErr) {
      dbg('✗ GPU run failed: ' + gpuErr.message);
      if (forceMode === 'gpu') throw gpuErr; // user forced GPU, don't silently fall back
      if (mainWindow) mainWindow.webContents.send('transcribe-gpu-fallback', gpuErr.message);
      await runWhisper(false);
      gpuWorked = false;
    }
  }

  // Parse the JSON output
  const jsonPath = outBase + '.json';
  if (!fs.existsSync(jsonPath)) {
    throw new Error('whisper did not produce JSON output');
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  } catch (e) {
    throw new Error('Failed to parse whisper output: ' + e.message);
  }

  // Flatten into word list with timestamps.
  // With -ml 1, whisper emits ONE token per segment. Its tokenizer prefixes a
  // real word-start with a leading space (" Washington"); a sub-word continuation
  // has NO leading space ("ton"). We use that to stitch fragments back into whole
  // words — otherwise "Washington" can arrive as "Washing" + "ton" as two chunks.
  const words = [];
  for (const seg of raw.transcription || []) {
    const rawText = seg.text || '';
    if (!rawText.trim()) continue;
    const startMs = seg.offsets?.from ?? 0;
    const endMs = seg.offsets?.to ?? startMs;
    const start = startMs / 1000;
    const end = endMs / 1000;

    const hasLeadingSpace = /^\s/.test(rawText);
    const piece = rawText.trim();
    // A token is a CONTINUATION (merge into previous) when it has no leading space,
    // begins with a letter/digit (not punctuation), and isn't the first word.
    const isContinuation =
      words.length > 0 &&
      !hasLeadingSpace &&
      /^[A-Za-z0-9'’]/.test(piece) &&
      // don't merge if previous ended with sentence punctuation
      !/[.!?]$/.test(words[words.length - 1].text);
    // Standalone punctuation (",", ".", "?!") attaches to the previous word.
    const isPunctuation = words.length > 0 && /^[.,!?;:’'")\]}…-]+$/.test(piece);

    if (isContinuation || isPunctuation) {
      const prev = words[words.length - 1];
      prev.text += piece;       // glue fragment/punctuation on, no space
      prev.end = end;           // extend timing to cover it
    } else {
      words.push({ text: piece, start, end });
    }
  }

  return {
    words,
    gpuUsed: gpuWorked,
    diag: {
      backend: diag.backend,
      gpuDevice: diag.gpuDevice,
      elapsedMs: diag.elapsedMs,
      encodeMs: diag.encodeMs,
    },
  };
  } finally {
    // Always clean up the temp dir (WAV + JSON + extras), success or failure.
    safeRmDir(tmpDir);
  }
});

// Recursively remove a temp directory, ignoring errors.
function safeRmDir(dir) {
  try {
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error('Temp cleanup failed for', dir, e.message);
  }
}

// ─── SHARED RENDER FUNCTION ─────────────────────────────────────────────
// quality: 'standard' (CRF 20) or 'intermediate' (CRF 12, slow preset)
// exportSize: { width, height } target resolution, or null/undefined to match source
function renderVideo({ videoPath, captions, shapes, style, videoSize, outPath, quality, exportSize }) {
  // Validate the essential inputs up front so a malformed payload fails with a
  // clear message instead of throwing deep inside the filter construction.
  if (!videoPath || typeof videoPath !== 'string') {
    return Promise.reject(new Error('No video path provided to renderer.'));
  }
  if (!outPath || typeof outPath !== 'string') {
    return Promise.reject(new Error('No output path provided to renderer.'));
  }
  if (!videoSize || !Number.isFinite(videoSize.width) || !Number.isFinite(videoSize.height)) {
    return Promise.reject(new Error('Invalid video dimensions.'));
  }
  // Build ASS subtitle file (always at SOURCE resolution; we scale the whole frame last)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caphi-export-'));
  const assPath = path.join(tmpDir, 'subs.ass');
  fs.writeFileSync(assPath, buildAss(captions || [], style || {}, videoSize), 'utf-8');

  const escAss = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
  const filters = [];
  filters.push(`subtitles='${escAss}'`);

  for (const s of shapes || []) {
    const start = Number.isFinite(s.start) ? s.start : 0;
    const end = Number.isFinite(s.end) ? s.end : start + 3;
    const enable = `between(t,${start.toFixed(3)},${end.toFixed(3)})`;
    const color = hexToFfColor(s.color, s.opacity ?? 1);
    // Guard every numeric against NaN/Infinity — a single bad value would make
    // ffmpeg reject the whole filter chain and fail the entire export.
    const ix = Number.isFinite(s.x) ? Math.round(s.x) : 0;
    const iy = Number.isFinite(s.y) ? Math.round(s.y) : 0;
    const iw = Number.isFinite(s.w) ? Math.max(1, Math.round(s.w)) : 10;
    const ih = Number.isFinite(s.h) ? Math.max(1, Math.round(s.h)) : 10;
    const stroke = Number.isFinite(s.stroke) ? Math.max(1, Math.round(s.stroke)) : 2;
    if (s.type === 'rect' || s.type === 'circle') {
      filters.push(
        `drawbox=x=${ix}:y=${iy}:w=${iw}:h=${ih}:` +
        `color=${color}:t=${s.filled ? 'fill' : stroke}:enable='${enable}'`
      );
    } else if (s.type === 'line') {
      filters.push(
        `drawbox=x=${ix}:y=${iy}:w=${iw}:h=${ih}:` +
        `color=${color}:t=fill:enable='${enable}'`
      );
    }
  }

  // Export size: if a target differs from source, scale the whole composited frame.
  // Captions and shapes were drawn at source res, so scaling last keeps them aligned.
  // We fit within the target box preserving aspect ratio, then pad to exact dimensions
  // (letterbox/pillarbox) so the output is exactly the requested resolution.
  const srcW = videoSize.width, srcH = videoSize.height;
  if (exportSize && exportSize.width && exportSize.height &&
      (exportSize.width !== srcW || exportSize.height !== srcH)) {
    const tw = Math.round(exportSize.width / 2) * 2;   // ensure even (yuv420p needs it)
    const th = Math.round(exportSize.height / 2) * 2;
    filters.push(`scale=${tw}:${th}:force_original_aspect_ratio=decrease`);
    filters.push(`pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:black`);
    filters.push('setsar=1');
  }

  const filterChain = filters.join(',');

  // Quality presets
  const crf = quality === 'intermediate' ? '12' : '20';
  const preset = quality === 'intermediate' ? 'slow' : 'medium';

  return new Promise((resolve, reject) => {
    const args = [
      '-y', '-i', videoPath,
      '-vf', filterChain,
      '-map', '0:v:0',        // first video stream
      '-map', '0:a:0?',       // first audio stream IF it exists (the ? makes it optional)
      '-c:v', 'libx264', '-preset', preset, '-crf', crf,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '256k',
      outPath,
    ];

    const proc = spawn(FFMPEG, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', d => {
      stderr += d.toString();
      const m = d.toString().match(/time=(\d+):(\d+):(\d+\.?\d*)/);
      if (m && mainWindow) {
        const sec = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
        mainWindow.webContents.send('export-progress', sec);
      }
    });
    proc.on('close', (code) => {
      safeRmDir(tmpDir);  // remove the .ass temp dir
      if (code === 0) resolve({ outPath });
      else reject(new Error(`ffmpeg failed (exit ${code})\n${stderr.slice(-800)}`));
    });
    proc.on('error', (err) => {
      safeRmDir(tmpDir);
      reject(err);
    });
  });
}

// ─── EXPORT VIDEO ───────────────────────────────────────────────────────
ipcMain.handle('export-video', async (_e, payload) => {
  return renderVideo({ ...payload, quality: 'standard' });
});

// ─── SEND TO MEDIA ENCODER ──────────────────────────────────────────────
// Burns a high-quality intermediate (CRF 12), reveals it in Explorer, and opens
// Adobe Media Encoder. AME has no reliable CLI to auto-queue a loose media file
// (CLI args are for ExtendScript only, and fail if AME is already running), so the
// robust UX is: render → reveal the file → open AME → user drags it into the queue.
ipcMain.handle('send-to-media-encoder', async (_e, payload) => {
  const intermediatePath = payload.outPath;

  // 1. Render high-quality intermediate
  try {
    await renderVideo({ ...payload, quality: 'intermediate' });
  } catch (e) {
    return { ok: false, intermediatePath, error: 'Render failed: ' + e.message, stage: 'render' };
  }

  // Confirm the file actually exists before claiming success
  if (!fs.existsSync(intermediatePath)) {
    return { ok: false, intermediatePath, error: 'Render reported success but output file is missing.', stage: 'render' };
  }

  // 2. Reveal the rendered file in Explorer (always works, helps the drag-in step)
  try { shell.showItemInFolder(intermediatePath); } catch {}

  // 3. Locate Adobe Media Encoder
  const amePath = findMediaEncoder();
  if (!amePath) {
    return {
      ok: true,
      launched: false,
      intermediatePath,
      message: 'Intermediate rendered and revealed in Explorer. Adobe Media Encoder was not found automatically — open it manually and drag the file into the queue.',
    };
  }

  // 4. Launch AME (without args — arg-passing is unreliable). If AME is already
  //    open this is a no-op focus; either way the user drags the revealed file in.
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };

    let proc;
    try {
      proc = spawn(amePath, [], { detached: true, stdio: 'ignore', windowsHide: false });
    } catch (e) {
      return finish({
        ok: true, launched: false, intermediatePath, amePath,
        message: 'Intermediate rendered. Could not auto-launch AME (' + e.message + '). Open it manually and drag the revealed file into the queue.',
      });
    }

    proc.on('error', (err) => {
      finish({
        ok: true, launched: false, intermediatePath, amePath,
        message: 'Intermediate rendered. AME launch failed (' + err.message + '). Open it manually and drag the revealed file into the queue.',
      });
    });
    proc.unref();

    // Resolve as launched after a short grace period if no spawn error fired.
    setTimeout(() => finish({
      ok: true, launched: true, intermediatePath, amePath,
      message: 'Intermediate rendered and revealed. Adobe Media Encoder is opening — drag the highlighted file into the queue, then pick your export settings.',
    }), 800);
  });
});

// Search common Adobe Media Encoder install paths (newest version first).
// Handles both the modern "Support Files" layout and the flat layout, and
// matches folder names like "Adobe Media Encoder 2024", "... CC 2019", etc.
function findMediaEncoder() {
  const bases = [
    process.env['ProgramFiles'] || 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
  ];
  const candidates = [];
  for (const base of bases) {
    const adobeDir = path.join(base, 'Adobe');
    if (!fs.existsSync(adobeDir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(adobeDir).filter(d => /Adobe Media Encoder/i.test(d));
    } catch { continue; }
    // Sort so the highest year/version comes first (e.g. 2025 before 2024, CC 2019 last)
    entries.sort().reverse();
    for (const dir of entries) {
      const versionRoot = path.join(adobeDir, dir);
      const possible = [
        path.join(versionRoot, 'Support Files', 'Adobe Media Encoder.exe'),
        path.join(versionRoot, 'Adobe Media Encoder.exe'),
        path.join(versionRoot, 'Support Files', 'AME.exe'),
        path.join(versionRoot, 'AME.exe'),
      ];
      for (const exe of possible) {
        try { if (fs.existsSync(exe)) candidates.push(exe); } catch {}
      }
    }
  }
  return candidates[0] || null;
}

ipcMain.handle('find-media-encoder', () => {
  const p = findMediaEncoder();
  return { found: !!p, path: p };
});


// ─── ASS BUILDER ────────────────────────────────────────────────────────

// Rough per-character width estimate as a fraction of font size. Proportional
// fonts vary, but this average is close enough to place a bouncing ball over
// each word's horizontal center. Tuned for typical sans-serif caption fonts.
function estimateTextWidth(text, fontSize) {
  let units = 0;
  for (const ch of String(text)) {
    if (/[iIl.,'!|:;]/.test(ch)) units += 0.28;
    else if (/[mwMW]/.test(ch)) units += 0.92;
    else if (/[A-Z]/.test(ch)) units += 0.66;
    else if (/[0-9]/.test(ch)) units += 0.55;
    else if (ch === ' ') units += 0.30;
    else units += 0.52;
  }
  return units * fontSize;
}

// An ASS vector path (\p1 drawing) for a filled circle of radius r centered at
// the drawing origin. Uses 4 cubic Béziers (the standard 0.5523 kappa circle).
function assCircle(r) {
  const k = (r * 0.5523).toFixed(1);
  const rr = r.toFixed(1);
  // Start at top, go clockwise with 4 bezier arcs. Coordinates are relative to
  // the \pos origin used on the drawing's Dialogue line.
  return `m 0 ${-rr} b ${k} ${-rr} ${rr} ${-k} ${rr} 0 b ${rr} ${k} ${k} ${rr} 0 ${rr} b ${-k} ${rr} ${-rr} ${k} ${-rr} 0 b ${-rr} ${-k} ${-k} ${-rr} 0 ${-rr}`;
}

function buildAss(captions, style, videoSize) {
  const { width: W, height: H } = videoSize;
  const font = style.font || 'Arial';
  const size = style.size || 48;
  const baseColor = hexToAssColor(style.baseColor || '#FFFFFF');
  const highlightColor = hexToAssColor(style.highlightColor || '#FFFF00');
  const outline = hexToAssColor(style.outlineColor || '#000000');
  const boxColor = hexToAssColor(style.highlightBoxColor || '#FF0000');
  const useBox = !!style.highlightBox; // per-word background box behind active word
  const bold = style.bold ? -1 : 0;
  const italic = style.italic ? -1 : 0;
  const outlineW = style.noOutline ? 0 : 3;   // Outline thickness (0 = none)
  const shadowW = style.noOutline ? 0 : 1;    // Shadow off when no outline
  const effect = style.effect || 'none';

  // Drop shadow → ASS inline overrides. ASS supports independent X/Y shadow
  // offsets (\xshad, \yshad), shadow colour (\4c) and shadow alpha (\4a), which
  // lets us honor the angle/distance the user picked. Blur via \blur.
  let shadowTag = '';
  if (style.shadow) {
    const ang = (style.shadowAngle || 0) * Math.PI / 180;
    const dist = style.shadowDistance || 0;
    const xs = (Math.cos(ang) * dist).toFixed(1);
    const ys = (Math.sin(ang) * dist).toFixed(1);
    const blur = Math.max(0, style.shadowBlur || 0);
    const shadowColor = hexToAssColor(style.shadowColor || '#000000');
    // ASS alpha: 00 = opaque, FF = transparent. opacity 0-100 → alpha hex.
    const opacity = Math.min(100, Math.max(0, style.shadowOpacity ?? 80));
    const alphaHex = Math.round((1 - opacity / 100) * 255).toString(16).padStart(2, '0').toUpperCase();
    shadowTag = `\\xshad${xs}\\yshad${ys}\\blur${blur}\\4c${shadowColor}\\4a&H${alphaHex}&`;
  }

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Main style: BorderStyle 1 = outline+shadow. The per-word highlight box is
    // applied inline via \3c + \bord overrides (see renderWord), so no separate
    // Box style is needed here.
    `Style: Default,${font},${size},${baseColor},${baseColor},${outline},&H80000000,${bold},${italic},0,0,100,100,0,0,1,${outlineW},${shadowW},5,30,30,30,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  const events = [];
  for (const cap of captions || []) {
    if (!cap.words || cap.words.length === 0) continue;

    const px = Math.round(cap.x ?? W / 2);
    const py = Math.round(cap.y ?? H / 2);
    const capStart = cap.words[0].start;
    const capEnd = cap.words[cap.words.length - 1].end;
    const lines = (cap.lines && cap.lines.length)
      ? cap.lines
      : [cap.words.map((_, idx) => idx)];

    // Highlight rendering for one word within a full-caption re-render
    const renderWord = (word, wIdx, activeIdx) => {
      if (!word) return '';
      if (wIdx === activeIdx) {
        let scaleIn = '', scaleOut = '';
        if (effect === 'scalepop') {
          // Active word pops to 118% then eases back over the word's duration.
          const dur = Math.max(60, Math.round((word.end - word.start) * 1000));
          const half = Math.round(dur / 2);
          scaleIn = `\\t(0,${half},\\fscx118\\fscy118)\\t(${half},${dur},\\fscx100\\fscy100)`;
          scaleOut = '';
        }
        if (useBox) {
          return `{\\c${highlightColor}\\3c${boxColor}\\bord6\\shad0${scaleIn}}${escAss(word.text)}{\\c${baseColor}\\3c${outline}\\bord${outlineW}\\shad${shadowW}\\fscx100\\fscy100}`;
        }
        return `{\\c${highlightColor}${scaleIn}}${escAss(word.text)}{\\c${baseColor}\\fscx100\\fscy100}`;
      }
      return escAss(word.text);
    };

    const buildBody = (activeIdx) => {
      const parts = [];
      lines.forEach((lineIndices, lineIdx) => {
        if (lineIdx > 0) parts.push('\\N');
        lineIndices.forEach((wIdx, j) => {
          if (j > 0) parts.push(' ');
          parts.push(renderWord(cap.words[wIdx], wIdx, activeIdx));
        });
      });
      return parts.join('');
    };

    if (effect === 'slidefade') {
      // ── Entrance + per-word highlight as TWO layers ──
      // Layer 0: the whole caption rises from below with a fade, shown for its
      // full duration (no per-word highlight changes — keeps the move smooth).
      const riseY = py + Math.round(H * 0.06);
      const moveDur = 300;
      const introEnd = capStart + moveDur / 1000;
      events.push(
        `Dialogue: 0,${assTime(capStart)},${assTime(capEnd)},Default,,0,0,0,,` +
        `{\\an5${shadowTag}\\move(${px},${riseY},${px},${py},0,${moveDur})\\fad(${moveDur},0)}` + buildBody(-1)
      );
      // Layer 1: per-word highlight overlaid on top, starting after the intro.
      for (let i = 0; i < cap.words.length; i++) {
        const w = cap.words[i];
        const s = Math.max(w.start, introEnd);
        if (s >= w.end) continue;
        events.push(
          `Dialogue: 1,${assTime(s)},${assTime(w.end)},Default,,0,0,0,,` +
          `{\\pos(${px},${py})\\an5${shadowTag}}` + buildBody(i)
        );
      }
      continue;
    }

    if (effect === 'bounceball') {
      // ── Bouncing ball that lands ON each word as it's spoken ──
      // 1) Render the caption text (per-word highlight) underneath, like default.
      // 2) Overlay a ball that arcs down to the top of each word, synced to timing.
      //
      // We only support a single visual line for the ball path (the most common
      // case). For multi-line captions the ball tracks the flattened word order.
      const flat = lines.flat().map(idx => cap.words[idx]).filter(Boolean);
      if (flat.length === 0) { continue; }

      // Compute each word's horizontal center relative to the caption center.
      // The full line width is the sum of word widths + single-space gaps.
      const spaceW = estimateTextWidth(' ', size);
      const wordW = flat.map(w => estimateTextWidth(w.text, size));
      const totalW = wordW.reduce((a, b) => a + b, 0) + spaceW * (flat.length - 1);
      let cursor = -totalW / 2;            // left edge relative to center (\an5)
      const centers = [];
      for (let k = 0; k < flat.length; k++) {
        centers.push(px + cursor + wordW[k] / 2);
        cursor += wordW[k] + spaceW;
      }
      const topOfText = py - size * 0.6;   // a bit above text baseline center
      const ballR = Math.max(4, Math.round(size * 0.16));
      const restY = topOfText - ballR - 4; // ball sits just above the word top
      const arcH = Math.round(size * 0.9); // how high it rises between words
      const ballColor = highlightColor;

      // Text layer (per word highlight), same as default path.
      for (let i = 0; i < cap.words.length; i++) {
        const w = cap.words[i];
        events.push(
          `Dialogue: 0,${assTime(w.start)},${assTime(w.end)},Default,,0,0,0,,` +
          `{\\pos(${px},${py})\\an5${shadowTag}}` + buildBody(i)
        );
      }

      // Ball layer: for each word, approximate the arc into that word with a few
      // short linear \move hops (ASS \move is linear, so we chain segments).
      const drawing = assCircle(ballR);
      const segPerWord = 6;
      for (let k = 0; k < flat.length; k++) {
        const w = flat[k];
        const fromX = (k === 0) ? centers[0] : centers[k - 1];
        const toX = centers[k];
        const startMs = Math.round(w.start * 1000);
        const endMs = Math.round(w.end * 1000);
        const dur = Math.max(1, endMs - startMs);
        // Parabola: y dips to restY at the word, peaks arcH above between words.
        for (let s = 0; s < segPerWord; s++) {
          const t0 = s / segPerWord, t1 = (s + 1) / segPerWord;
          const x0 = fromX + (toX - fromX) * t0;
          const x1 = fromX + (toX - fromX) * t1;
          // height profile: starts high (arc), lands (0) at end of the word
          const h0 = arcH * Math.sin(Math.PI * (1 - t0) / 2) * (k === 0 ? 1 : 1);
          const h1 = arcH * Math.sin(Math.PI * (1 - t1) / 2);
          const y0 = restY - h0;
          const y1 = restY - h1;
          const segStart = startMs + Math.round(dur * t0);
          const segEnd = startMs + Math.round(dur * t1);
          events.push(
            `Dialogue: 2,${assTime(segStart / 1000)},${assTime(segEnd / 1000)},Default,,0,0,0,,` +
            `{\\an7\\move(${x0.toFixed(0)},${y0.toFixed(0)},${x1.toFixed(0)},${y1.toFixed(0)})` +
            `\\p1\\bord0\\shad0\\1c${ballColor}}${drawing}{\\p0}`
          );
        }
      }
      continue;
    }

    if (effect === 'wordpaint') {
      // ── Karaoke fill sweep: one Dialogue for the whole caption using \kf,
      // where each word's \kf duration = its spoken length in centiseconds. ──
      const parts = [];
      lines.forEach((lineIndices, lineIdx) => {
        if (lineIdx > 0) parts.push('\\N');
        lineIndices.forEach((wIdx, j) => {
          if (j > 0) parts.push(' ');
          const word = cap.words[wIdx];
          if (!word) return;
          const cs = Math.max(1, Math.round((word.end - word.start) * 100));
          parts.push(`{\\kf${cs}}${escAss(word.text)}`);
        });
      });
      // SecondaryColour = base, PrimaryColour fill = highlight. We set both inline:
      // pre-fill is secondary (base), swept fill is primary (highlight).
      events.push(
        `Dialogue: 0,${assTime(capStart)},${assTime(capEnd)},Default,,0,0,0,,` +
        `{\\an5${shadowTag}\\pos(${px},${py})\\1c${highlightColor}\\2c${baseColor}}` + parts.join('')
      );
      continue;
    }

    if (effect === 'cascade') {
      // ── Staircase: each word on its own line, indented progressively right.
      // Rendered as a per-word karaoke highlight but with a custom stacked layout.
      const lineHeight = Math.round(size * 1.1);
      const indent = Math.round(size * 0.6);
      const flatWords = cap.words;
      for (let i = 0; i < flatWords.length; i++) {
        const w = flatWords[i];
        // Build the stacked block with word i highlighted
        const stacked = flatWords.map((ww, k) => {
          const pad = ' '.repeat(0); // horizontal offset done via \pos per line instead
          const col = (k === i) ? highlightColor : baseColor;
          return `{\\pos(${px + k * indent},${py + k * lineHeight - (flatWords.length - 1) * lineHeight / 2})\\an4\\c${col}${shadowTag}}${escAss(ww.text)}`;
        });
        // Each stacked word is its own positioned event for this time slice
        stacked.forEach(s => {
          events.push(`Dialogue: 0,${assTime(w.start)},${assTime(w.end)},Default,,0,0,0,,${s}`);
        });
      }
      continue;
    }

    // ── Default + scalepop: per-word highlight re-render ──
    for (let i = 0; i < cap.words.length; i++) {
      const w = cap.words[i];
      const text = `{\\pos(${px},${py})\\an5${shadowTag}}` + buildBody(i);
      events.push(
        `Dialogue: 0,${assTime(w.start)},${assTime(w.end)},Default,,0,0,0,,${text}`
      );
    }
  }

  return header + '\n' + events.join('\n') + '\n';
}

function escAss(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

function assTime(seconds) {
  // Guard against NaN/undefined/negative to avoid corrupt "NaN:NaN" timestamps.
  let t = Number(seconds);
  if (!Number.isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t * 100) % 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function hexToAssColor(hex) {
  // ASS uses &HBBGGRR&
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '#FFFFFF');
  if (!m) return '&H00FFFFFF';
  const r = m[1].substring(0, 2);
  const g = m[1].substring(2, 4);
  const b = m[1].substring(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

function hexToFfColor(hex, alpha = 1) {
  // ffmpeg accepts "0xRRGGBB@0.5" syntax
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '#FFFFFF');
  const rgb = m ? m[1] : 'FFFFFF';
  return `0x${rgb}@${alpha.toFixed(2)}`;
}
