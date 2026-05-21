@echo off
title 🌌 Antigravity Remote Control (ARC) Gateway
color 0B
echo ======================================================================
echo           🌌 INICIANDO ACCESO ACCESO DIRECTO DE CONTROL REMOTO 🌌
echo ======================================================================
echo.

:: Navegar al directorio del proyecto
cd /d "C:\Users\thiag\.gemini\antigravity\scratch\antigravity-remote"

:: Iniciar el proxy remoto con el túnel público activo
node cli.js --public

echo.
echo ======================================================================
echo Gateway de control remoto finalizado. Presiona cualquier tecla para salir.
echo ======================================================================
pause > null
