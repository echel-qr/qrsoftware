$ErrorActionPreference = 'Stop'
try {
    Write-Host 'Echel Agent - Server Setup'
    Write-Host 'Enter the HTTPS website origin only, for example https://your-service.onrender.com'
    $echelInput = (Read-Host 'Echel website URL').Trim()
    $echelUri = $null
    if (-not [Uri]::TryCreate($echelInput, [UriKind]::Absolute, [ref]$echelUri)) {
        throw 'Enter a valid absolute HTTPS URL.'
    }
    if ($echelUri.Scheme -ne 'https' -or -not $echelUri.Host -or $echelUri.UserInfo -or
        $echelUri.Query -or $echelUri.Fragment -or $echelUri.AbsolutePath -ne '/') {
        throw 'Use an HTTPS website origin without a page path, query, fragment, or credentials.'
    }
    $echelConfigPath = Join-Path $PSScriptRoot 'echel-server.json'
    $echelJson = @{ serverUrl = $echelUri.GetLeftPart([UriPartial]::Authority) } | ConvertTo-Json
    [IO.File]::WriteAllText($echelConfigPath, $echelJson, [Text.UTF8Encoding]::new($false))
    Write-Host 'Saved echel-server.json next to this helper.'
    if ($env:ECHEL_SERVER_URL) {
        Write-Warning 'ECHEL_SERVER_URL is already set and overrides this file. Update or remove that override before starting the Agent.'
    }
    Write-Host 'Exit the old Agent, then open Echel-Agent-V2.exe from this same folder.'
    exit 0
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
