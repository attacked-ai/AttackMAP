<#
.SYNOPSIS
  Install Docker Desktop on this PC with everything on D: (C: is full).

.DESCRIPTION
  Docker Desktop normally installs to C:\Program Files and keeps its WSL virtual
  disk (several GB, grows with every image) under C:\Users\<you>\AppData\Local\Docker.
  This PC's C: drive has almost no free space, so this script:
    1. downloads the official installer to D:\DockerSetup\ (resumable; the file's
       Authenticode signature must be Docker Inc's before it is run)
    2. runs it with  --installation-dir  and  --wsl-default-data-root  on D:
    3. enables the WSL 2 backend
  It still needs about 1.5 GB free on C: for WSL itself, the Windows feature
  install and the installer's temp files. Free that first (LOCAL_DOCKER_SETUP.md §1).

  Put the WSL memory cap in place BEFORE the first Docker start, so its disks are
  created under it:   npm run local:doctor -- --fix-wsl   (copies docker\wslconfig.example).

  Docker Desktop is free for personal use and small businesses (<250 staff and
  <$10M revenue); otherwise it needs a paid subscription. Running this script
  with -AcceptLicense means YOU accept Docker's Subscription Service Agreement:
  https://www.docker.com/legal/docker-subscription-service-agreement
  Without -AcceptLicense the installer opens its own window and asks you there.

.EXAMPLE
  # From an elevated (Administrator) PowerShell, in the repo root:
  powershell -ExecutionPolicy Bypass -File docker\install-docker-desktop.ps1 -AcceptLicense
#>
param(
  [switch]$AcceptLicense,
  [string]$InstallDir = "D:\Docker",
  [string]$DataRoot   = "D:\DockerData\wsl",
  [string]$WinDataRoot = "D:\DockerData\windows",
  [string]$Download   = "D:\DockerSetup"
)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host "Run this from an Administrator PowerShell." -ForegroundColor Red; exit 1 }

$freeC = (Get-PSDrive C).Free / 1GB
if ($freeC -lt 1.5) {
  Write-Host ("C: has only {0:N2} GB free. Free at least 1.5 GB (ideally 5 GB) before installing: see LOCAL_DOCKER_SETUP.md section 1." -f $freeC) -ForegroundColor Red
  exit 1
}
foreach ($p in $InstallDir, $DataRoot, $WinDataRoot, $Download) {
  if ($p -match '\s') { Write-Host "Path '$p' contains a space; the installer flags do not take quoted paths reliably. Choose one without." -ForegroundColor Red; exit 1 }
  $q = Split-Path $p -Qualifier
  if (-not (Test-Path "$q\")) { Write-Host "Drive $q (for $p) not found; pass -InstallDir / -DataRoot / -WinDataRoot / -Download for another drive." -ForegroundColor Red; exit 1 }
}

New-Item -ItemType Directory -Force $Download, $InstallDir, $DataRoot, $WinDataRoot | Out-Null
$exe = Join-Path $Download "DockerDesktopInstaller.exe"
# Official stable download URL (Docker docs: Install Docker Desktop on Windows).
$url = "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"

function Test-InstallerSignature([string]$path) {
  $sig = Get-AuthenticodeSignature $path
  return ($sig.Status -eq 'Valid' -and $sig.SignerCertificate.Subject -match 'Docker')
}

if ((Test-Path $exe) -and -not (Test-InstallerSignature $exe)) {
  Write-Host "Existing $exe is incomplete or not signed by Docker Inc; downloading again."
  Remove-Item $exe -Force
}
if (-not (Test-Path $exe)) {
  Write-Host "Downloading Docker Desktop installer (~620 MB) to $exe ..."
  # curl.exe ships with Windows 10/11: it streams to disk and resumes (-C -).
  # Invoke-WebRequest on PowerShell 5.1 buffers the whole file and is far slower.
  & "$env:SystemRoot\System32\curl.exe" -fL --retry 3 --retry-delay 5 -C - -o $exe $url
  if ($LASTEXITCODE -ne 0) { Write-Host "Download failed (curl exit $LASTEXITCODE). Re-run to resume." -ForegroundColor Red; exit 1 }
}
if (-not (Test-InstallerSignature $exe)) {
  Remove-Item $exe -Force
  Write-Host "The downloaded installer's signature is not valid / not Docker Inc's. Deleted it; re-run." -ForegroundColor Red
  exit 1
}
Write-Host "Installer signature: valid, Docker Inc."

Write-Host "Installing to $InstallDir with WSL data on $DataRoot ..."
# Flags per Docker's "Install from the command line" documentation.
$installerArgs = @(
  "install",
  "--backend=wsl-2",
  "--installation-dir=$InstallDir",
  "--wsl-default-data-root=$DataRoot",
  "--windows-containers-default-data-root=$WinDataRoot"
)
if ($AcceptLicense) { $installerArgs += "--quiet"; $installerArgs += "--accept-license" }
$p = Start-Process -FilePath $exe -ArgumentList $installerArgs -Wait -PassThru
switch ($p.ExitCode) {
  0     { Write-Host "Installed." -ForegroundColor Green }
  3010  { Write-Host "Installed; Windows needs a reboot (exit code 3010) before Docker can start." -ForegroundColor Yellow }
  default { Write-Host "Installer exited with code $($p.ExitCode)." -ForegroundColor Red; exit $p.ExitCode }
}

Write-Host ""
Write-Host "Next:" -ForegroundColor Green
Write-Host "  1. If the WSL memory cap is not in place yet:  npm run local:doctor -- --fix-wsl   (before the first start)"
Write-Host "  2. Reboot if asked (exit code 3010, or Windows prompts for the WSL 2 feature)."
Write-Host "  3. Start Docker Desktop once from the Start menu; accept its service agreement; wait for 'Engine running'. Skip the sign-in."
Write-Host "  4. In the repo:  npm run local:doctor   then   npm run local:start"
