$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 5500

Write-Host ""
Write-Host "Serving messi-ronaldo-vote at http://localhost:$port" -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop the server." -ForegroundColor DarkGray
Write-Host ""

Set-Location $projectRoot
python -m http.server $port
