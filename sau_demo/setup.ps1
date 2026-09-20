[CmdletBinding()]
param(
    [string]$PythonExe = "",
    [string]$Proxy = "",
    [switch]$SkipBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$upstreamRoot = Join-Path $projectRoot "social-auto-upload"
$venvRoot = Join-Path $projectRoot ".sau-demo-venv"
$cacheRoot = Join-Path $projectRoot ".sau-demo-cache"
$browserRoot = Join-Path $projectRoot ".sau-demo-browsers"
$venvPython = Join-Path $venvRoot "Scripts\python.exe"

# Exact versions from upstream pyproject.toml; ranges are pinned to their minima.
$packages = @(
    "loguru==0.7.3",
    "opencv-python==4.13.0.92",
    "patchright==1.58.2",
    "qrcode==8.2",
    "requests==2.32.3",
    "segno==1.6.6"
)
# Lock the wheel resolver result as well, so a fresh machine gets the same runtime.
$transitivePackages = @(
    "certifi==2026.7.22", "charset-normalizer==3.5.1", "colorama==0.4.6",
    "greenlet==3.5.6", "idna==3.19", "numpy==2.5.3", "pyee==13.0.1",
    "typing-extensions==4.16.0", "urllib3==2.8.0", "win32-setctime==1.2.0"
)

function Invoke-Python {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Python command failed with exit code $LASTEXITCODE."
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $upstreamRoot "pyproject.toml"))) {
    throw "Missing social-auto-upload/pyproject.toml. Keep the upstream checkout beside sau_demo."
}
if (-not $PythonExe) {
    $PythonExe = (& py -3.12 -c "import sys; print(sys.executable)")
    if ($LASTEXITCODE -ne 0 -or -not $PythonExe) {
        throw "Python 3.12 is required. Install it, or pass -PythonExe with its absolute path."
    }
    $PythonExe = $PythonExe.Trim()
}
Invoke-Python $PythonExe @("-c", "import sys; assert sys.version_info[:2] == (3, 12), 'Python 3.12 is required'; print(sys.version)")

# Restore caller environment at the end; no persistent/user/machine changes.
# Clear pip configuration so an existing private index cannot receive requests.
$environmentNames = @(
    "PYTHONUTF8", "PYTHONIOENCODING", "PIP_CONFIG_FILE", "PIP_DISABLE_PIP_VERSION_CHECK",
    "PIP_NO_INPUT", "PLAYWRIGHT_BROWSERS_PATH", "PLAYWRIGHT_DOWNLOAD_HOST",
    "PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD",
    "PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT", "HTTP_PROXY", "HTTPS_PROXY"
)
$environmentNames += @(Get-ChildItem Env: | Where-Object { $_.Name -like "PIP_*" } | ForEach-Object { $_.Name })
$savedEnvironment = @{}
foreach ($name in ($environmentNames | Select-Object -Unique)) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

try {
    foreach ($name in $savedEnvironment.Keys) {
        if ($name -like "PIP_*" -or $name -like "PLAYWRIGHT_*") {
            [Environment]::SetEnvironmentVariable($name, $null, "Process")
        }
    }
    $env:PYTHONUTF8 = "1"
    $env:PYTHONIOENCODING = "utf-8"
    $env:PIP_CONFIG_FILE = "NUL"
    $env:PIP_DISABLE_PIP_VERSION_CHECK = "1"
    $env:PIP_NO_INPUT = "1"
    $env:PLAYWRIGHT_BROWSERS_PATH = $browserRoot
    $env:PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT = "120000"
    if ($Proxy) {
        # Optional caller-supplied proxy, scoped to this process and its children.
        # Sources remain public PyPI and the default Patchright browser CDN.
        $env:HTTP_PROXY = $Proxy
        $env:HTTPS_PROXY = $Proxy
    }

    [System.IO.Directory]::CreateDirectory($cacheRoot) | Out-Null
    if (-not (Test-Path -LiteralPath $venvPython)) {
        Write-Host "Creating local Python 3.12 virtual environment..."
        Invoke-Python $PythonExe @("-m", "venv", "--without-pip", $venvRoot)
    }
    Invoke-Python $venvPython @("-c", "import sys; assert sys.version_info[:2] == (3, 12), 'Existing virtual environment must use Python 3.12'")
    # A previously interrupted setup may have a Python executable but no pip.
    Invoke-Python $venvPython @("-m", "ensurepip", "--upgrade", "--default-pip")

    # Fail before installing if upstream's direct dependency contract changes.
    $checkDependencies = @'
import pathlib, sys, tomllib
data = tomllib.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
expected = {'loguru==0.7.3', 'opencv-python>=4.13.0.92', 'patchright==1.58.2',
            'qrcode==8.2', 'requests==2.32.3', 'segno>=1.6.6'}
actual = set(data['project']['dependencies'])
if actual != expected:
    raise SystemExit('Upstream dependencies changed. Review and update setup.ps1 pins before installing.')
'@
    Invoke-Python $venvPython @("-c", $checkDependencies, (Join-Path $upstreamRoot "pyproject.toml"))

    Write-Host "Installing pinned CLI dependencies from public PyPI (wheels only)..."
    $pipArguments = @(
        "-m", "pip", "install", "--index-url", "https://pypi.org/simple",
        "--only-binary=:all:", "--cache-dir", $cacheRoot,
        "--disable-pip-version-check", "--no-input", "--timeout", "120", "--retries", "5"
    ) + $packages + $transitivePackages
    Invoke-Python $venvPython $pipArguments
    Invoke-Python $venvPython @("-m", "pip", "check")

    $confPath = Join-Path $upstreamRoot "conf.py"
    if (-not (Test-Path -LiteralPath $confPath)) {
        $examplePath = Join-Path $upstreamRoot "conf.example.py"
        [System.IO.File]::WriteAllText($confPath, [System.IO.File]::ReadAllText($examplePath), $utf8)
        Write-Host "Created local social-auto-upload/conf.py from conf.example.py."
    }

    if (-not $SkipBrowser) {
        Write-Host "Installing Patchright Chromium into $browserRoot ..."
        Invoke-Python $venvPython @("-m", "patchright", "install", "chromium")
    }

    Push-Location $upstreamRoot
    try {
        Invoke-Python $venvPython @("-c", "from uploader.douyin_uploader.main import DouYinVideo, douyin_setup, cookie_auth; print('Douyin uploader imports: OK')")
        # The upstream aggregate sau_cli imports unrelated uploaders with an
        # undeclared playwright dependency. This demo uses the Douyin API directly.
        if (-not $SkipBrowser) {
            $checkBrowser = @'
from pathlib import Path
from patchright.sync_api import sync_playwright
with sync_playwright() as p:
    executable = Path(p.chromium.executable_path)
    if not executable.is_file():
        raise SystemExit(f'Chromium executable missing: {executable}')
    print(f'Chromium executable: {executable}')
'@
            Invoke-Python $venvPython @("-c", $checkBrowser)
        }
    }
    finally {
        Pop-Location
    }
    Push-Location $projectRoot
    try {
        Invoke-Python $venvPython @("-m", "sau_demo.worker", "--help")
    }
    finally {
        Pop-Location
    }

    $freeze = (& $venvPython -m pip freeze)
    if ($LASTEXITCODE -ne 0) {
        throw "Could not record installed package versions."
    }
    [System.IO.File]::WriteAllLines((Join-Path $cacheRoot "requirements-resolved.txt"), [string[]]$freeze, $utf8)
    Write-Host "Installed versions:"
    $freeze | ForEach-Object { Write-Host "  $_" }
    Write-Host "Setup complete. Python: $venvPython"
    if ($SkipBrowser) {
        Write-Host "Browser download skipped. Run setup-sau-demo.cmd without -SkipBrowser before real browser operations."
    }
    else {
        Write-Host "Browser cache: $browserRoot"
    }
}
finally {
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], "Process")
    }
}
