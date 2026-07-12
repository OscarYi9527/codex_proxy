param(
    [string]$InstallDir = $PSScriptRoot,
    [string]$VSCodeSettingsPath = (Join-Path $env:APPDATA 'Code\User\settings.json'),
    [switch]$UpdateSettings,
    [switch]$PatchWebview
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
    Write-Host "[vscode-compat] $Message"
}

function Ensure-Directory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Set-JsonObjectPropertyText([string]$Text, [string]$Key, [string]$JsonValue) {
    $newline = if ($Text.Contains("`r`n")) { "`r`n" } else { "`n" }
    if ([string]::IsNullOrWhiteSpace($Text)) {
        return "{$newline  `"$Key`": $JsonValue$newline}$newline"
    }

    $pattern = '(?m)^(\s*)"' + [regex]::Escape($Key) + '"\s*:\s*("[^"\\]*(?:\\.[^"\\]*)*"|[^,\r\n]*)(\s*,?)'
    if ([regex]::IsMatch($Text, $pattern)) {
        $evaluator = [System.Text.RegularExpressions.MatchEvaluator]{
            param($match)
            return $match.Groups[1].Value + '"' + $Key + '": ' + $JsonValue + $match.Groups[3].Value
        }
        return [regex]::Replace($Text, $pattern, $evaluator, 1)
    }

    $close = $Text.LastIndexOf('}')
    if ($close -lt 0) {
        throw "VS Code settings.json is not a JSON object. Set chatgpt.cliExecutable manually to: $launcherPath"
    }

    $before = $Text.Substring(0, $close).TrimEnd()
    $after = $Text.Substring($close).TrimStart()
    if ($before -notmatch '^\s*\{\s*$' -and $before -notmatch ',\s*$') {
        $before += ','
    }
    return $before + $newline + '  "' + $Key + '": ' + $JsonValue + $newline + $after.TrimEnd() + $newline
}

$launcherPath = Join-Path $InstallDir 'codex-vscode-launcher.exe'
$catalogPath = Join-Path $InstallDir 'codex-models.json'

if (-not (Test-Path -LiteralPath $catalogPath)) {
    throw "Missing model catalog: $catalogPath"
}

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;

public static class CodexVSCodeLauncher
{
    public static int Main(string[] args)
    {
        try
        {
            string launcherPath = Process.GetCurrentProcess().MainModule.FileName;
            string launcherDir = Path.GetDirectoryName(launcherPath);
            string catalog = Path.Combine(launcherDir, "codex-models.json");
            string realCodex = FindRealCodex(launcherPath);

            var forwarded = new List<string>
            {
                "-c", "model=\"gpt-5.6-sol\"",
                "-c", "model_provider=\"local_multi_proxy\"",
                "-c", "model_providers.local_multi_proxy.name=\"Local Multi-Upstream Proxy\"",
                "-c", "model_providers.local_multi_proxy.base_url=\"http://localhost:47892/v1\"",
                "-c", "model_providers.local_multi_proxy.wire_api=\"responses\"",
                "-c", "model_providers.local_multi_proxy.requires_openai_auth=true",
                "-c", "model_catalog_json='" + catalog + "'"
            };
            forwarded.AddRange(args);

            var psi = new ProcessStartInfo
            {
                FileName = realCodex,
                Arguments = JoinArguments(forwarded),
                UseShellExecute = false
            };

            var child = Process.Start(psi);
            child.WaitForExit();
            return child.ExitCode;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[codex-vscode-launcher] " + ex.Message);
            return 1;
        }
    }

    private static string FindRealCodex(string launcherPath)
    {
        var candidates = new List<string>();
        AddCandidate(candidates, Environment.GetEnvironmentVariable("CODEX_VSCODE_REAL_CODEX_EXE"));

        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

        AddNewestMatches(candidates, Path.Combine(localAppData, "OpenAI", "Codex", "bin"), "codex.exe");
        AddNewestMatches(candidates, Path.Combine(userProfile, ".vscode", "extensions"), @"openai.chatgpt-*-win32-x64\bin\windows-x86_64\codex.exe");

        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in path.Split(Path.PathSeparator))
        {
            if (String.IsNullOrWhiteSpace(dir)) continue;
            AddCandidate(candidates, Path.Combine(dir.Trim('"'), "codex.exe"));
        }

        string launcherFullPath = Path.GetFullPath(launcherPath);
        foreach (var candidate in candidates)
        {
            try
            {
                if (!File.Exists(candidate)) continue;
                string full = Path.GetFullPath(candidate);
                if (String.Equals(full, launcherFullPath, StringComparison.OrdinalIgnoreCase)) continue;
                return full;
            }
            catch
            {
            }
        }

        throw new FileNotFoundException("Could not find a real codex.exe. Set CODEX_VSCODE_REAL_CODEX_EXE to the bundled or desktop Codex executable.");
    }

    private static void AddCandidate(List<string> candidates, string candidate)
    {
        if (!String.IsNullOrWhiteSpace(candidate))
        {
            candidates.Add(candidate);
        }
    }

    private static void AddNewestMatches(List<string> candidates, string root, string pattern)
    {
        try
        {
            if (!Directory.Exists(root)) return;
            foreach (var file in Directory.GetFiles(root, pattern, SearchOption.AllDirectories)
                .OrderByDescending(File.GetLastWriteTimeUtc))
            {
                candidates.Add(file);
            }
        }
        catch
        {
        }
    }

    private static string JoinArguments(IEnumerable<string> args)
    {
        return String.Join(" ", args.Select(QuoteArgument));
    }

    private static string QuoteArgument(string arg)
    {
        if (arg == null) return "\"\"";
        if (arg.Length == 0) return "\"\"";
        if (arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;

        var result = new StringBuilder();
        result.Append('"');
        int backslashes = 0;
        foreach (char c in arg)
        {
            if (c == '\\')
            {
                backslashes++;
            }
            else if (c == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
            }
            else
            {
                result.Append('\\', backslashes);
                backslashes = 0;
                result.Append(c);
            }
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }
}
'@

Ensure-Directory $InstallDir
try {
    Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $launcherPath -OutputType ConsoleApplication
    Write-Step "created launcher: $launcherPath"
} catch {
    if (Test-Path -LiteralPath $launcherPath) {
        Write-Warning "launcher is already present and may be running; keeping existing launcher: $launcherPath"
    } else {
        throw
    }
}

if ($PatchWebview) {
    $extensionRoot = Join-Path $HOME '.vscode\extensions'
    $assetFiles = @(Get-ChildItem -LiteralPath $extensionRoot -Recurse -Filter 'model-list-filter-*.js' -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\openai\.chatgpt-[^\\]+\\webview\\assets\\model-list-filter-' })

    if ($assetFiles.Count -eq 0) {
        Write-Warning 'Could not find VS Code Codex model-list-filter asset.'
    }

    $needle = 'function t({authMethod:t,availableModels:n,defaultModel:r,enabledReasoningEfforts:i,includeUltraReasoningEffort:a,models:o,useHiddenModels:s}){let c=[]'
    $legacyDeepseekModel = 'o=o.some(e=>e.model===`deepseek-v4-pro`)?o:[{id:`deepseek-v4-pro`,model:`deepseek-v4-pro`,displayName:`DeepSeek V4 Pro`,description:`DeepSeek V4 Pro via Anthropic API`,hidden:!1,isDefault:!1,defaultReasoningEffort:`high`,supportedReasoningEfforts:[{reasoningEffort:`low`,description:`Faster responses`},{reasoningEffort:`medium`,description:`Balanced reasoning`},{reasoningEffort:`high`,description:`Deeper reasoning`}],inputModalities:[`text`],additionalSpeedTiers:[],serviceTiers:[],defaultServiceTier:null,availabilityNux:null,supportsPersonality:!1,upgrade:null},...o];n&&typeof n.add===`function`&&n.add(`deepseek-v4-pro`);let c=[]'
    $customModels = 'for(const l of [{id:`deepseek-v4-pro`,model:`deepseek-v4-pro`,displayName:`DeepSeek V4 Pro`,description:`DeepSeek V4 Pro via Anthropic API`,hidden:!1,isDefault:!1,defaultReasoningEffort:`high`,supportedReasoningEfforts:[{reasoningEffort:`low`,description:`Faster responses`},{reasoningEffort:`medium`,description:`Balanced reasoning`},{reasoningEffort:`high`,description:`Deeper reasoning`}],inputModalities:[`text`],additionalSpeedTiers:[],serviceTiers:[],defaultServiceTier:null,availabilityNux:null,supportsPersonality:!1,upgrade:null},{id:`gpt-5.5`,model:`gpt-5.5`,displayName:`GPT-5.5 (订阅)`,description:`GPT-5.5 via ChatGPT subscription`,hidden:!1,isDefault:!1,defaultReasoningEffort:`medium`,supportedReasoningEfforts:[{reasoningEffort:`low`,description:`Fast responses with lighter reasoning`},{reasoningEffort:`medium`,description:`Balanced speed and reasoning`},{reasoningEffort:`high`,description:`Greater reasoning depth`},{reasoningEffort:`xhigh`,description:`Maximum reasoning depth`}],inputModalities:[`text`,`image`],additionalSpeedTiers:[],serviceTiers:[],defaultServiceTier:null,availabilityNux:null,supportsPersonality:!1,upgrade:null},{id:`gpt-5.4`,model:`gpt-5.4`,displayName:`GPT-5.4 (订阅)`,description:`GPT-5.4 via ChatGPT subscription`,hidden:!1,isDefault:!1,defaultReasoningEffort:`medium`,supportedReasoningEfforts:[{reasoningEffort:`low`,description:`Fast responses with lighter reasoning`},{reasoningEffort:`medium`,description:`Balanced speed and reasoning`},{reasoningEffort:`high`,description:`Greater reasoning depth`},{reasoningEffort:`xhigh`,description:`Maximum reasoning depth`}],inputModalities:[`text`,`image`],additionalSpeedTiers:[],serviceTiers:[],defaultServiceTier:null,availabilityNux:null,supportsPersonality:!1,upgrade:null},{id:`gpt-5.4-mini`,model:`gpt-5.4-mini`,displayName:`GPT-5.4 Mini (订阅)`,description:`GPT-5.4 Mini via ChatGPT subscription`,hidden:!1,isDefault:!1,defaultReasoningEffort:`medium`,supportedReasoningEfforts:[{reasoningEffort:`low`,description:`Fast responses with lighter reasoning`},{reasoningEffort:`medium`,description:`Balanced speed and reasoning`},{reasoningEffort:`high`,description:`Greater reasoning depth`},{reasoningEffort:`xhigh`,description:`Maximum reasoning depth`}],inputModalities:[`text`,`image`],additionalSpeedTiers:[],serviceTiers:[],defaultServiceTier:null,availabilityNux:null,supportsPersonality:!1,upgrade:null},{id:`openai-api-gpt-5.5`,model:`openai-api-gpt-5.5`,displayName:`GPT-5.5 (API Key)`,description:`GPT-5.5 via OpenAI API (requires API key)`,hidden:!1,isDefault:!1,defaultReasoningEffort:`medium`,supportedReasoningEfforts:[{reasoningEffort:`low`,description:`Fast responses with lighter reasoning`},{reasoningEffort:`medium`,description:`Balanced speed and reasoning`},{reasoningEffort:`high`,description:`Greater reasoning depth`},{reasoningEffort:`xhigh`,description:`Maximum reasoning depth`}],inputModalities:[`text`,`image`],additionalSpeedTiers:[],serviceTiers:[],defaultServiceTier:null,availabilityNux:null,supportsPersonality:!1,upgrade:null},{id:`openai-api-gpt-5.4`,model:`openai-api-gpt-5.4`,displayName:`GPT-5.4 (API Key)`,description:`GPT-5.4 via OpenAI API (requires API key)`,hidden:!1,isDefault:!1,defaultReasoningEffort:`medium`,supportedReasoningEfforts:[{reasoningEffort:`low`,description:`Fast responses with lighter reasoning`},{reasoningEffort:`medium`,description:`Balanced speed and reasoning`},{reasoningEffort:`high`,description:`Greater reasoning depth`},{reasoningEffort:`xhigh`,description:`Maximum reasoning depth`}],inputModalities:[`text`,`image`],additionalSpeedTiers:[],serviceTiers:[],defaultServiceTier:null,availabilityNux:null,supportsPersonality:!1,upgrade:null},{id:`openai-api-gpt-5.4-mini`,model:`openai-api-gpt-5.4-mini`,displayName:`GPT-5.4 Mini (API Key)`,description:`GPT-5.4 Mini via OpenAI API (requires API key)`,hidden:!1,isDefault:!1,defaultReasoningEffort:`medium`,supportedReasoningEfforts:[{reasoningEffort:`low`,description:`Fast responses with lighter reasoning`},{reasoningEffort:`medium`,description:`Balanced speed and reasoning`},{reasoningEffort:`high`,description:`Greater reasoning depth`},{reasoningEffort:`xhigh`,description:`Maximum reasoning depth`}],inputModalities:[`text`,`image`],additionalSpeedTiers:[],serviceTiers:[],defaultServiceTier:null,availabilityNux:null,supportsPersonality:!1,upgrade:null}]){o=o.some(e=>e.model===l.model)?o:[l,...o];n&&typeof n.add===`function`&&n.add(l.model)}let c=[]'

    foreach ($assetFile in $assetFiles) {
        $text = [IO.File]::ReadAllText($assetFile.FullName)
        if ($text.Contains('GPT-5.5 (API Key)')) {
            Write-Step "already patched: $($assetFile.FullName)"
            continue
        }
        if ($text.Contains($legacyDeepseekModel)) {
            $patched = $text.Replace($legacyDeepseekModel, $customModels)
        } elseif ($text.Contains($needle)) {
            $patched = $text.Replace($needle, $needle.Replace('let c=[]', $customModels))
        } else {
            Write-Warning "Could not patch unexpected asset format: $($assetFile.FullName)"
            continue
        }

        $backupPath = "$($assetFile.FullName).local-proxy.bak"
        if (-not (Test-Path -LiteralPath $backupPath)) {
            Copy-Item -LiteralPath $assetFile.FullName -Destination $backupPath -Force
        }
        [IO.File]::WriteAllText($assetFile.FullName, $patched, [Text.UTF8Encoding]::new($false))
        Write-Step "patched webview model list: $($assetFile.FullName)"
    }
}

if ($UpdateSettings) {
    Ensure-Directory (Split-Path -Parent $VSCodeSettingsPath)
    $settingsText = if (Test-Path -LiteralPath $VSCodeSettingsPath) {
        [IO.File]::ReadAllText($VSCodeSettingsPath)
    } else {
        '{}'
    }

    $launcherJson = $launcherPath | ConvertTo-Json -Compress
    $json = Set-JsonObjectPropertyText $settingsText 'chatgpt.cliExecutable' $launcherJson
    if ((Test-Path -LiteralPath $VSCodeSettingsPath) -and $settingsText -ne $json) {
        $backupPath = "$VSCodeSettingsPath.codex-local-proxy.bak"
        if (-not (Test-Path -LiteralPath $backupPath)) {
            Copy-Item -LiteralPath $VSCodeSettingsPath -Destination $backupPath -Force
        }
    }
    [IO.File]::WriteAllText($VSCodeSettingsPath, $json, [Text.UTF8Encoding]::new($false))
    Write-Step "updated VS Code setting chatgpt.cliExecutable"
}

Write-Host ""
Write-Host "Next step:"
if ($UpdateSettings) {
    Write-Host "  Reload VS Code window."
} else {
    Write-Host "  Set VS Code setting chatgpt.cliExecutable to:"
    Write-Host "  $launcherPath"
}
