# ADR 0011 — Decisor local independente do Launcher

**Status:** aceito.

A triagem permite manter a porta do Decisor do Launcher, apontar diretamente
para um servidor SystemOne ou configurar um servidor de chat local que
aceite respostas estruturadas. A interface guarda a origem do Decisor
no perfil. A CLI recebe a origem e a conexão por argumentos.

No modo local, o Decisor recebe o relato por loopback. O DepTriagem valida as três
filas, os valores e a soma das estimativas. Baixa confiança, resposta
inválida ou falha de conexão encaminham o relato para revisão humana.
As estimativas do modelo de chat são autodeclaradas.

O parecer opcional recebe apenas a fila sugerida e o motivo. No modo de
chat direto, ele usa o mesmo endpoint local por padrão.

A configuração fica em **Modelos de IA** e a execução
em **Análise** escolhe o Decisor salvo ou o do Launcher. Os provedores
externos reutilizam os adaptadores de análise com uma resposta restrita
às filas da triagem. Cada relato enviado a um provedor externo exige
autorização para aquela execução. O OpenCode local usa uma sessão isolada
e um provedor definido para o endereço loopback selecionado, com
ferramentas desabilitadas.

A análise de dependências pode consultar o Decisor salvo
ou o do Launcher. O Decisor recebe contagens de pacotes e achados, o estado
da cobertura e códigos das lacunas. A fila sugerida fica no campo
`model_decision` do JSON e não altera a classificação dos achados.
O consentimento externo da análise também se aplica a essa consulta.
