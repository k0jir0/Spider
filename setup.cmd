@echo off
setlocal
pushd "%~dp0"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap.ps1"
if errorlevel 1 goto failed
if /I "%~1"=="--skip-model" goto ready
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-local.ps1"
if errorlevel 1 goto failed
:ready
echo Setup complete. Run spider.cmd doctor or spider.cmd chat.
popd
exit /b 0
:failed
echo Setup failed. Review the error above; no administrator privileges are required.
popd
exit /b 1