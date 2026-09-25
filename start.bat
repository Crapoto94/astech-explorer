@echo off
TITLE ASTECH Explorer
cd /d %~dp0
echo ASTECH Explorer : http://localhost:8099
echo (fermer cette fenetre pour arreter)
node server.js
pause
