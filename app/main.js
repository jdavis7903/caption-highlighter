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
const WHISPER_MODEL = path.join(BIN_DIR, 'ggml-medium.en.bin');
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
    },
    backgroundColor: '#1a1a1a',
    show: false,
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile('index.html');

  // Strip the default menu in production, keep DevTools in dev
  if (isPackaged) {
    Menu.setApplicationMenu(null);
  }
}

app.whenReady().then(() => {
  createWindow();
  // Auto-check for updates 3s after launch — but only if a token is configured
  // (private repos require one, and checking without it just throws a 404 error
  // that would alarm the user). They can always check manually from settings.
  if (isPackaged) {
    setTimeout(() => {
      const hasToken = applyUpdaterToken();
      if (hasToken) {
        autoUpdater.checkForUpdates().catch(err => {
          console.log('Update check failed:', err.message);
        });
      }
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

// For private GitHub repos, the updater needs a token. We read it from settings
// and apply it before each check via setFeedURL.
function applyUpdaterToken() {
  const settings = loadSettings();
  const token = settings.githubToken;
  if (!token) return false;
  try {
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: 'jdavis7903',
      repo: 'caption-highlighter',
      private: true,
      token: token,
    });
    return true;
  } catch (e) {
    console.error('Failed to set updater feed URL:', e);
    return false;
  }
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
        const v = data.streams.find(s => s.codec_type === 'video');
        resolve({
          width: v?.width || 1920,
          height: v?.height || 1080,
          duration: parseFloat(data.format.duration) || 0,
          fps: parseFrameRate(v?.r_frame_rate),
        });
      } catch (e) {
        reject(e);
      }
    });
  });
});

// ─── TRANSCRIBE ─────────────────────────────────────────────────────────
ipcMain.handle('transcribe', async (_e, videoPath, opts = {}) => {
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
  // CRITICAL: cwd MUST be BIN_DIR so the CUDA DLLs resolve
  const outBase = path.join(tmpDir, 'audio');

  // Diagnostics collected from whisper's own stderr output
  const diag = {
    backend: 'unknown',     // 'CUDA' | 'CPU' | 'unknown'
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
      args.push('-fa'); // flash attention (GPU)
    } else {
      args.push('-ng'); // no GPU
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
    let sawCuda = false;

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

      // Detect backend. whisper.cpp prints lines like:
      //   "whisper_backend_init_gpu: using CUDA backend"
      //   "ggml_cuda_init: found 1 CUDA devices:"
      //   "  Device 0: NVIDIA GeForce RTX 4070, compute capability 8.9"
      if (/using CUDA backend|ggml_cuda_init|CUDA devices/i.test(text)) {
        sawCuda = true;
        diag.backend = 'CUDA';
      }
      const devMatch = text.match(/Device \d+:\s*(.+?)(?:,|$)/);
      if (devMatch) diag.gpuDevice = devMatch[1].trim();
      const backendMatch = text.match(/using (\w+) backend/i);
      if (backendMatch) diag.backendLine = backendMatch[0];
      // whisper prints timing summary at the end:
      //   "whisper_print_timings: encode time = ..."
      const encMatch = text.match(/encode time\s*=\s*([\d.]+)\s*ms/i);
      if (encMatch) diag.encodeMs = parseFloat(encMatch[1]);
    });

    proc.on('close', (code) => {
      diag.elapsedMs = Date.now() - t0;
      if (!useGpu) diag.backend = 'CPU';
      else if (!sawCuda && diag.backend !== 'CUDA') diag.backend = 'CPU';
      if (code === 0) resolve({ stdout, stderr, sawCuda });
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
      gpuWorked = r.sawCuda;
      if (!r.sawCuda && forceMode === 'auto') {
        dbg('⚠️ GPU requested but no CUDA backend detected — whisper ran on CPU.');
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

  // Flatten into word list with timestamps
  const words = [];
  for (const seg of raw.transcription || []) {
    const text = (seg.text || '').trim();
    if (!text) continue;
    // offsets are in ms
    const startMs = seg.offsets?.from ?? 0;
    const endMs = seg.offsets?.to ?? startMs;
    words.push({
      text,
      start: startMs / 1000,
      end: endMs / 1000,
    });
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
  // Build ASS subtitle file (always at SOURCE resolution; we scale the whole frame last)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caphi-export-'));
  const assPath = path.join(tmpDir, 'subs.ass');
  fs.writeFileSync(assPath, buildAss(captions, style, videoSize), 'utf-8');

  const escAss = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
  const filters = [];
  filters.push(`subtitles='${escAss}'`);

  for (const s of shapes || []) {
    const enable = `between(t,${s.start.toFixed(3)},${s.end.toFixed(3)})`;
    const color = hexToFfColor(s.color, s.opacity ?? 1);
    if (s.type === 'rect' || s.type === 'circle') {
      filters.push(
        `drawbox=x=${Math.round(s.x)}:y=${Math.round(s.y)}:w=${Math.round(s.w)}:h=${Math.round(s.h)}:` +
        `color=${color}:t=${s.filled ? 'fill' : Math.max(1, s.stroke || 2)}:enable='${enable}'`
      );
    } else if (s.type === 'line') {
      filters.push(
        `drawbox=x=${Math.round(s.x)}:y=${Math.round(s.y)}:w=${Math.round(s.w)}:h=${Math.max(1, s.h)}:` +
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
    const py = Math.round(cap.y ?? H - 100);

    for (let i = 0; i < cap.words.length; i++) {
      const w = cap.words[i];

      // Helper to render one word with the right styling
      const renderWord = (word, wIdx) => {
        if (wIdx === i) {
          if (useBox) {
            // Wrap active word in opaque box: switch BorderStyle to 3 via \bord + back color.
            // ASS inline can't switch BorderStyle, so we emulate a box with a thick border
            // in the box color behind the highlight-colored text.
            return `{\\c${highlightColor}\\3c${boxColor}\\bord6\\shad0}${escAss(word.text)}{\\c${baseColor}\\3c${outline}\\bord3}`;
          }
          return `{\\c${highlightColor}}${escAss(word.text)}{\\c${baseColor}}`;
        }
        return escAss(word.text);
      };

      const parts = [];
      const lines = (cap.lines && cap.lines.length)
        ? cap.lines
        : [cap.words.map((_, idx) => idx)];

      lines.forEach((lineIndices, lineIdx) => {
        if (lineIdx > 0) parts.push('\\N');
        lineIndices.forEach((wIdx, j) => {
          if (j > 0) parts.push(' ');
          parts.push(renderWord(cap.words[wIdx], wIdx));
        });
      });

      const text = `{\\pos(${px},${py})\\an5}` + parts.join('');
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
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds * 100) % 100);
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
