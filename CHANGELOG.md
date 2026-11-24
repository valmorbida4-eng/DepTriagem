# Histórico de versões

## 0.12.6

- Move o botão de tema para o menu superior, com alternância entre Sistema, Claro e Escuro.

## 0.12.5

- Distingue conta GitHub desconectada, pendente de verificação e verificada em Configurações, Análise e Integrações MCP.

## 0.12.4

- Preserva nomes Unicode distintos ao aplicar regras do Git e identificar lacunas de arquivos ausentes no Windows.

## 0.12.3

- Consulta as regras de exclusão por arquivo para respeitar exceções em subpastas.
- Reconhece a grafia em maiúsculas de arquivos de exclusão no Windows.

## 0.12.2

- Perfis explícitos desativam a migração automática, e falhas de cópia preservam o uso do perfil atual.
- Cobertura parcial para ausências em sparse checkout e arquivos que o inventário não consegue ler.
- Consultas de exclusão em lotes maiores para os arquivos relevantes à análise.

## 0.12.1

- Inventário sem acesso do Git à árvore original, com suporte a caminhos longos e indicação de vínculos e áreas fora da cobertura.
- Migração local disponível na interface, na CLI e no MCP, incluindo o scanner gerenciado validado por SHA-256.

## 0.12.0

- Primeira versão do DepTriagem.
- Inventário local e GitHub, análise offline, catálogos verificáveis, exportação e monitoramento de dependências.
- Operações Git isoladas da configuração do projeto e relatório de lacunas em repositórios internos.
- Integração local com o Launcher e ferramentas MCP.
