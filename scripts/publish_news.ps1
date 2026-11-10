# Rebuild news.json and publish it when headlines changed.
# Publishes with the ThinkInfoSec login already stored by GitHub CLI, then switches back.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$log = Join-Path $PSScriptRoot "publish_news.log"

function Write-Log([string]$Message) {
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -Path $log -Value $line -Encoding utf8
}

$python = $null
try { $python = (Get-Command python -ErrorAction Stop).Source } catch { }
if (-not $python) {
  Write-Log "python was not found"
  exit 1
}

& $python (Join-Path $PSScriptRoot "build_news.py")
if ($LASTEXITCODE -ne 0) {
  Write-Log "build failed with exit $LASTEXITCODE"
  exit $LASTEXITCODE
}

git add -- news.json
git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
  Write-Log "unchanged"
  exit 0
}

$env:GIT_AUTHOR_NAME = "Cursor Agent"
$env:GIT_AUTHOR_EMAIL = "cursoragent@cursor.com"
$env:GIT_COMMITTER_NAME = "Cursor Agent"
$env:GIT_COMMITTER_EMAIL = "cursoragent@cursor.com"
git commit -m "Refresh the Signal news snapshot."
if ($LASTEXITCODE -ne 0) {
  Write-Log "commit failed with exit $LASTEXITCODE"
  exit $LASTEXITCODE
}

$previous = ""
try { $previous = (gh api user --jq .login).Trim() } catch { $previous = "" }
gh auth switch --user ThinkInfoSec
if ($LASTEXITCODE -ne 0) {
  Write-Log "could not select the ThinkInfoSec login"
  exit $LASTEXITCODE
}

git push origin HEAD
$push = $LASTEXITCODE

if ($previous -and $previous -ne "ThinkInfoSec") {
  gh auth switch --user $previous | Out-Null
}

if ($push -ne 0) {
  Write-Log "push failed with exit $push"
  exit $push
}
Write-Log "published"
exit 0
