# DepTriagem

Aplicativo desktop de perfil pequeno para análise de dependências e triagem
local. A janela usa **Electron 45**, HTML, CSS e
TypeScript puro. O pacote não declara dependências npm de produção.

## Instalar e usar

| Sistema | Pacote | Arquitetura |
| --- | --- | --- |
| Windows | `DepTriagem-Setup-0.12.6-win-x64.exe` | x64 |
| Linux | AppImage, DEB ou RPM | x64 e ARM64 |
| macOS | DMG | Intel e Apple Silicon |

No Windows, abra o instalador e use o menu Iniciar ou o atalho. No
Linux, use o menu da distribuição após instalar DEB/RPM ou execute o
AppImage. No macOS, mova o DepTriagem do DMG para Aplicativos. Os pacotes
acompanham um arquivo de SHA-256. O OSV-Scanner e o GitHub CLI são
ferramentas externas usadas pela análise.

Os instaladores de Windows e macOS são distribuídos sem assinatura digital.
No primeiro uso pela interface, CLI ou MCP, o aplicativo copia as
preferências, os catálogos e o scanner gerenciado quando o SHA-256 do
executável confere. Cadastre novamente o token do Launcher se ele
estava guardado no perfil anterior.
Relatórios antigos e outras pastas permanecem no perfil anterior. Se o
destino de novos relatórios ficava naquele perfil, ele passa para a pasta
`reports` do DepTriagem. Scanners configurados manualmente precisam ser
selecionados novamente. Um perfil definido por `DEPTRIAGEM_DATA_DIR`
começa sem migração automática.

Os manuais **Uso**, **Integrações** e **Diagnóstico** estão no rodapé da
janela e funcionam offline. Em **Configurações → Preferências**, use
**Copiar diagnóstico** para copiar versões e datas dos catálogos.

- **Análise → Analisar aplicação:** selecione a pasta local ou um
  repositório GitHub. A referência do GitHub fica fixada em um commit.
  Escolha também **Agente** e **Revisor** na tela de análise.
  Em uma pasta Git, preencha **Commit Git local** com um hash, branch ou tag
  para analisar os arquivos gravados naquele commit. Com o campo vazio,
  o inventário usa os arquivos rastreados e não ignorados da pasta de trabalho.
  Arquivos como `requirements-dev.txt`, `dev-requirements.txt` e
  `requirements/dev.txt` entram na análise. Repositórios internos,
  submódulos e dependências ignoradas pelo Git aparecem como lacunas de
  cobertura.
  Worktrees vinculados podem ser analisados pela pasta, com cobertura
  parcial. A análise de commit requer uma pasta `.git` própria.
  **Exportar relatório completo** gera JSON, Markdown e, se houver parecer de IA,
  um JSON separado com o SHA-256 do relatório oficial.
- **Análise → Monitoramento GitHub:** selecione repositórios ou todos os
  acessíveis pela conta do GitHub CLI. Escolha a data inicial e a frequência
  horária, diária, semanal ou mensal. A análise usa o branch padrão e salva
  um JSON por repositório em `monitoramento` na pasta de relatórios.
  Para os catálogos OSV e CISA KEV, habilite a atualização automática e
  defina o intervalo em horas. O padrão é 24 horas.
  O histórico exibe achados novos, cobertura parcial e falhas. Na primeira
  análise, os achados existentes contam como novos.
- **Análise → Triagem de relatos:** escolha o Decisor salvo em Configurações
  ou o Decisor do Launcher. Quando o provedor é externo, autorize o envio de
  cada relato na tela de triagem.
- **Menu superior:** clique no botão de tema para alternar entre Sistema,
  Claro e Escuro. Em **Configurações → Preferências**, escolha a pasta
  padrão apresentada ao salvar relatórios JSON pela interface.
- **Configurações → Fontes e ferramentas:** instale ou selecione o
  OSV-Scanner, atualize os catálogos OSV de npm, PyPI e NuGet e o CISA KEV,
  e verifique a conta no GitHub CLI. Cada fonte mostra a data de
  atualização e quando a cópia local foi baixada. Antes de ativar cada
  nova cópia do OSV, o scanner testa se ela detecta um aviso conhecido
  daquele ecossistema. Uma falha preserva a cópia ativa.
- **Launcher:** ative a API local no Llama Desktop Launcher, copie o
  token e conecte pela porta de controle 8787 para iniciar e parar
  os modelos. A aba acompanha a conexão e a resposta de cada servidor.
  Use **Guardar token** se quiser reutilizar o token protegido neste perfil.
  Conectar manualmente por porta continua disponível.
  No Launcher compatível, selecione e inicie o **Revisor do Launcher**.
  Em **Analisar aplicação**, escolha **Revisor do Launcher (automático)**
  para usar o servidor dedicado quando ativo ou o modelo principal quando
  ele estiver ausente. Escolha **Modelo principal do Launcher** para
  usá-lo sempre. Para outra porta ou outro servidor, configure **Revisor local manual**.
  O resultado da análise identifica qual servidor a seleção automática usou.
- **Analisar aplicação → Modelos usados na análise:** para **Agente** e **Revisor**,
  escolha um dos modelos salvos em Configurações, o modelo ativo do Launcher ou
  desative o papel. Para **Decisor**, escolha o Decisor salvo, o do Launcher
  ou **Desativado**. A sugestão de fila aparece no resultado e no JSON.
  Autorize o envio do resumo para usar modelos externos.
- **Configurações → Modelos de IA:** escolha modelo e esforço, cadastre chaves
  de sessão, teste com dados fictícios e salve Agente, Revisor e Decisor.
  A configuração do Decisor serve à análise e à triagem.
- **Buscar modelos** aparece junto ao campo de ID nas configurações.
  A busca usa o catálogo das CLIs de Codex, OpenCode, Claude Code
  e Antigravity. Com uma chave configurada para Claude ou Antigravity, o
  DepTriagem consulta a API correspondente. Ao escolher um modelo, o DepTriagem
  preenche o ID e aplica os níveis de esforço informados pelo catálogo.
- **Configurações → Atualizações:** confira as releases, leia as notas
  e baixe o pacote depois da validação do SHA-256. O Windows também oferece instalação integrada.

O scanner usa cópias dos lockfiles e snapshots locais. Os modelos sugerem
verificações de cobertura. O OSV-Scanner identifica os achados e a lista
CISA KEV ajuda a priorizá-los. Os achados incluem a severidade publicada,
o CVSS base, as versões corrigidas por aviso e divergências entre os avisos,
quando essas informações estão disponíveis.

| Provedor | Configuração |
| --- | --- |
| Llama Desktop Launcher | Use o chat ativo ou informe a porta e o ID do modelo em cada papel. |
| ChatGPT / OpenAI API | ID do modelo e chave `OPENAI_API_KEY`. |
| Codex CLI | Instalação e autenticação próprias do Codex. ID do modelo opcional. |
| Claude Code CLI | Instalação do CLI e login ativo ou chave `ANTHROPIC_API_KEY`. ID do modelo opcional. |
| OpenCode CLI | CLI 1.x e ID no formato `provedor/modelo`. A sessão isolada usa as conexões por chave da CLI e o catálogo em cache quando disponível. |
| Antigravity CLI (`agy`) | Executável `agy` no `PATH` e login ativo ou chave `GEMINI_API_KEY`. ID do modelo opcional. |
| OpenCode Zen | ID compatível com Chat Completions e chave `OPENCODE_API_KEY`. |
| Gemini API | ID do modelo e chave `GEMINI_API_KEY`, com `GOOGLE_API_KEY` como alternativa. |

Na interface, use **Usar chave** para cadastrar uma chave até fechar o
DepTriagem. Também é possível definir as variáveis acima no ambiente antes
de abrir o aplicativo. Os serviços externos recebem apenas o resumo
autorizado, sem arquivos ou dados identificáveis de dependências.

O esforço disponível depende do provedor e do modelo. Use **Padrão** para
seguir a configuração do provedor. No OpenCode CLI, o esforço seleciona uma
variante do modelo. No Launcher, escolha **Configuração do servidor** para
usar o comportamento de raciocínio definido no servidor local.

## Linha de comando

Os pacotes incluem uma CLI que usa o Electron distribuído com o
aplicativo. No Windows, execute `resources/deptriagem.cmd`. No macOS, use
`sh "/Applications/DepTriagem.app/Contents/Resources/deptriagem.sh" --help`.
No Linux, execute com `sh` o arquivo `resources/deptriagem.sh` na pasta de
instalação ou em `squashfs-root/resources` após extrair a AppImage com
`--appimage-extract`. Em desenvolvimento, use `npm run cli -- --help`.
No Linux e macOS, autentique o GitHub CLI pelo terminal.

Para a escolha de modelos na CLI, use `--agent`, `--agent-model`,
`--agent-effort`, `--reviewer`, `--reviewer-model` e `--reviewer-effort`.
Use `opencode-cli` para o OpenCode CLI e `agy` para o Antigravity CLI.
Consulte os IDs com `models list --agent PROVEDOR`. Para consultar os
catálogos por API em vez da CLI do Claude ou do Antigravity, forneça a
chave correspondente pelo ambiente.

Para triagem sem o Launcher, use `triage RELATO.txt --decider systemone --decider-port 8090`
ou `triage RELATO.txt --decider chat --decider-port 8080 --decider-model ID`.
Para incluir a sugestão do Decisor na análise de dependências, passe
`--decider` e as opções correspondentes a `analyze`.
Para usar o OpenCode com modelo local, selecione **OpenCode CLI · servidor
local** no Decisor e informe a porta e o ID oferecidos pelo servidor de chat.
Se o Kev estiver disponível exclusivamente por SystemOne, selecione **Servidor
SystemOne local**. Na CLI, use `--decider opencode-local` para o modo local ou
`--decider opencode --allow-external` para um provedor integrado.

```powershell
$DepTriagemCli = "$env:LOCALAPPDATA\Programs\DepTriagem\resources\deptriagem.cmd"
& $DepTriagemCli --help
& $DepTriagemCli catalogs status
& $DepTriagemCli analyze --local "C:\Projetos\MinhaApp" --output "$env:TEMP\deptriagem-relatorio.json"
& $DepTriagemCli analyze --local "C:\Projetos\MinhaApp" --commit HEAD --report-dir "$env:TEMP\deptriagem-auditoria"
& $DepTriagemCli analyze --github dono/repositorio --ref main
& $DepTriagemCli models test --agent launcher --agent-port 8080
& $DepTriagemCli analyze --local "C:\Projetos\MinhaApp" --agent launcher --reviewer codex --allow-external
& $DepTriagemCli update check
```

A autenticação de repositórios usa `gh auth login --hostname github.com --web`.
Use um diretório novo para `--report-dir`. Essa opção substitui `--output`
na mesma chamada e grava `relatorio.json`, `relatorio.md` e, quando houver
parecer, `parecer-ia.json`.
Na análise, a saída é 0 para inventário analisado sem achados, 1 para
achados e 2 para cobertura parcial ou erro.

A interface acompanha etapas de análise e bytes de download. Quando o
total não está disponível, a barra fica indeterminada. Na CLI, adicione
`--progress` para receber eventos JSON no stderr e manter o resultado
no stdout.

No Windows, o monitor permanece na bandeja após fechar a janela.
Ao sair do DepTriagem ou desligar o PC, as execuções param. Ao reabrir,
um agendamento vencido faz uma execução de recuperação. Use
`monitor status` para consultar o histórico pela CLI. O monitor verifica
se algum catálogo atingiu o intervalo configurado antes de analisar os
repositórios.

## Servidor MCP

Em **Configurações → Integrações MCP**, escolha o cliente e o acesso, teste
o servidor local e copie a configuração. Use **Usar este projeto no MCP**
na tela de análise para reaproveitar a origem selecionada.

Use `mcp config CLIENTE --root PASTA` para gerar a configuração da
análise por agentes. O servidor local também pode consultar as datas
dos catálogos. [Configuração e ferramentas MCP](docs/mcp.md).

## Desenvolvimento

Use Node.js 22.12 ou superior e npm. As três dependências diretas de
desenvolvimento são Electron, TypeScript e electron-builder.

```powershell
npm ci
npm start
npm test
npm run smoke:ui
npm run cli -- --help
npm run dist:win
```

Execute `npm run dist:win`, `npm run dist:linux` ou `npm run dist:mac` no
sistema correspondente. No Linux, a criação de RPM exige `rpm`.
O workflow **Build installers** empacota as arquiteturas em runners
nativos. Para o canal estável, anexe cada pacote e seu SHA-256 à release
da tag `vX.Y.Z`. A remoção do aplicativo preserva o perfil.

A janela carrega recursos locais. O processo de renderização fica isolado
e pede operações específicas ao processo principal. Consulte
[Segurança e privacidade](SECURITY.md) e a
[decisão da migração para Electron](docs/adr/0006-electron.md).

## Manuais

- [Usuário](docs/manuais/usuario.html)
- [Integrações](docs/manuais/integracoes.html)
- [Diagnóstico e manutenção](docs/manuais/manutencao.html)

## Licença e fontes

O código do DepTriagem é distribuído sob a [licença MIT](LICENSE).
O calculador CVSS v4 mantém a licença da implementação original em
[desktop/vendor/cvss4/LICENSE](desktop/vendor/cvss4/LICENSE).

A análise usa o [OSV-Scanner](https://google.github.io/osv-scanner/) e os
catálogos do [OSV](https://osv.dev/), que agregam avisos de fontes como o
[GitHub Advisory Database](https://github.com/advisories). A priorização
usa o [CISA Known Exploited Vulnerabilities Catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog).
