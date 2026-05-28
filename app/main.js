// main.js — Electron main process
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const os = require('os');

// Paths to bundled binaries — works in both dev and packaged mode
// In dev: ../bin/ relative to this file
// When packaged: process.resourcesPath/bin/
const BIN_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'bin')
  : path.resolve(__dirname, '..', 'bin');

const WHISPER_EXE = path.join(BIN_DIR, 'whisper-cli.exe');
const WHISPER_EXE_ALT = path.join(BIN_DIR, 'main.exe'); // older naming
const WHISPER_MODEL = path.join(BIN_DIR, 'ggml-medium.en.bin');
const FFMPEG_EXE = path.join(BIN_DIR, 'ffmpeg.exe');
const FFPROBE_EXE = path.join(BIN_DIR, 'ffprobe.exe');

function resolveWhisper() {
  if (fs.existsSync(WHISPER_EXE)) return WHISPER_EXE;
  if (fs.existsSync(WHISPER_EXE_ALT)) return WHISPER_EXE_ALT;
  return null;
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1a1a1f',
    title: 'Caption Highlighter',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  // mainWindow.webContents.openDevTools(); // uncomment for debugging
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ─── IPC: reveal file in Explorer ──────────────────────────────────────────
const { shell } = require('electron');

ipcMain.handle('reveal-file', async (event, filePath) => {
  shell.showItemInFolder(filePath);
  return { success: true };
});

// ─── IPC: open in Adobe Media Encoder ──────────────────────────────────────
ipcMain.handle('open-in-ame', async (event, filePath) => {
  // Try common AME install paths
  const candidatePaths = [];

  // Look for AME 2026, 2025, 2024 in standard install locations
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const years = ['2026', '2025', '2024', '2023', '2022'];
  for (const year of years) {
    candidatePaths.push(path.join(programFiles, 'Adobe', `Adobe Media Encoder ${year}`, 'Adobe Media Encoder.exe'));
  }

  // Find the first one that exists
  let amePath = null;
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) { amePath = p; break; }
  }

  if (!amePath) {
    // Fallback: try shell.openPath which will use the default app for .mp4
    // but that won't be AME. Better to fail explicitly.
    return {
      success: false,
      error: 'Adobe Media Encoder not found. Checked standard locations for years 2022–2026.'
    };
  }

  // Launch AME with the file as an argument — this adds it to the queue
  try {
    const proc = spawn(amePath, [filePath], { detached: true, stdio: 'ignore' });
    proc.unref();
    return { success: true, amePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ─── IPC: list installed system fonts ──────────────────────────────────────
ipcMain.handle('list-fonts', async () => {
  return new Promise((resolve) => {
    const fonts = new Set();

    if (process.platform === 'win32') {
      // Read from Windows registry — lists all installed fonts
      execFile('reg', [
        'query',
        'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
      ], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (!err && stdout) {
          // Each line looks like:  FontName (TrueType)    REG_SZ    something.ttf
          stdout.split(/\r?\n/).forEach(line => {
            // Match the font name before "(TrueType)" or similar suffix
            const m = line.match(/^\s{4}(.+?)\s+(?:\((?:TrueType|OpenType|Vector|Raster)\)\s+)?REG_SZ/);
            if (m) {
              // Clean up the name: "Arial Bold (TrueType)" → "Arial Bold"
              let name = m[1].trim()
                .replace(/\s*\((?:TrueType|OpenType|Vector|Raster)\)\s*$/i, '')
                .trim();
              // Some entries have multiple names separated by " & "
              name.split(/\s*&\s*/).forEach(n => {
                if (n) fonts.add(n);
              });
            }
          });
        }
        // Also scan the per-user fonts folder (Windows 10+)
        const userFontsDir = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Windows', 'Fonts');
        if (fs.existsSync(userFontsDir)) {
          try {
            fs.readdirSync(userFontsDir).forEach(f => {
              const name = f.replace(/\.(ttf|otf|ttc|fon)$/i, '');
              if (name) fonts.add(name);
            });
          } catch (e) {}
        }
        resolve(Array.from(fonts).sort((a, b) => a.localeCompare(b)));
      });
    } else if (process.platform === 'darwin') {
      // macOS: use system_profiler
      execFile('system_profiler', ['SPFontsDataType', '-json'], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
        if (!err && stdout) {
          try {
            const data = JSON.parse(stdout);
            (data.SPFontsDataType || []).forEach(f => {
              if (f._name) fonts.add(f._name);
            });
          } catch (e) {}
        }
        resolve(Array.from(fonts).sort((a, b) => a.localeCompare(b)));
      });
    } else {
      // Linux fallback: fc-list
      execFile('fc-list', [':', 'family'], (err, stdout) => {
        if (!err && stdout) {
          stdout.split('\n').forEach(line => {
            line.split(',').forEach(name => {
              const n = name.trim();
              if (n) fonts.add(n);
            });
          });
        }
        resolve(Array.from(fonts).sort((a, b) => a.localeCompare(b)));
      });
    }
  });
});

// ─── IPC: health check binaries ────────────────────────────────────────────
ipcMain.handle('check-binaries', async () => {
  return {
    whisper: !!resolveWhisper(),
    whisperPath: resolveWhisper(),
    model: fs.existsSync(WHISPER_MODEL),
    modelPath: WHISPER_MODEL,
    ffmpeg: fs.existsSync(FFMPEG_EXE),
    ffmpegPath: FFMPEG_EXE,
    ffprobe: fs.existsSync(FFPROBE_EXE)
  };
});

// ─── IPC: file picker ──────────────────────────────────────────────────────
ipcMain.handle('pick-video', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('pick-save', async (event, suggestedName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: suggestedName || 'captioned-video.mp4',
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }]
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

// ─── IPC: probe video for dimensions/duration/fps ──────────────────────────
ipcMain.handle('probe-video', async (event, videoPath) => {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE_EXE, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate,duration',
      '-of', 'json',
      videoPath
    ], (err, stdout) => {
      if (err) return reject(err);
      try {
        const data = JSON.parse(stdout);
        const s = data.streams[0];
        const [num, den] = s.r_frame_rate.split('/').map(Number);
        resolve({
          width: s.width,
          height: s.height,
          fps: num / den,
          duration: parseFloat(s.duration)
        });
      } catch (e) { reject(e); }
    });
  });
});

// ─── IPC: transcribe ───────────────────────────────────────────────────────
ipcMain.handle('transcribe', async (event, videoPath) => {
  const whisperPath = resolveWhisper();
  if (!whisperPath) throw new Error('whisper binary not found in bin folder');
  if (!fs.existsSync(WHISPER_MODEL)) throw new Error('whisper model not found in bin folder');
  if (!fs.existsSync(FFMPEG_EXE)) throw new Error('ffmpeg not found in bin folder');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capapp-'));
  const wavPath = path.join(tmpDir, 'audio.wav');
  const jsonPath = path.join(tmpDir, 'audio.json');

  // Step 1: extract audio as 16kHz mono WAV (what whisper needs)
  mainWindow.webContents.send('progress', { stage: 'extracting audio', percent: 5 });

  await new Promise((resolve, reject) => {
    execFile(FFMPEG_EXE, [
      '-y',
      '-i', videoPath,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-acodec', 'pcm_s16le',
      wavPath
    ], (err) => err ? reject(err) : resolve());
  });

  mainWindow.webContents.send('progress', { stage: 'transcribing', percent: 15 });

  // Step 2: run whisper.cpp with word-level timestamps and JSON output
  const wOut = path.join(tmpDir, 'audio'); // whisper appends .json
  await new Promise((resolve, reject) => {
    const proc = spawn(whisperPath, [
      '-m', WHISPER_MODEL,
      '-f', wavPath,
      '-oj',            // output JSON
      '-of', wOut,      // output file path (no extension)
      '-ml', '1',       // max segment length = 1 token (word-level)
      '--print-progress'
    ]);

    let stderr = '';
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      // whisper prints progress like "progress = 42%"
      const m = s.match(/progress\s*=\s*(\d+)%/);
      if (m) {
        const pct = 15 + Math.floor(parseInt(m[1]) * 0.75); // 15-90%
        mainWindow.webContents.send('progress', { stage: 'transcribing', percent: pct });
      }
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error('whisper failed (exit ' + code + ')\n' + stderr.slice(-2000)));
      else resolve();
    });
  });

  // Step 3: parse the JSON
  const finalJsonPath = wOut + '.json';
  if (!fs.existsSync(finalJsonPath)) {
    throw new Error('whisper did not produce JSON output at ' + finalJsonPath);
  }
  const whisperJson = JSON.parse(fs.readFileSync(finalJsonPath, 'utf8'));
  const words = extractWords(whisperJson);

  mainWindow.webContents.send('progress', { stage: 'done', percent: 100 });

  // Cleanup
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {}

  return { words };
});

function extractWords(whisperJson) {
  // whisper.cpp JSON output: { transcription: [ {timestamps:{from,to}, text, ...}, ... ] }
  // With -ml 1 each entry is essentially one word/token
  const out = [];
  const segs = whisperJson.transcription || whisperJson.segments || [];
  for (const s of segs) {
    const text = (s.text || '').replace(/^\s+|\s+$/g, '');
    if (!text) continue;
    let startMs, endMs;
    if (s.timestamps) {
      // "00:00:01,200" format
      startMs = parseTimestamp(s.timestamps.from);
      endMs = parseTimestamp(s.timestamps.to);
    } else if (s.offsets) {
      startMs = s.offsets.from;
      endMs = s.offsets.to;
    } else if (s.start != null) {
      startMs = s.start * 1000;
      endMs = s.end * 1000;
    } else continue;

    // text may contain multiple words; split conservatively
    const subwords = text.split(/\s+/).filter(Boolean);
    if (subwords.length === 1) {
      out.push({ text: subwords[0], start: startMs / 1000, end: endMs / 1000 });
    } else {
      const dur = (endMs - startMs) / subwords.length / 1000;
      subwords.forEach((w, i) => {
        out.push({ text: w, start: (startMs / 1000) + i * dur, end: (startMs / 1000) + (i + 1) * dur });
      });
    }
  }
  return out;
}

function parseTimestamp(ts) {
  // "HH:MM:SS,mmm" or "HH:MM:SS.mmm"
  const m = ts.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return (parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3])) * 1000 + parseInt(m[4]);
}

// ─── IPC: export final video with burned-in captions ───────────────────────
ipcMain.handle('export-video', async (event, opts) => {
  const { videoPath, outputPath, captionGroups, style, videoMeta } = opts;

  if (!fs.existsSync(FFMPEG_EXE)) throw new Error('ffmpeg not found');

  // We render captions to a transparent PNG sequence first, then overlay
  // For simplicity, generate an ASS subtitle file with karaoke styling
  // OR render via drawtext filter (we'll use drawtext for max control)
  
  // For per-word highlighting with backgrounds, the cleanest approach is
  // to generate an SVG/PNG overlay sequence — but that's slow.
  //
  // Simpler: use ffmpeg's `drawtext` filter with one expression per word.
  // BUT drawtext doesn't natively support per-word background boxes that
  // jump positions. So we render a transparent PNG sequence in Node, then
  // overlay it onto the video.

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capexport-'));
  const overlayPath = path.join(tmpDir, 'overlay.mov'); // transparent video

  mainWindow.webContents.send('export-progress', { stage: 'rendering overlay', percent: 5 });

  // Build an ASS subtitle file — this is the easiest way to get per-word styling
  const assPath = path.join(tmpDir, 'subs.ass');
  fs.writeFileSync(assPath, buildASS(captionGroups, style, videoMeta));

  mainWindow.webContents.send('export-progress', { stage: 'encoding video', percent: 20 });

  // Burn the subtitles into the video
  // ffmpeg's subtitles filter requires a properly escaped path on Windows
  const assPathEsc = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

  await new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', videoPath,
      '-vf', `subtitles='${assPathEsc}'`,
      '-c:a', 'copy',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '20',
      outputPath
    ];
    const proc = spawn(FFMPEG_EXE, args);
    let stderr = '';
    let lastReported = 0;
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      const m = s.match(/time=(\d+):(\d+):(\d+)/);
      if (m && videoMeta.duration) {
        const sec = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
        const pct = 20 + Math.min(75, Math.floor((sec / videoMeta.duration) * 75));
        if (pct - lastReported >= 1) {
          lastReported = pct;
          mainWindow.webContents.send('export-progress', { stage: 'encoding', percent: pct });
        }
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error('ffmpeg failed:\n' + stderr.slice(-2000)));
      else resolve();
    });
  });

  mainWindow.webContents.send('export-progress', { stage: 'done', percent: 100 });

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}

  return { outputPath };
});

// ─── ASS subtitle generator (karaoke-style word highlighting) ──────────────
function buildASS(captionGroups, style, meta) {
  // ASS format with libass supports per-word color changes via inline tags
  const W = meta.width;
  const H = meta.height;

  // Convert hex color to ASS &HBBGGRR format (note: BGR order, not RGB)
  function hex2ass(hex) {
    hex = hex.replace(/^#/, '');
    const r = hex.substring(0, 2);
    const g = hex.substring(2, 4);
    const b = hex.substring(4, 6);
    return `&H00${b}${g}${r}`.toUpperCase();
  }

  // Compute Y position (style.yPercent is from top, ASS uses Alignment + MarginV)
  // We'll use Alignment 2 (bottom-center) and compute MarginV
  const yPos = Math.round(H * (style.yPercent / 100));
  const marginV = H - yPos;

  const fontName = style.font || 'Arial';
  const fontSize = style.fontSize || 64;
  const baseCol = hex2ass(style.baseColor);
  const hlCol = hex2ass(style.hlColor);
  const bgCol = hex2ass(style.bgColor);

  let ass = `[Script Info]
Title: Caption Highlighter
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Base,${fontName},${fontSize},${baseCol},${baseCol},&H00000000,&H80000000,${style.bold ? -1 : 0},0,0,0,100,100,0,0,1,3,0,2,30,30,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  // Group consecutive words into captions (already grouped from UI)
  for (const group of captionGroups) {
    // Each group becomes one dialogue line that spans the group's duration
    // with per-word color changes using \r and \k tags (or inline color)
    //
    // Approach: emit ONE dialogue line per word, layered so only the
    // currently-spoken word shows in highlight color. But ASS lets us do
    // it cleaner: emit one line per word-state with the full caption text,
    // highlighting one word.
    //
    // Simplest reliable: emit one line per word that shows the full caption
    // with that word's color overridden.

    const fullText = group.words.map(w => w.text).join(' ');

    for (let i = 0; i < group.words.length; i++) {
      const w = group.words[i];
      // Build text with one word in highlight color (and optional bg)
      // ASS inline override codes:
      //   {\c&HBBGGRR&} sets primary color
      //   {\3c} sets outline color
      //   {\4c} sets back/shadow color
      //   {\bord3} sets border thickness
      // Background-as-box behind a single word is tricky in pure ASS.
      // libass DOES support a "highlight" with \4a&H00& + \4c&H...& + BorderStyle 3
      // but BorderStyle is per-style not per-word. So for per-word bg we'd need
      // a separate \r override switch. We'll do it via inline override.

      let line = '';
      for (let j = 0; j < group.words.length; j++) {
        if (j > 0) line += ' ';
        const word = group.words[j].text.replace(/[{}]/g, '');
        if (j === i) {
          if (style.useBg) {
            // Use \4c for background-style with border-3 trick won't work per-word.
            // Fallback: just color the highlighted word.
            line += `{\\c${hlCol}\\b1}${word}{\\r}`;
          } else {
            line += `{\\c${hlCol}\\b1}${word}{\\r}`;
          }
        } else {
          line += word;
        }
      }

      const start = formatASSTime(w.start);
      const end = formatASSTime(w.end);
      ass += `Dialogue: 0,${start},${end},Base,,0,0,0,,${line}\n`;
    }
  }

  return ass;
}

function formatASSTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = (seconds % 60).toFixed(2);
  const sStr = s.padStart(5, '0');
  return `${h}:${m.toString().padStart(2,'0')}:${sStr}`;
}
