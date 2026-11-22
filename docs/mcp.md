# DepTriagem como servidor MCP

O DepTriagem oferece o transporte local MCP por stdio, sem exigir a
janela Electron aberta. Use o servidor para consultar catálogos ou
analisar as dependências de um projeto autorizado.

## Gerar a configuração

No aplicativo, abra **Configurações → Integrações MCP** e escolha o cliente
e o acesso aos catálogos, a uma pasta local ou a um repositório GitHub.
**Usar este projeto no MCP**, na tela de análise, preenche a origem.

**Testar servidor local** inicia o MCP, negocia o protocolo e confere
as ferramentas disponíveis para o acesso selecionado. **Ver configuração**
mostra o trecho que **Copiar configuração** coloca na área de transferência.
Use **Abrir local da configuração** para localizar o arquivo ou a pasta.
Mescle a entrada, incluindo as variáveis mostradas, e recarregue o cliente.
**Verificar conexão do cliente** mostra a hora da última negociação
concluída com essa configuração. O registro fica no perfil local do
DepTriagem e contém apenas a data e hora.

### Pela linha de comando

No PowerShell, após instalar o DepTriagem, substitua o caminho pela pasta
que o agente pode analisar:

~~~powershell
$DepTriagemCli = "$env:LOCALAPPDATA\Programs\DepTriagem\resources\deptriagem.cmd"
& $DepTriagemCli mcp config codex --root "C:\Projetos\MinhaApp"
~~~

Troque `codex` pelo cliente que vai usar. Mescle a entrada gerada aos
servidores existentes no destino abaixo, sem substituir as demais
configurações. A CLI imprime a configuração e deixa a decisão de
registrá-la com você.

| Cliente | Argumento | Destino |
| --- | --- | --- |
| Codex e Codex CLI | `codex` | `~/.codex/config.toml` ou `.codex/config.toml` do projeto confiável |
| Claude Code | `claude` | `.mcp.json` do projeto |
| OpenCode v2 | `opencode` | `opencode.jsonc`, em `mcp.servers` |
| OpenCode v1 | `opencode-v1` | `opencode.json` ou `opencode.jsonc`, em `mcp` |
| Gemini CLI | `gemini` | `.gemini/settings.json` |
| Antigravity | `antigravity` | **Installed MCP Servers → Open MCP Config** no app, ou `~/.gemini/config/mcp_config.json` para todas as pastas no CLI e `.agents/mcp_config.json` para uma pasta de trabalho |
| VS Code com agente MCP | `vscode` | `.vscode/mcp.json` |

Com `--root` em uma pasta Git, use `--commit HEAD` ou informe um hash, branch
ou tag. Na interface, preencha **Commit Git local** para o mesmo efeito.

Para usar o GitHub, troque `--root` por `--github dono/repositorio` e
informe `--ref BRANCH` quando quiser fixar a referência. O DepTriagem usa a
conta autenticada no GitHub CLI e aplica a configuração de repositório a
todas as chamadas daquela sessão. Sem `--root` ou `--github`, o servidor
só oferece a consulta aos catálogos.

Depois de salvar, recarregue a configuração do cliente e confira se o
servidor `deptriagem` aparece na lista de MCPs. Autorize o uso das
ferramentas no cliente que vai receber o resultado.

## Ferramentas

- `catalog_status` informa a disponibilidade e as datas das cópias
  locais de OSV (npm, PyPI e NuGet) e CISA KEV.
- `analyze_dependencies` verifica o projeto configurado e devolve
  um resumo com cobertura e até 60 achados, com prioridade para KEV.
  Use `analyze --output ARQUIVO` na CLI para guardar o JSON completo.

Clientes que solicitam notificações de progresso recebem as etapas
concluídas durante `analyze_dependencies`.

O MCP retorna nomes e versões de dependências com achados ao cliente.
O cliente pode incluir esse conteúdo em conversas com seu provedor de
IA. Autorize somente projetos cujos resultados possam ser usados
naquele cliente. O servidor não expõe código, caminhos de arquivos,
credenciais, execução de comandos ou instalação de ferramentas.

Use **Configurações → Fontes e ferramentas** ou `catalogs update` e
`scanner-install` na CLI para preparar o OSV-Scanner e os catálogos.

## Referências dos clientes

[Codex](https://developers.openai.com/codex/mcp) ·
[Claude Code](https://code.claude.com/docs/en/mcp) ·
[OpenCode](https://opencode.ai/docs/mcp-servers/) ·
[Gemini CLI](https://geminicli.com/docs/tools/mcp-server/) ·
[Antigravity](https://developers.google.com/knowledge/mcp) ·
[VS Code](https://code.visualstudio.com/docs/agent-customization/mcp-servers)
