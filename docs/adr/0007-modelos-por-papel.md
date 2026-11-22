# ADR 0007 — Agente e revisor com provedores independentes

**Status:** aceito.

O usuário escolhe o provedor, a identificação do modelo e, quando local,
a porta para cada papel. A escolha fica no perfil. A CLI recebe a mesma
configuração por parâmetros. O Launcher pode atender aos dois papéis
pelo mesmo endpoint de chat ou por endpoints locais separados. O
servidor do Decisor continua dedicado à triagem.

O processo principal chama APIs HTTPS de origens fixas e executa
Codex CLI e Claude Code em diretórios temporários sem o projeto,
com shell, MCP e outras ferramentas desabilitados na integração. Para o
OpenCode, usa o serviço Zen via Chat Completions. Não há integração
com as sessões do CLI do OpenCode.

No fluxo de análise, cada chamada externa requer consentimento para
aquela execução. O resumo contém contagens por linguagem, identificadores
de lacunas de cobertura e o total de achados. O revisor também pode
receber identificadores de verificações permitidas validadas pelo
DepTriagem. O modelo local continua podendo usar o inventário de
dependências. Os achados do OSV e KEV independem dessas chamadas.

A UI guarda chaves fornecidas apenas na memória do processo principal.
A alternativa no terminal é usar as variáveis de ambiente. Claude Code
exige uma chave Anthropic no modo isolado escolhido. Codex CLI usa sua
autenticação própria. O relatório registra o provedor e o estado de cada
papel mais os identificadores de verificações sugeridas.
