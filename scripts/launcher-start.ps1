$ErrorActionPreference = 'Stop'

function Show-LauncherError([string] $Message) {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show($Message, 'Chill & Thrill Launcher', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error)
    } catch {
        # The helper normally runs hidden. If Windows Forms is unavailable, a
        # PowerShell error remains the fallback for manual invocation.
        Write-Error $Message
    }
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1 }
if (-not $nodeCommand -or -not $nodeCommand.Source) {
    Show-LauncherError 'Không tìm thấy Node.js. Hãy cài Node.js 24 trở lên rồi mở lại launcher.'
    exit 1
}

$controlScript = Join-Path $projectRoot 'scripts\launcher-control.js'
$readyFile = Join-Path $env:TEMP ('chill-thrill-launcher-' + [guid]::NewGuid().ToString('N') + '.json')
$escapedScript = $controlScript.Replace('"', '\"')
$escapedReady = $readyFile.Replace('"', '\"')
$argumentLine = '"{0}" --ready-file "{1}"' -f $escapedScript, $escapedReady

try {
    Start-Process -FilePath $nodeCommand.Source -ArgumentList $argumentLine -WorkingDirectory $projectRoot -WindowStyle Hidden | Out-Null
    $ready = $null
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $readyFile) {
            try {
                $ready = Get-Content -LiteralPath $readyFile -Raw | ConvertFrom-Json
                if ($ready) { break }
            } catch {
                $ready = $null
            }
        }
        Start-Sleep -Milliseconds 100
    }

    if (-not $ready) {
        Show-LauncherError 'Launcher chưa sẵn sàng. Hãy kiểm tra Node.js, sau đó thử mở lại.'
        exit 1
    }
    if ($ready.error) {
        Show-LauncherError ([string]$ready.error)
        exit 1
    }
    $launchUrl = [string]$ready.launchUrl
    if (-not $launchUrl) { $launchUrl = [string]$ready.url }
    if (-not $launchUrl) {
        Show-LauncherError 'Launcher không trả về địa chỉ mở bảng điều khiển.'
        exit 1
    }

    # The browser is intentionally visible; only the Node and PowerShell
    # helper processes are hidden.
    Start-Process -FilePath $launchUrl | Out-Null
} catch {
    Show-LauncherError ('Không mở được Chill & Thrill Launcher: ' + $_.Exception.Message)
    exit 1
} finally {
    if (Test-Path -LiteralPath $readyFile) {
        Remove-Item -LiteralPath $readyFile -Force -ErrorAction SilentlyContinue
    }
}
