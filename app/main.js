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
  // Check for updates 3 seconds after launch (let UI settle first)
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

// ─── AUTO UPDATER ───────────────────────────────────────────────────────
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

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
  try {
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, info: result?.updateInfo };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('download-update', async () => {
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
          fps: v?.r_frame_rate ? eval(v.r_frame_rate) : 30,
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
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

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

  // Cleanup tmp WAV but keep dir for debugging
  try { fs.unlinkSync(wavPath); } catch {}

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
});

// ─── SHARED RENDER FUNCTION ─────────────────────────────────────────────
// quality: 'standard' (CRF 20) or 'intermediate' (CRF 12, slow preset)
function renderVideo({ videoPath, captions, shapes, style, videoSize, outPath, quality }) {
  // Build ASS subtitle file
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
      if (code === 0) resolve({ outPath });
      else reject(new Error(`ffmpeg failed (exit ${code})\n${stderr.slice(-800)}`));
    });
    proc.on('error', reject);
  });
}

// ─── EXPORT VIDEO ───────────────────────────────────────────────────────
ipcMain.handle('export-video', async (_e, payload) => {
  return renderVideo({ ...payload, quality: 'standard' });
});

// ─── SEND TO MEDIA ENCODER ──────────────────────────────────────────────
// Burns a high-quality intermediate (CRF 12), then opens it in Adobe Media Encoder
ipcMain.handle('send-to-media-encoder', async (_e, payload) => {
  // 1. Render high-quality intermediate
  const intermediatePath = payload.outPath;
  await renderVideo({ ...payload, quality: 'intermediate' });

  // 2. Locate Adobe Media Encoder
  const amePath = findMediaEncoder();
  if (!amePath) {
    return {
      ok: false,
      intermediatePath,
      error: 'Adobe Media Encoder not found in common install locations. The intermediate file was created — you can open it in AME manually.',
    };
  }

  // 3. Launch AME with the intermediate file
  return new Promise((resolve) => {
    const proc = spawn(amePath, [intermediatePath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    proc.on('error', (err) => {
      resolve({ ok: false, intermediatePath, error: 'Failed to launch AME: ' + err.message });
    });
    proc.unref();
    // Give it a moment to fail-fast on spawn errors
    setTimeout(() => resolve({ ok: true, intermediatePath, amePath }), 500);
  });
});

// Search common Adobe Media Encoder install paths (newest year first)
function findMediaEncoder() {
  const bases = [
    process.env['ProgramFiles'] || 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
  ];
  const candidates = [];
  for (const base of bases) {
    const adobeDir = path.join(base, 'Adobe');
    if (!fs.existsSync(adobeDir)) continue;
    try {
      const entries = fs.readdirSync(adobeDir)
        .filter(d => /Adobe Media Encoder/i.test(d))
        .sort()
        .reverse(); // newest year first
      for (const dir of entries) {
        // exe is usually "Adobe Media Encoder.exe" inside the version folder
        const exe = path.join(adobeDir, dir, 'Adobe Media Encoder.exe');
        if (fs.existsSync(exe)) candidates.push(exe);
        // some versions nest under a subfolder
        const exe2 = path.join(adobeDir, dir, 'Support Files', 'Adobe Media Encoder.exe');
        if (fs.existsSync(exe2)) candidates.push(exe2);
      }
    } catch {}
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
    // Main style: BorderStyle 1 = outline+shadow
    `Style: Default,${font},${size},${baseColor},${baseColor},${outline},&H80000000,${bold},${italic},0,0,100,100,0,0,1,3,1,5,30,30,30,1`,
    // Box style: BorderStyle 3 = opaque box (the box IS the highlight background)
    `Style: Box,${font},${size},${baseColor},${baseColor},${boxColor},${boxColor},${bold},${italic},0,0,100,100,0,0,3,4,0,5,30,30,30,1`,
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
