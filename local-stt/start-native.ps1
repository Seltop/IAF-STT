$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$venv = Join-Path $root ".venv"
$python = Join-Path $venv "Scripts\python.exe"

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
  throw "Python was not found on PATH. Install Python 3.11 or 3.12, then run this command again."
}

$venvAvailable = $false
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& python -c "import venv" *> $null
$venvCheckExitCode = $LASTEXITCODE
$ErrorActionPreference = $previousErrorActionPreference
if ($venvCheckExitCode -eq 0) {
  $venvAvailable = $true
}

if ($venvAvailable) {
  if (-not (Test-Path $python)) {
    python -m venv $venv
  }

  & $python -m pip install --upgrade pip
  & $python -m pip install -r (Join-Path $root "requirements-native.txt")
} else {
  $python = (Get-Command python).Source
  & $python -m pip install --upgrade -r (Join-Path $root "requirements-native.txt")
}

$hasNvidiaGpu = $false
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & nvidia-smi *> $null
  $nvidiaSmiExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorActionPreference
  $hasNvidiaGpu = $nvidiaSmiExitCode -eq 0
}

if ($hasNvidiaGpu -and -not $env:LOCAL_STT_SKIP_GPU_DEPS) {
  & $python -m pip install nvidia-cublas-cu12==12.9.2.10 nvidia-cudnn-cu12==9.23.2.1
}

if (-not $env:LOCAL_STT_ENGINE) {
  $env:LOCAL_STT_ENGINE = "faster_whisper"
}
if (-not $env:LOCAL_STT_FASTER_WHISPER_MODEL) {
  $env:LOCAL_STT_FASTER_WHISPER_MODEL = "ivrit-ai/whisper-large-v3-turbo-ct2"
}
if (-not $env:LOCAL_STT_DEVICE) {
  $env:LOCAL_STT_DEVICE = if ($hasNvidiaGpu) { "cuda" } else { "cpu" }
}
if (-not $env:LOCAL_STT_COMPUTE_TYPE) {
  $env:LOCAL_STT_COMPUTE_TYPE = if ($env:LOCAL_STT_DEVICE -eq "cuda") { "float16" } else { "int8" }
}

Set-Location $root
& $python server.py
