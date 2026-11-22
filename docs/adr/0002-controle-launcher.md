# ADR 0002 — Interface de desktop e controle local do Launcher

**Status:** cliente implementado em 2026-11-21. O código da API no Launcher
segue o contrato. O uso exige uma versão do Launcher com essa API ativada.

O DepTriagem usa Electron e oferece conexão manual quando a API de controle
está desativada. No Windows, abre o Launcher pelo atalho do menu Iniciar.
O Launcher gerencia os modelos e o ciclo de vida dos processos.

O cliente de controle usa HTTP em `127.0.0.1`, porta padrão 8787, com
Bearer informado na janela ou em `DEPTRIAGEM_LAUNCHER_TOKEN`. O conteúdo do
campo fica em memória enquanto a janela está aberta. Esse token é distinto do token
opcional de chat. O servidor de controle deve restringir o acesso a
loopback e validar todos os pedidos. O cliente não aceita um host remoto.

| Método e caminho | Contrato |
| --- | --- |
| GET `/v1/control/state` | JSON com `version: 1`, `models` e `servers` |
| POST `/v1/control/start` | `{role, model_id}` com ID do catálogo |
| POST `/v1/control/stop` | `{role}` |
| POST `/v1/control/quit` | `{}`, encerra o Launcher e os servidores ativos |

Cada modelo tem `id`, `name` e `role`, que pode ser `chat` ou `decider`.
Para cada papel, `servers` contém `null` ou `{model_id, port, api_model?}`.
As mutações retornam um código HTTP 2xx quando aceitas. O cliente relê o
estado após iniciar ou parar. Erros de conexão mantêm a conexão manual disponível.

O estado v1 pode incluir `servers.reviewer`. Quando esse campo existe,
o DepTriagem oferece seleção de modelos do catálogo com papel `chat` e
usa `role: "reviewer"` para iniciar e parar o servidor dedicado.
Em análise automática, o DepTriagem consulta o estado e usa a porta
e o alias do Revisor. Se o Launcher indica que o Revisor está parado,
usa o modelo principal. Sem esse campo ou sem conexão de controle, o
DepTriagem reconhece o alias `modelo-revisor` em loopback na porta 8081
antes de recorrer ao modelo principal. A escolha por porta e ID continua
disponível como Revisor local manual.
