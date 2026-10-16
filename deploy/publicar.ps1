<#
  Publica UN Code Sala en Azure App Service SIN compilar en el servidor.

  El plan B1 tiene poca memoria: compilar allí (descargar Node, instalar las dependencias del
  cliente y ejecutar esbuild) tumba el servicio de despliegue (error 502). Por eso aquí se compila
  en tu equipo y a Azure solo se sube lo necesario para ejecutar: el servidor, los archivos del
  cliente ya compilados y las 4 librerías de ejecución (ws, yjs, y-protocols, lib0).

  Uso, en PowerShell y desde la carpeta codesala (con "az login" hecho):
      .\deploy\publicar.ps1                    # empaqueta y publica
      .\deploy\publicar.ps1 -SoloEmpaquetar    # solo crea deploy\un-code-sala-publicar.zip (no toca Azure)
#>
param(
  [string]$ResourceGroup = 'codesala-rg',
  [string]$AppName,
  [switch]$SoloEmpaquetar,
  # Cuánto esperar a que la app responda tras subirla (el primer arranque puede tardar un par de minutos)
  [int]$EsperaSegundos = 180
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$zip = Join-Path $PSScriptRoot 'un-code-sala-publicar.zip'
$stage = Join-Path $env:TEMP 'un-code-sala-stage'

function Invoke-Az {
  & az @args
  if ($LASTEXITCODE -ne 0) { throw "Falló: az $($args -join ' ')" }
}

# 1. Compilar el cliente ----------------------------------------------------------------
Push-Location $root
try {
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Falló la compilación del cliente (npm run build).' }
} finally { Pop-Location }

# 2. Carpeta de empaquetado: código + cliente compilado + dependencias de ejecución ------
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
foreach ($dir in 'server', 'shared', 'public', 'dist') { Copy-Item (Join-Path $root $dir) $stage -Recurse }

# Identificador de esta publicación: el servidor lo expone en /version y, tras reiniciar, el script
# espera a verlo. Así no se da por terminado el despliegue mientras aún responde el contenedor viejo.
$buildId = Get-Date -Format 'yyyyMMdd-HHmmss'
Set-Content -Path (Join-Path $stage 'VERSION') -Value $buildId -NoNewline -Encoding ascii

# Mismas versiones que usa el proyecto, para desplegar exactamente lo que se probó.
$deps = [ordered]@{}
foreach ($name in 'ws', 'yjs', 'y-protocols', 'lib0') {
  $deps[$name] = (Get-Content (Join-Path $root "node_modules\$name\package.json") -Raw | ConvertFrom-Json).version
}
[ordered]@{
  name         = 'un-code-sala'
  version      = '1.0.0'
  private      = $true
  type         = 'module'
  scripts      = @{ start = 'node server/index.js' }
  engines      = @{ node = '>=20' }
  dependencies = $deps
} | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $stage 'package.json') -Encoding utf8

Push-Location $stage
try {
  # Son librerías de JavaScript puro: lo instalado en Windows funciona igual en Linux.
  & npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw 'Falló npm install de las dependencias de ejecución.' }
  if (Test-Path $zip) { Remove-Item $zip }
  # El tar de Windows crea zips con "/" en las rutas, como espera Linux. Ruta completa por si
  # Git está en el PATH (su "tar" no sabe crear zip).
  & "$env:SystemRoot\System32\tar.exe" -a -c -f $zip .
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear el paquete.' }
} finally { Pop-Location }
Write-Host ("Paquete listo: {0}  ({1:N1} MB)" -f $zip, ((Get-Item $zip).Length / 1MB))
if ($SoloEmpaquetar) { return }

# 3. Publicar ----------------------------------------------------------------------------
if (-not (Get-Command az -ErrorAction SilentlyContinue)) { throw 'Falta la CLI de Azure o no hay sesión: ejecuta "az login".' }
if (-not $AppName) {
  $apps = @((& az webapp list -g $ResourceGroup --query '[].name' -o tsv) | Where-Object { $_ })
  if ($apps.Count -ne 1) { throw "Se esperaba 1 app en '$ResourceGroup' y hay $($apps.Count). Indica -AppName." }
  $AppName = $apps[0]
}
Write-Host "Publicando en $AppName ..."

# Por si algún despliegue futuro pasa por la tubería de Kudu, que no compile.
Invoke-Az webapp config appsettings set -g $ResourceGroup -n $AppName --settings SCM_DO_BUILD_DURING_DEPLOYMENT=false -o none

# En lugar de "az webapp deploy" (que pasa por la tubería de despliegue de Kudu y lanza una
# compilación remota aunque el paquete ya venga compilado, tumbando el plan B1), el zip se
# descomprime directamente en la carpeta de la app con la API de archivos de Kudu.
$host_ = (& az webapp show -g $ResourceGroup -n $AppName --query defaultHostName -o tsv)
$scm = 'https://' + ($host_ -replace '^([^.]+)\.', '$1.scm.')
$token = (& az account get-access-token --query accessToken -o tsv)
if (-not $token) { throw 'No se pudo obtener el token de Azure: ejecuta "az login".' }
$auth = @{ Authorization = "Bearer $token" }

# Un despliegue anterior fallido puede quedar marcado «en curso» durante más de 10 minutos sin
# que haya ningún proceso trabajando. No bloquea esta subida, que no pasa por esa tubería.
try {
  $d = Invoke-RestMethod -Headers $auth -Uri "$scm/api/deployments/latest" -TimeoutSec 60
  if (-not $d.complete -and $d.status -eq 1) {
    Write-Warning "Hay un despliegue anterior marcado «en curso» ($($d.id.Substring(0, 8))). Se ignora: esta subida no usa esa tubería."
  }
} catch { Write-Host 'Kudu aún se está iniciando, continúo ...' }

# Se vacía la carpeta de la app (las salas viven en /home/data, fuera de ella) y se descomprime el paquete.
$cmd = @{ command = 'find /home/site/wwwroot -mindepth 1 -delete'; dir = '/home' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Headers $auth -Uri "$scm/api/command" -ContentType 'application/json' -Body $cmd -TimeoutSec 120 | Out-Null
Invoke-RestMethod -Method Put -Headers $auth -Uri "$scm/api/zip/site/wwwroot/" -InFile $zip -ContentType 'application/zip' -TimeoutSec 300 | Out-Null
Write-Host 'Paquete descomprimido en la carpeta de la app. Reiniciando ...'
Invoke-Az webapp restart -g $ResourceGroup -n $AppName -o none

# 4. Comprobar que responde (el primer arranque puede tardar un par de minutos) ----------
$url = "https://$host_"
Write-Host "Esperando a que $url sirva la versión $buildId (el relevo del contenedor puede tardar un par de minutos) ..."
$ok = $false
$deadline = (Get-Date).AddSeconds($EsperaSegundos)
while ((Get-Date) -lt $deadline) {
  try {
    $r = Invoke-RestMethod "$url/version" -TimeoutSec 30
    if ($r.version -eq $buildId) { $ok = $true; break }
  } catch { }
  Start-Sleep -Seconds 10
}
if ($ok) { Write-Host "Listo: $url (versión $buildId)" -ForegroundColor Green }
else { Write-Warning "La versión nueva no respondió a tiempo. Mira el registro: az webapp log tail -g $ResourceGroup -n $AppName" }
