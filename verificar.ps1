$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    npm test
    if ($LASTEXITCODE -ne 0) { throw 'Falha nos testes do DepTriagem.' }
} finally {
    Pop-Location
}
