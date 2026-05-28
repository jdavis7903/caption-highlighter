@echo off
setlocal enabledelayedexpansion
title Caption Highlighter — Build Installer
cd /d "%~dp0"

echo ============================================================
echo  Caption Highlighter — One-Time Installer Build
echo ============================================================
echo.
echo This script will:
echo   1. Download Whisper.cpp, the Whisper Medium model, FFmpeg
echo   2. Install npm dependencies (Electron + electron-builder)
echo   3. Package everything into a single Windows installer
echo.
echo You only run this script ONCE on your machine.
echo Once complete, you'll have a CaptionHighlighter-Setup.exe in
echo the dist\ folder that you can run to install the app normally.
echo.
echo Time required: ~15-20 minutes (most of it downloading the 1.5GB model)
echo Disk space needed: ~4 GB during build, ~2 GB final installer
echo.
pause

REM ── Check Node.js ───────────────────────────────────────────────────────
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo [X] Node.js is not installed.
    echo.
    echo Please install Node.js LTS from https://nodejs.org/
    echo Then run this script again.
    echo.
    pause
    exit /b 1
)
echo [OK] Node.js found

REM ── Create folders ──────────────────────────────────────────────────────
if not exist "bin" mkdir bin
if not exist "downloads" mkdir downloads

echo.
echo === Step 1/3: Downloading binaries ===
echo.

REM ── Whisper binary ──────────────────────────────────────────────────────
if exist "bin\whisper-cli.exe" (
    echo [SKIP] whisper-cli.exe already exists
) else if exist "bin\main.exe" (
    echo [SKIP] main.exe already exists
) else (
    echo [..] Downloading whisper.cpp Windows binary...
    powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/ggerganov/whisper.cpp/releases/latest/download/whisper-bin-x64.zip' -OutFile 'downloads\whisper.zip' } catch { exit 1 }"
    if errorlevel 1 (
        echo [X] Download failed.
        pause
        exit /b 1
    )
    powershell -NoProfile -Command "Expand-Archive -Force -Path 'downloads\whisper.zip' -DestinationPath 'downloads\whisper'"
    if exist "downloads\whisper\Release\whisper-cli.exe" (
        copy /Y "downloads\whisper\Release\whisper-cli.exe" "bin\whisper-cli.exe" >nul
        copy /Y "downloads\whisper\Release\*.dll" "bin\" >nul 2>nul
    ) else if exist "downloads\whisper\whisper-cli.exe" (
        copy /Y "downloads\whisper\whisper-cli.exe" "bin\whisper-cli.exe" >nul
        copy /Y "downloads\whisper\*.dll" "bin\" >nul 2>nul
    ) else if exist "downloads\whisper\Release\main.exe" (
        copy /Y "downloads\whisper\Release\main.exe" "bin\main.exe" >nul
        copy /Y "downloads\whisper\Release\*.dll" "bin\" >nul 2>nul
    ) else if exist "downloads\whisper\main.exe" (
        copy /Y "downloads\whisper\main.exe" "bin\main.exe" >nul
        copy /Y "downloads\whisper\*.dll" "bin\" >nul 2>nul
    )
    echo [OK] Whisper binary installed
)

REM ── Model ───────────────────────────────────────────────────────────────
if exist "bin\ggml-medium.en.bin" (
    echo [SKIP] ggml-medium.en.bin already exists
) else (
    echo [..] Downloading Whisper Medium English model ^(1.5 GB^)...
    echo      This is the slow part. Be patient.
    powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest -UseBasicParsing -Uri 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin' -OutFile 'bin\ggml-medium.en.bin' } catch { exit 1 }"
    if errorlevel 1 (
        echo [X] Model download failed.
        pause
        exit /b 1
    )
    echo [OK] Model installed
)

REM ── FFmpeg ──────────────────────────────────────────────────────────────
if exist "bin\ffmpeg.exe" (
    echo [SKIP] ffmpeg.exe already exists
) else (
    echo [..] Downloading FFmpeg...
    powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest -UseBasicParsing -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile 'downloads\ffmpeg.zip' } catch { exit 1 }"
    if errorlevel 1 (
        echo [X] FFmpeg download failed.
        pause
        exit /b 1
    )
    powershell -NoProfile -Command "Expand-Archive -Force -Path 'downloads\ffmpeg.zip' -DestinationPath 'downloads\ffmpeg'"
    for /d %%D in ("downloads\ffmpeg\ffmpeg-*-essentials*") do (
        if exist "%%D\bin\ffmpeg.exe" copy /Y "%%D\bin\ffmpeg.exe" "bin\" >nul
        if exist "%%D\bin\ffprobe.exe" copy /Y "%%D\bin\ffprobe.exe" "bin\" >nul
    )
    echo [OK] FFmpeg installed
)

echo.
echo === Step 2/3: Installing npm dependencies ===
echo.

cd app
if exist "node_modules" (
    echo [SKIP] node_modules already exists
) else (
    echo [..] Installing Electron and electron-builder ^(~300 MB^)...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo [X] npm install failed.
        cd ..
        pause
        exit /b 1
    )
    echo [OK] Dependencies installed
)

echo.
echo === Step 3/3: Building the installer ===
echo.
echo [..] Packaging app, embedding binaries and model...
echo      This takes 3-5 minutes.
echo.

call npm run dist
if errorlevel 1 (
    echo.
    echo [X] Build failed. See errors above.
    cd ..
    pause
    exit /b 1
)

cd ..

echo.
echo ============================================================
echo  Build complete!
echo ============================================================
echo.
echo Your installer is here:
dir /b dist\CaptionHighlighter-Setup-*.exe 2>nul
echo.
echo Double-click it to install Caption Highlighter on this machine
echo or any other Windows PC.
echo.
echo You can now delete:
echo   - The downloads\ folder
echo   - The bin\ folder (binaries are now embedded in the installer)
echo   - The app\node_modules\ folder (if you want to save space)
echo.
echo Keep:
echo   - dist\CaptionHighlighter-Setup-*.exe (the actual installer)
echo.
pause
