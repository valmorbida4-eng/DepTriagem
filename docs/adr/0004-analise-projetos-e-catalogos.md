# ADR 0004 — Análise de projetos com fontes locais

**Status:** aceito em 2026-11-21.

A interface e a CLI usam o mesmo inventário. A fonte local é selecionada
por pasta. A fonte GitHub usa a conta autenticada no GitHub CLI, resolve
uma referência para um commit e lê o arquivo daquele commit em diretório
temporário. Os arquivos do repositório nunca são executados.

Chamadas ao Git local usam um executável resolvido fora da pasta analisada.
O inventário prepara metadados em um diretório temporário com configuração
gerada pelo aplicativo. Uma análise de commit copia os objetos locais
necessários à leitura sem carregar fontes alternativas de objetos. O
ambiente desabilita transporte, busca preguiçosa e prompts do Git.
O Git lê apenas uma árvore temporária com regras de exclusão copiadas.
Repositórios internos, submódulos, junções e arquivos de dependências
ignorados aparecem como lacunas de cobertura. Uma worktree vinculada
permite analisar a pasta com cobertura parcial. A análise de commit
exige uma pasta `.git` própria.

O OSV-Scanner v2 recebe apenas cópias dos lockfiles elegíveis, trabalha
offline e usa uma configuração explícita sem supressões do projeto.
São suportados npm, PyPI e NuGet. O relatório inclui proveniência,
hashes dos arquivos e problemas de cobertura. As versões dos catálogos
são armazenadas pelo SHA-256, com publicação atômica do índice por fonte.

O modelo local recebe evidência estruturada e escolhe verificações de
uma lista fixa. As sugestões ficam separadas dos achados do scanner.
Isso permite manter a análise determinística quando o Launcher estiver
indisponível. Imports são indícios, não comprovantes de uso em produção.

O tema mantém a paleta escura do Launcher e oferece Claro, Escuro e
Sistema. A tela de configurações guarda caminhos e tema em dados do
perfil do usuário. As credenciais ficam com o GitHub CLI ou no processo.
