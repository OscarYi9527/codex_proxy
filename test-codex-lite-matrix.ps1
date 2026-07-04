$ErrorActionPreference = 'Stop'

$codex = 'C:\Users\Oscar\AppData\Roaming\npm\codex.cmd'
$baseCatalogPath = 'C:\Users\Oscar\.claude\proxy\codex-models.json'
$workRoot = 'C:\Users\Oscar'
$tempRoot = Join-Path $env:TEMP ('codex-lite-matrix-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

$models = @('gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini')
$lites = @($true, $false)
$results = @()

function Quote-Arg([string]$Value) {
    return '"' + ($Value -replace '"', '\"') + '"'
}

function Write-TestCatalog([string]$Model, [bool]$Lite, [string]$Path) {
    $copy = Get-Content -Raw $baseCatalogPath | ConvertFrom-Json
    foreach ($m in @($copy.models)) {
        $m.use_responses_lite = $false
        if ($m.slug -eq $Model) {
            $m.use_responses_lite = $Lite
        }
    }
    $json = $copy | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Invoke-CodexLiteTest([string]$Model, [bool]$Lite) {
    $name = ($Model + '-' + ($(if ($Lite) { 'lite-true' } else { 'lite-false' }))).Replace('.', '_')
    $catalog = Join-Path $tempRoot ($name + '.models.json')
    $stdout = Join-Path $tempRoot ($name + '.stdout.jsonl')
    $stderr = Join-Path $tempRoot ($name + '.stderr.txt')
    $last = Join-Path $tempRoot ($name + '.last.txt')
    Write-TestCatalog $Model $Lite $catalog

    $argList = @(
        'exec', '--json', '--ephemeral', '--skip-git-repo-check',
        '-C', $workRoot,
        '-m', $Model,
        '-c', ('model_catalog_json=''{0}''' -f $catalog),
        '-o', $last,
        'Respond exactly OK. Do not use tools.'
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $codex
    $psi.Arguments = (($argList | ForEach-Object { Quote-Arg $_ }) -join ' ')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true

    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $psi
    [void]$p.Start()
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    $finished = $p.WaitForExit(120000)

    if (-not $finished) {
        try { $p.Kill() } catch {}
        $status = 'timeout'
        $exit = $null
    } else {
        $status = if ($p.ExitCode -eq 0) { 'ok' } else { 'failed' }
        $exit = $p.ExitCode
    }

    $out = $outTask.Result
    $err = $errTask.Result
    Set-Content -LiteralPath $stdout -Value $out -Encoding UTF8
    Set-Content -LiteralPath $stderr -Value $err -Encoding UTF8
    $lastText = if (Test-Path -LiteralPath $last) { Get-Content -Raw -LiteralPath $last } else { '' }
    $combined = ($out + "`n" + $err + "`n" + $lastText)

    [pscustomobject]@{
        model = $Model
        use_responses_lite = $Lite
        status = $status
        exit_code = $exit
        lite_unsupported = ($combined -match 'X-OpenAI-Internal-Codex-Responses-Lite|Responses-Lite|not supported when using')
        capacity_or_quota = ($combined -match 'capacity|rate_limit|quota')
        auth_error = ($combined -match 'auth|unauthorized|forbidden|invalid_api_key|401|403')
        access_denied = ($combined -match '拒绝访问|os error 5|Access is denied')
        last_message = ($lastText.Trim() -replace "\r?\n", ' ')
        stderr_tail = ((($err -split "\r?\n") | Select-Object -Last 8) -join ' | ')
        stdout = $stdout
        stderr = $stderr
        catalog = $catalog
    }
}

foreach ($model in $models) {
    foreach ($lite in $lites) {
        Write-Host "RUN $model lite=$lite"
        $r = Invoke-CodexLiteTest $model $lite
        $results += $r
        $r | ConvertTo-Json -Depth 5
    }
}

$summary = Join-Path $tempRoot 'summary.json'
[System.IO.File]::WriteAllText($summary, ($results | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))
Write-Host "SUMMARY=$summary"
$results | Format-Table model, use_responses_lite, status, exit_code, lite_unsupported, capacity_or_quota, auth_error, access_denied, last_message -AutoSize
