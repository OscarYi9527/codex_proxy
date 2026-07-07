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
                "-c", "model=\"deepseek-v4-pro\"",
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
    $legacyDeepseekModel = 'o=o.some(e=>e.model===`deepseek-v4-pro`)?o:[{id:`deepseek-v4-pro`,model:`deepseek-v4-pro`,displayName:`DeepSeek V4 Pro`,description:`DeepSeek through the local Responses proxy`,hidden:!1,isDefault:!1,defaultReasoningEffort:`high`,supportedReasoningEfforts:[{reasoningEffort:`low`,description:`Faster responses`},{reasoningEffort:`medium`,description:`Balanced reasoning`},{reasoningEffort:`high`,description:`Deeper reasoning`}],inputModalities:[`text`],additionalSpeedTiers:[],serviceTiers:[],defaultServiceTier:null,availabilityNux:null,supportsPersonality:!1,upgrade:null},...o];n&&typeof n.add===`function`&&n.add(`deepseek-v4-pro`);let c=[]'
    $customModels = 'for(const l of [{id:`deepseek-v4-pro`,model:`deepseek-v4-pro`,displayName:`DeepSeek V4 Pro`,description:`DeepSeek through the local Responses proxy`,hidden:!1,isDefault:!1,defaultReasoningEffort:`high`,supportedReasoningEfforts:[{reasoningEffort:`low`,description:`Faster responses`},{reasoningEffort:`medium`,description:`Balanced reasoning`},{reasoningEffort:`high`,description:`Deeper reasoning`}],inputModalities:[`text`],additionalSpeedTiers:[],serviceTiers:[],defaultServiceTier:null,availabilityNux:null,supportsPersonality:!1,upgrade:null},{id:`gpt-5.5-api`,model:`gpt-5.5-api`,displayName:`GPT-5.5-API`,description:`OpenAI API route for GPT-5.5 through the local proxy.`,hidden:!1,isDefault:!1,defaultReasoningEffort:`medium`,supportedReasoningEfforts:[{reasoningEffort:`low`,description:`Fast responses with lighter reasoning`},{reasoningEffort:`medium`,description:`Balanced speed and reasoning`},{reasoningEffort:`high`,description:`Greater reasoning depth`},{reasoningEffort:`xhigh`,description:`Maximum reasoning depth`}],inputModalities:[`text`,`image`],additionalSpeedTiers:[],serviceTiers:[],defaultServiceTier:null,availabilityNux:null,supportsPersonality:!1,upgrade:null},{id:`gpt-5.4-api`,model:`gpt-5.4-api`,displayName:`GPT-5.4-API`,description:`OpenAI API route for GPT-5.4 through the local proxy.`,hidden:!1,isDefault:!1,defaultReasoningEffort:`medium`,supportedReasoningEfforts:[{reasoningEffort:`low`,description:`Fast responses with lighter reasoning`},{reasoningEffort:`medium`,description:`Balanced speed and reasoning`},{reasoningEffort:`high`,description:`Greater reasoning depth`},{reasoningEffort:`xhigh`,description:`Maximum reasoning depth`}],inputModalities:[`text`,`image`],additionalSpeedTiers:[],serviceTiers:[],defaultServiceTier:null,availabilityNux:null,supportsPersonality:!1,upgrade:null},{id:`gpt-5.4-api-mini`,model:`gpt-5.4-api-mini`,displayName:`GPT-5.4-API Mini`,description:`OpenAI API route for GPT-5.4 Mini through the local proxy.`,hidden:!1,isDefault:!1,defaultReasoningEffort:`medium`,supportedReasoningEfforts:[{reasoningEffort:`low`,description:`Fast responses with lighter reasoning`},{reasoningEffort:`medium`,description:`Balanced speed and reasoning`},{reasoningEffort:`high`,description:`Greater reasoning depth`},{reasoningEffort:`xhigh`,description:`Maximum reasoning depth`}],inputModalities:[`text`,`image`],additionalSpeedTiers:[],serviceTiers:[],defaultServiceTier:null,availabilityNux:null,supportsPersonality:!1,upgrade:null}]){o=o.some(e=>e.model===l.model)?o:[l,...o];n&&typeof n.add===`function`&&n.add(l.model)}let c=[]'

    foreach ($assetFile in $assetFiles) {
        $text = [IO.File]::ReadAllText($assetFile.FullName)
        if ($text.Contains('gpt-5.5-api')) {
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

    try {
        $settings = $settingsText | ConvertFrom-Json
    } catch {
        throw "VS Code settings are not plain JSON. Set chatgpt.cliExecutable manually to: $launcherPath"
    }

    if ($null -eq $settings) {
        $settings = [pscustomobject]@{}
    }

    $settings | Add-Member -NotePropertyName 'chatgpt.cliExecutable' -NotePropertyValue $launcherPath -Force
    $json = $settings | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText($VSCodeSettingsPath, $json + "`r`n", [Text.UTF8Encoding]::new($false))
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
