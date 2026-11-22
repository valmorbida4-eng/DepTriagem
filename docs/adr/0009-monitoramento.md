# ADR 0009 — Monitoramento GitHub no desktop

**Status:** aceito.

O monitor verifica as dependências do branch padrão com a conta do GitHub
CLI vinculada ao agendamento. A seleção pode ser fixa ou recalculada em
cada rodada com a lista paginada de repositórios acessíveis.

O processo único do Electron controla o relógio e a execução. No
Windows ele permanece na bandeja enquanto o agendamento estiver ativo.
Após um período offline, uma execução recupera a ocorrência vencida.
Sair do DepTriagem interrompe o monitor até abrir o aplicativo.

A atualização automática dos catálogos OSV e CISA KEV usa um intervalo
próprio, em horas inteiras, salvo no agendamento. O padrão de 24 horas
também vale para agendamentos anteriores que ainda não têm esse campo.
O intervalo é verificado no início de uma execução do monitor, usando
a data da última tentativa e a data da cópia de cada fonte.

Cada repositório concluído gera um relatório JSON na pasta de relatórios.
O histórico e a referência de achados anteriores ficam no perfil. Uma
verificação parcial mantém os achados anteriores ausentes naquela rodada
para reduzir alertas repetidos. O Windows recebe uma notificação local
sobre achados novos ou falhas, quando o sistema aceita notificações.
