# ADR 0001 — Decisor e modelo principal no Launcher

**Status:** aceito para o piloto em 2026-11-21.

Os testes de integração exercitam a rota `/v1/systemone` e a API de chat
em loopback.

O Kev-4B classifica; o Gemma E4B é o modelo principal proposto para parecer
curto. O Bonsai é alternativa via API de chat, com tempo limite explícito
e motor compatível à parte. Os benchmarks anteriores não mediram precisão
de triagem de segurança. Kev precisa de avaliação em pt-BR antes de qualquer
uso com roteamento automático.

O cliente conversa apenas com serviços locais, com portas configuráveis.
O Decisor recebe o relato como dado. O modelo principal recebe apenas a fila
e o motivo, escreve um parecer opcional e não consome ferramentas.
Indisponibilidade ou baixa confiança encaminham para revisão humana.

O comando de revisão de dependências é determinístico. Ele opera sobre
exportações do scanner e do KEV. Separar essa entrada da integração com
modelos permite rodar a revisão sem GPU e evita usar o parecer como evidência.
