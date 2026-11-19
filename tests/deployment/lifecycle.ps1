param(
  [string]$Image = 'st-vault:local',
  [string]$ComposeFile = 'deploy/compose.yml'
)
$ErrorActionPreference = 'Stop'
function Invoke-Docker([string[]]$DockerArguments) {
  $output = & docker @DockerArguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw ($output -join "`n") }
  return ($output -join "`n")
}
$config = (Invoke-Docker @('compose', '--env-file', 'deploy/.env.example', '-f', $ComposeFile, 'config', '--format', 'json')) | ConvertFrom-Json
$service = $config.services.app
$container = 'st-vault-lifecycle-' + [guid]::NewGuid().ToString('N')
$owned = $false
try {
  $run = @('run', '-d', '--name', $container, '--network', 'none', '--user', $service.user)
  if ($service.init) { $run += '--init' }
  if ($service.read_only) { $run += '--read-only' }
  foreach ($capability in $service.cap_drop) { $run += @('--cap-drop', $capability) }
  foreach ($capability in $service.cap_add) { $run += @('--cap-add', $capability) }
  $run += @('--env', "STV_RUNTIME_UID=$($service.environment.STV_RUNTIME_UID)", '--env', "STV_RUNTIME_GID=$($service.environment.STV_RUNTIME_GID)")
  $program = 'process.setgid(Number(process.env.STV_RUNTIME_GID));process.setuid(Number(process.env.STV_RUNTIME_UID));process.on("SIGTERM",()=>{console.log("graceful_signal_received");process.exit(0)});console.log("signal_ready");setInterval(()=>{},1000)'
  $run += @('--entrypoint', 'node', $Image, '--input-type=module', '-e', $program)
  Invoke-Docker $run | Out-Null
  $owned = $true
  $ready = $false
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if ((Invoke-Docker @('logs', $container)).Contains('signal_ready')) { $ready = $true; break }
    Start-Sleep -Milliseconds 100
  }
  if (-not $ready) { throw 'Lifecycle fixture did not initialize' }
  Invoke-Docker @('stop', '--timeout', '5', $container) | Out-Null
  $log = Invoke-Docker @('logs', $container)
  $exitCode = Invoke-Docker @('inspect', '--format', '{{.State.ExitCode}}', $container)
  if ($exitCode.Trim() -ne '0' -or -not $log.Contains('graceful_signal_received')) {
    throw "Shutdown was not graceful (exit=$exitCode): $log"
  }
  Write-Output 'Container lifecycle passed: actual Compose privileges deliver SIGTERM after UID/GID transition.'
} finally {
  if ($owned) { Invoke-Docker @('rm', '--force', $container) | Out-Null }
}
# Exercise the actual supervisor, NSS wrapper and embedded database, using only
# disposable named volumes. No production bind mount or host port is involved.
function Assert-RuntimeReady([string]$Name) {
  for ($attempt = 0; $attempt -lt 240; $attempt++) {
    & docker exec $Name node -e 'fetch("http://127.0.0.1:10002/health/ready",{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { return }
    if ((Invoke-Docker @('inspect', '--format', '{{.State.Running}}', $Name)).Trim() -ne 'true') { break }
    Start-Sleep -Milliseconds 250
  }
  throw "Embedded PostgreSQL fixture did not initialize: $(Invoke-Docker @('logs', $Name))"
}
foreach ($mode in @('graceful', 'database-failure')) {
  $container = 'st-vault-postgres-lifecycle-' + [guid]::NewGuid().ToString('N')
  $owned = $false
  $ownedVolumes = @()
  try {
    $dataVolume = 'st-vault-lifecycle-data-' + [guid]::NewGuid().ToString('N')
    $mediaVolume = 'st-vault-lifecycle-media-' + [guid]::NewGuid().ToString('N')
    foreach ($volume in @($dataVolume, $mediaVolume)) {
      Invoke-Docker @('volume', 'create', '--label', 'io.st-vault.test=lifecycle', $volume) | Out-Null
      $ownedVolumes += $volume
    }
    $run = @('run', '-d', '--name', $container, '--network', 'none', '--user', $service.user)
    if ($service.init) { $run += '--init' }
    if ($service.read_only) { $run += '--read-only' }
    foreach ($capability in $service.cap_drop) { $run += @('--cap-drop', $capability) }
    foreach ($capability in $service.cap_add) { $run += @('--cap-add', $capability) }
    $run += @('--security-opt', 'no-new-privileges:true', '--memory', '2g', '--cpus', '2', '--shm-size', '128m',
      '--mount', "type=volume,source=$dataVolume,target=/data", '--mount', "type=volume,source=$mediaVolume,target=/media",
      '--tmpfs', '/tmp:rw,size=256m,mode=1777', '--env', 'STV_RUNTIME_UID=12345', '--env', 'STV_RUNTIME_GID=23456', $Image)
    Invoke-Docker $run | Out-Null
    $owned = $true
    Assert-RuntimeReady $container
    if ($mode -eq 'graceful') {
      Invoke-Docker @('stop', '--timeout', '180', $container) | Out-Null
      $exitCode = (Invoke-Docker @('inspect', '--format', '{{.State.ExitCode}}', $container)).Trim()
      $log = Invoke-Docker @('logs', $container)
      if ($exitCode -ne '0' -or -not $log.Contains('database system is shut down')) {
        throw "Embedded PostgreSQL shutdown was not graceful (exit=$exitCode): $log"
      }
      Invoke-Docker @('start', $container) | Out-Null
      Assert-RuntimeReady $container
      Invoke-Docker @('stop', '--timeout', '180', $container) | Out-Null
      if ((Invoke-Docker @('inspect', '--format', '{{.State.ExitCode}}', $container)).Trim() -ne '0') {
        throw "Warm database shutdown failed: $(Invoke-Docker @('logs', $container))"
      }
    } else {
      Invoke-Docker @('exec', $container, 'node', '-e', 'const fs=require("node:fs");process.kill(Number(fs.readFileSync("/data/postgres/18/postmaster.pid","utf8").split("\n")[0]),"SIGKILL")') | Out-Null
      for ($attempt = 0; $attempt -lt 140; $attempt++) {
        if ((Invoke-Docker @('inspect', '--format', '{{.State.Running}}', $container)).Trim() -eq 'false') { break }
        Start-Sleep -Milliseconds 500
      }
      $running = (Invoke-Docker @('inspect', '--format', '{{.State.Running}}', $container)).Trim()
      $exitCode = (Invoke-Docker @('inspect', '--format', '{{.State.ExitCode}}', $container)).Trim()
      $log = Invoke-Docker @('logs', $container)
      if ($running -ne 'false' -or $exitCode -eq '0' -or -not $log.Contains('embedded_database_exited')) {
        throw "Database failure did not stop the application (running=$running, exit=$exitCode): $log"
      }
      Invoke-Docker @('start', $container) | Out-Null
      Assert-RuntimeReady $container
      Invoke-Docker @('stop', '--timeout', '180', $container) | Out-Null
      if ((Invoke-Docker @('inspect', '--format', '{{.State.ExitCode}}', $container)).Trim() -ne '0') {
        throw "Crash recovery shutdown failed: $(Invoke-Docker @('logs', $container))"
      }
    }
    Write-Output "Embedded PostgreSQL lifecycle passed: $mode, arbitrary UID/GID, read-only root filesystem."
  } finally {
    if ($owned) { Invoke-Docker @('rm', '--force', $container) | Out-Null }
    foreach ($volume in $ownedVolumes) { Invoke-Docker @('volume', 'rm', $volume) | Out-Null }
  }
}
