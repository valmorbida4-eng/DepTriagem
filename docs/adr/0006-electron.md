# ADR 0006 — Aplicativo desktop Electron 45

**Status:** aceito.

A interface adota o modelo do Llama Desktop Launcher: Electron 45,
HTML/CSS e TypeScript sem frameworks. A janela usa isolamento de contexto,
sandbox e uma política de conteúdo local. A ponte de preload expõe
operações enumeradas e o processo principal verifica a janela e o quadro
de origem antes de atender cada pedido.

O mesmo núcleo TypeScript atende a UI e o terminal. O iniciador da CLI usa
o modo Node do Electron empacotado. O OSV-Scanner, GitHub CLI e Launcher
permanecem integrações externas; nenhuma dependência npm de produção é
necessária. Arquivos do perfil continuam em `%LOCALAPPDATA%\DepTriagem`.

A distribuição usa electron-builder e NSIS por usuário. O manifesto
de desinstalação é gerado a partir do pacote e enumera os arquivos
instalados. A remoção deixa arquivos fora do manifesto e os dados do
perfil disponíveis. O fluxo de atualização preserva o digest do GitHub
e a verificação do arquivo de SHA-256 da release.

O ADR 0003 registra o empacotamento para Windows.
