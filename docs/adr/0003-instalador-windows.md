# ADR 0003 — Instalador Windows por usuário

**Status:** aceito em 2026-11-21.

O DepTriagem usa electron-builder e NSIS. O pacote inclui o Electron e
oferece atalhos para iniciar a interface pelo Windows.

O instalador usa uma pasta fixa em `%LOCALAPPDATA%\Programs` e registra
a instalação em HKCU. Usa arquivos temporários antes de substituir os
executáveis. Se a substituição falhar, tenta restaurar a versão anterior.
Uma instância aberta bloqueia a atualização e a remoção. O desinstalador
remove caminhos conhecidos e só remove a pasta se estiver vazia.

A atualização usa releases do GitHub e confere o SHA-256 antes de abrir o
instalador. No primeiro uso, o aplicativo copia preferências e catálogos
do perfil anterior quando disponíveis. A instalação e a desinstalação
preservam os dados dos dois aplicativos.
