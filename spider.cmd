@echo off
setlocal
pushd "%~dp0"
if not exist ".runtime\node\node.exe" goto missing
if not exist "dist\src\cli.js" goto missing
set "PATH=%~dp0.runtime\node;%PATH%"
".runtime\node\node.exe" "dist\src\cli.js" %*
set "result=%errorlevel%"
popd
exit /b %result%
:missing
echo Run setup.cmd first, or setup.cmd --skip-model for an external model provider.
popd
exit /b 1