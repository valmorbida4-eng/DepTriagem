# ADR 0010 — Pacotes multiplataforma e manuais locais

**Status:** aceito.

O DepTriagem adota NSIS no Windows x64, AppImage/DEB/RPM no Linux
x64 e ARM64 e DMG no macOS Intel e Apple Silicon. Cada pacote é
gerado no sistema correspondente e acompanhado de SHA-256.
O workflow de builds produz artefatos para validação.

A atualização integrada do NSIS permanece no Windows. No macOS
e no Linux, o DepTriagem baixa e valida o pacote da release para
substituição manual. No Linux, a seleção automática usa AppImage.
O manual orienta quem instalou por DEB ou RPM a escolher o formato
correspondente na release. O monitor permanece na bandeja no Windows
e exige o aplicativo aberto nos demais sistemas.

Os guias de uso, integração e manutenção são páginas HTML locais
empacotadas com o aplicativo. Os links do rodapé abrem uma janela
isolada da ponte IPC. O relatório copiável de diagnóstico contém
plataforma, arquitetura, versões e datas dos catálogos.
