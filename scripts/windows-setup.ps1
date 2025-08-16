# Optional helper to run installs on Windows
# Usage:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   .\scripts\windows-setup.ps1
Write-Host "Installing npm packages..."
npm.cmd install
Write-Host "Running DB migrations..."
npm.cmd run db:migrate
Write-Host "Done. Start the bot with: npm.cmd run dev:bot ; and worker with: npm.cmd run dev:worker"
