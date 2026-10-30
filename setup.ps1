param(
    [string]$RuntimePath = "",
    [string]$StateDirectory = (Join-Path $env:LOCALAPPDATA 'ZoteroCodexTranslate'),
    [switch]$InstallPlugin,
    [string]$ProfilePath = ""
)
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
$StateDirectory = (Resolve-Path -LiteralPath $StateDirectory).Path
if (-not $RuntimePath) { $RuntimePath = Join-Path $StateDirectory 'runtime' }
if (-not [System.IO.Path]::IsPathRooted($RuntimePath)) { $RuntimePath = Join-Path $taskRoot $RuntimePath }
$taskPython = Join-Path $RuntimePath 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) {
    if (Get-Command uv -ErrorAction SilentlyContinue) {
        & uv venv --python 3.12 $RuntimePath
    } else {
        & py -3.12 -m venv $RuntimePath
    }
    if ($LASTEXITCODE -ne 0) { throw 'Unable to create Python runtime. Install uv or Python 3.12, then retry.' }
}
$taskRequirements = Join-Path $taskRoot 'requirements-lock.txt'
if (-not (Test-Path -LiteralPath $taskRequirements)) { $taskRequirements = Join-Path $taskRoot 'requirements.txt' }
if (Get-Command uv -ErrorAction SilentlyContinue) {
    & uv pip install --python $taskPython -r $taskRequirements
} else {
    & $taskPython -m pip install -r $taskRequirements
}
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
& $taskPython -X utf8 -c 'import babeldoc.main; import pymupdf'
if ($LASTEXITCODE -ne 0) { throw 'BabelDOC failed to import; runtime configuration was not saved.' }
Write-Output 'BabelDOC imports OK'
$taskCodex = Get-Command codex.exe -ErrorAction SilentlyContinue
if (-not $taskCodex) { $taskCodex = Get-Command codex -ErrorAction SilentlyContinue }
$taskCodexPath = if ($taskCodex) { $taskCodex.Source } else { '' }
$taskConfig = @{ pythonPath = (Resolve-Path -LiteralPath $taskPython).Path; codexPath = $taskCodexPath }
$taskConfigPath = Join-Path $StateDirectory 'config.json'
if (Test-Path -LiteralPath $taskConfigPath) {
    $taskOldConfig = Get-Content -LiteralPath $taskConfigPath -Raw | ConvertFrom-Json
    if (-not $taskCodexPath -and $taskOldConfig.codexPath) { $taskConfig.codexPath = $taskOldConfig.codexPath }
    Copy-Item -LiteralPath $taskConfigPath -Destination ($taskConfigPath + '.bak') -Force
}
$taskConfig | ConvertTo-Json | Set-Content -LiteralPath $taskConfigPath -Encoding utf8
Write-Output ('Runtime ready: ' + $taskConfigPath)
Write-Output 'Choose Codex sign-in or an API connection in the plugin settings. Codex CLI is optional for API-only use.'

if ($InstallPlugin) {
    if (Get-Process zotero -ErrorAction SilentlyContinue) {
        throw 'Runtime ready. Close Zotero and rerun with -InstallPlugin to install the XPI.'
    }
    if (-not $ProfilePath) {
        $taskProfilesRoot = Join-Path $env:APPDATA 'Zotero\Zotero'
        $taskIni = Get-Content -LiteralPath (Join-Path $taskProfilesRoot 'profiles.ini') -Raw
        $taskSections = [regex]::Matches($taskIni, '(?ms)^\[Profile\d+\]\s*\r?\n(.*?)(?=^\[|\z)')
        $taskSelected = @($taskSections | Where-Object { $_.Groups[1].Value -match '(?m)^Default=1\s*$' })
        if (-not $taskSelected.Count -and $taskSections.Count -eq 1) { $taskSelected = @($taskSections[0]) }
        if ($taskSelected.Count -ne 1) { throw 'Cannot identify the default Zotero profile. Specify -ProfilePath.' }
        $taskBlock = $taskSelected[0].Groups[1].Value
        $taskProfileValue = [regex]::Match($taskBlock, '(?m)^Path=(.+?)\s*$').Groups[1].Value
        if ($taskBlock -match '(?m)^IsRelative=1\s*$') { $ProfilePath = Join-Path $taskProfilesRoot $taskProfileValue }
        else { $ProfilePath = $taskProfileValue }
    }
    $ProfilePath = (Resolve-Path -LiteralPath $ProfilePath).Path
    if (-not (Test-Path -LiteralPath (Join-Path $ProfilePath 'prefs.js'))) { throw 'Not a Zotero profile (prefs.js missing).' }
    $taskXpi = Join-Path $taskRoot 'zotero-codex-translate-0.4.0.xpi'
    if (-not (Test-Path -LiteralPath $taskXpi)) { $taskXpi = Join-Path $taskRoot 'dist\zotero-codex-translate-0.4.0.xpi' }
    if (-not (Test-Path -LiteralPath $taskXpi)) { throw 'XPI missing. Run scripts/build.py first.' }
    $taskExtensions = Join-Path $ProfilePath 'extensions'
    New-Item -ItemType Directory -Path $taskExtensions -Force | Out-Null
    $taskTarget = Join-Path $taskExtensions 'codex-pdf-translate@local.research.xpi'
    if (Test-Path -LiteralPath $taskTarget) {
        Copy-Item -LiteralPath $taskTarget -Destination (Join-Path $StateDirectory 'previous-plugin.xpi') -Force
    }
    Copy-Item -LiteralPath $taskXpi -Destination $taskTarget -Force
    $taskPrefsPath = Join-Path $ProfilePath 'prefs.js'
    Copy-Item -LiteralPath $taskPrefsPath -Destination (Join-Path $StateDirectory ('prefs-before-install-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.js'))
    $taskPrefs = Get-Content -LiteralPath $taskPrefsPath
    # Enable this newly copied extension for its first load, then its startup
    # immediately restores the previous automatic-disable preference.
    if (-not ($taskPrefs -match '^user_pref\("extensions\.zotero\.codexPDFTranslate\.restoreAutoDisableScopes"')) {
        $taskOldDisable = @($taskPrefs | Select-String '^user_pref\("extensions\.autoDisableScopes",\s*(\d+)\);')
        $taskRestore = @{ hadUserValue = ($taskOldDisable.Count -gt 0); value = 15 }
        if ($taskOldDisable.Count) { $taskRestore.value = [int]$taskOldDisable[0].Matches[0].Groups[1].Value }
        $taskRestoreJson = ConvertTo-Json -InputObject $taskRestore -Compress
        $taskPrefs += 'user_pref("extensions.zotero.codexPDFTranslate.restoreAutoDisableScopes", ' + (ConvertTo-Json -InputObject $taskRestoreJson -Compress) + ');'
    }
    $taskPrefs = @($taskPrefs | Where-Object { $_ -notmatch '^user_pref\("extensions\.autoDisableScopes"' })
    $taskPrefs += 'user_pref("extensions.autoDisableScopes", 0);'
    $taskPrefs = @($taskPrefs | Where-Object { $_ -notmatch '^user_pref\("extensions\.lastApp(BuildId|Version)"' })
    $taskPrefs = @($taskPrefs | Where-Object { $_ -notmatch '^user_pref\("extensions\.zotero\.codexPDFTranslate\.stateDir"' })
    $taskPrefs += 'user_pref("extensions.zotero.codexPDFTranslate.stateDir", ' + (ConvertTo-Json -InputObject $StateDirectory -Compress) + ');'
    $taskPrefs = @($taskPrefs | Where-Object { $_ -notmatch '^user_pref\("extensions\.zotero\.codexPDFTranslate\.installReport"' })
    $taskPrefs += 'user_pref("extensions.zotero.codexPDFTranslate.installReport", ' + (ConvertTo-Json -InputObject (Join-Path $StateDirectory 'startup.json') -Compress) + ');'
    $taskPrefs | Set-Content -LiteralPath $taskPrefsPath -Encoding utf8
    Write-Output ('Plugin installed: ' + $taskTarget)
    Write-Output 'Open Zotero. Use Tools > Codex PDF Translation > Settings, or right-click a PDF.'
} else {
    Write-Output 'Install the XPI from Zotero > Tools > Plugins > Install from File, or rerun with -InstallPlugin while Zotero is closed.'
}
