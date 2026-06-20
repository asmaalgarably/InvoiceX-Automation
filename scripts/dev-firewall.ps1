param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet("open", "close", "status", "session")]
  [string]$Action,

  [int]$Port = 5173,

  [int]$MaxMinutes = 30,

  [switch]$NoElevate
)

$ErrorActionPreference = "Stop"

$ruleName = "QoyodInvoiceIntakeDev-$Port"
$displayName = "Qoyod Invoice Intake dev port $Port (temporary)"

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-Rule {
  $rule = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
  if ($rule) { return $rule }
  Get-NetFirewallRule -DisplayName $displayName -ErrorAction SilentlyContinue
}

function Open-TemporaryRule {
  $existing = Get-Rule
  if ($existing) {
    Set-NetFirewallRule -DisplayName $displayName -Enabled True -Profile Private | Out-Null
    Write-Host "Firewall rule already exists and is enabled: $displayName"
    return
  }

  New-NetFirewallRule `
    -Name $ruleName `
    -DisplayName $displayName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $Port `
    -Profile Private `
    -RemoteAddress LocalSubnet `
    -Description "Temporary local-network access for Qoyod Invoice Intake dev server. Remove with scripts/dev-firewall.ps1 close." `
    | Out-Null

  Write-Host "Opened TCP port $Port for Private network / LocalSubnet only."
}

function Close-TemporaryRule {
  $existing = Get-Rule
  if ($existing) {
    Remove-NetFirewallRule -DisplayName $displayName
    Write-Host "Closed and removed temporary firewall rule for TCP port $Port."
    return
  }

  $netshOutput = & netsh advfirewall firewall delete rule name="$displayName" 2>&1
  if (($netshOutput -join "`n") -match "Deleted 1 rule") {
    Write-Host "Closed and removed temporary firewall rule for TCP port $Port."
    return
  }

  Write-Host "No temporary firewall rule found for TCP port $Port."
}

function Get-LocalUrls {
  Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
      $_.IPAddress -notlike "127.*" `
        -and $_.IPAddress -notlike "169.254.*" `
        -and $_.PrefixOrigin -ne "WellKnown"
    } |
    ForEach-Object { "http://$($_.IPAddress):$Port/" }
}

function Start-CleanupWatcher {
  $escapedDisplayName = $displayName.Replace("'", "''")
  $watchCommand = @"
`$parentPid = $PID
`$displayName = '$escapedDisplayName'
while (Get-Process -Id `$parentPid -ErrorAction SilentlyContinue) {
  Start-Sleep -Seconds 2
}
netsh advfirewall firewall delete rule name="`$displayName" | Out-Null
"@

  Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $watchCommand) `
    -WindowStyle Hidden `
    | Out-Null
}

if ($Action -ne "status" -and -not (Test-Admin)) {
  if ($NoElevate) {
    throw "Administrator privileges are required to change Windows Firewall rules."
  }

  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "`"$PSCommandPath`"",
    $Action,
    "-Port",
    "$Port",
    "-MaxMinutes",
    "$MaxMinutes",
    "-NoElevate"
  )
  Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $arguments -Wait
  exit
}

switch ($Action) {
  "open" {
    Open-TemporaryRule
  }

  "close" {
    Close-TemporaryRule
  }

  "status" {
    $netshOutput = & netsh advfirewall firewall show rule name="$displayName" 2>&1
    if ($LASTEXITCODE -eq 0 -and -not (($netshOutput -join "`n") -match "No rules match")) {
      $netshOutput
      break
    }

    $existing = Get-Rule
    if (-not $existing) {
      Write-Host "Closed: no temporary firewall rule exists for TCP port $Port."
      break
    }

    $portFilter = $existing | Get-NetFirewallPortFilter
    $addressFilter = $existing | Get-NetFirewallAddressFilter
    [PSCustomObject]@{
      Name = $existing.Name
      DisplayName = $existing.DisplayName
      Enabled = $existing.Enabled
      Profile = $existing.Profile
      Direction = $existing.Direction
      Action = $existing.Action
      Protocol = $portFilter.Protocol
      LocalPort = $portFilter.LocalPort
      RemoteAddress = $addressFilter.RemoteAddress
    } | Format-List
  }

  "session" {
    Start-CleanupWatcher
    Open-TemporaryRule

    try {
      Clear-Host
      Write-Host "Qoyod Invoice Intake temporary phone test" -ForegroundColor Cyan
      Write-Host ""
      Write-Host "Port open: TCP $Port"
      Write-Host "Scope: Private network / LocalSubnet only"
      Write-Host "Auto-timeout: $MaxMinutes minute(s)"
      Write-Host ""
      Write-Host "Open one of these URLs on your phone:"
      Get-LocalUrls | ForEach-Object { Write-Host "  $_" -ForegroundColor Green }
      Write-Host ""
      Write-Host "Leave this window open while testing."
      Write-Host "Press Enter to close the port and exit."
      Write-Host ""

      $deadline = (Get-Date).AddMinutes([Math]::Max(1, $MaxMinutes))
      while ((Get-Date) -lt $deadline) {
        if ([Console]::KeyAvailable) {
          $key = [Console]::ReadKey($true)
          if ($key.Key -eq "Enter") { break }
        }
        Start-Sleep -Milliseconds 250
      }
    } finally {
      Close-TemporaryRule
      Write-Host ""
      Write-Host "Port $Port is closed. You can close this window now." -ForegroundColor Cyan
      Start-Sleep -Seconds 3
    }
  }
}
