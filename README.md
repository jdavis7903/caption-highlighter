# Caption Highlighter

Desktop app for Windows that takes a video, transcribes it with Whisper running locally, and exports a new video with karaoke-style word-highlighted captions baked in.

Everything runs locally — no cloud, no API keys, no internet needed once installed.

## Quick start (you build once, install forever)

This package contains the **source code** to build a real Windows installer. You run the build script once on your machine, and out comes a `CaptionHighlighter-Setup.exe` you can install like any normal app.

### One-time build

1. **Install Node.js LTS** from https://nodejs.org/ (if not already installed)
2. Unzip this folder somewhere (e.g. `C:\dev\caption-app\`)
3. Double-click **`BuildInstaller.bat`**

That script will:
- Download whisper.cpp, the Whisper Medium English model (~1.5 GB), and FFmpeg
- Install Electron and electron-builder
- Package everything into a Windows installer

Time: ~15-20 minutes. Disk space during build: ~4 GB. Final installer: ~2 GB.

When complete: `dist\CaptionHighlighter-Setup-1.0.0.exe`

### Install the app

Double-click the installer. It walks you through normal install steps:
- Choose install location
- Create desktop shortcut
- Create Start menu shortcut

Windows SmartScreen will show "Windows protected your PC" the first time because the installer isn't code-signed. Click **More info -> Run anyway**.

After install, launch from the desktop shortcut or Start menu — same as any other Windows app.

### Where files go after install

- App: `C:\Users\<you>\AppData\Local\Programs\Caption Highlighter\`
- Bundled binaries: inside `resources\bin\` under the install folder
- Uninstaller: appears in Add or Remove Programs as **Caption Highlighter**

### Sharing with other Windows machines

Once you have `CaptionHighlighter-Setup-1.0.0.exe`, you can copy that single file to any other Windows PC and install it there. No Node.js, no dependencies, no setup — just double-click.

## Using the app

1. **Drop a video** into the drop zone (or click to browse)
2. Click **Transcribe Audio** — Whisper processes the video locally
3. Adjust **Style** — searchable dropdown of your installed fonts, colors, position, optional per-word background
4. Click **Export Video** — pick output location, ffmpeg burns the captions in
5. Done — play the exported MP4

## Style settings

- **Font**: Auto-detected from your installed system fonts (live searchable dropdown)
- **Size**: Font size in pixels (relative to video resolution)
- **Bold**: Force bold weight
- **Base color**: Color of unspoken/upcoming words (typically white)
- **Highlight**: Color of the word currently being spoken
- **Background box**: Optional colored box behind highlighted word
- **Y position**: 0 = top, 100 = bottom; 85 = typical caption position

## How it works under the hood

1. **Transcription**: whisper.cpp running locally with the Whisper Medium English model. Word-level timestamps via `-ml 1`.
2. **Caption grouping**: Words bundled into ~6-word phrases at natural punctuation breaks, max 3 seconds per phrase.
3. **Export**: ASS subtitle file with per-word color overrides -> ffmpeg burns into video with libx264.

## Troubleshooting

**Build fails on npm run dist** — Usually antivirus interfering with packaging. Temporarily disable real-time protection or add the project folder to exclusions.

**Model download slow/hangs** — Manually download from https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin into bin\ then re-run BuildInstaller.bat (it skips already-downloaded files).

**SmartScreen warning** — Expected. Not code-signed. Click "More info -> Run anyway."

**Transcription slow** — Medium model is most accurate but slowest. Swap for ggml-small.en.bin (smaller, faster, slightly less accurate) from the same Hugging Face repo, then rebuild.

**App won't launch after install** — Check %LOCALAPPDATA%\Programs\Caption Highlighter\resources\bin\ for all four binaries (whisper-cli.exe, ggml-medium.en.bin, ffmpeg.exe, ffprobe.exe).

## Updating the app later

1. Edit files in `app/`
2. Bump version in `app/package.json`
3. Re-run `BuildInstaller.bat`
4. New installer in `dist\` — run it to update
