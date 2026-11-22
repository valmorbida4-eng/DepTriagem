# ADR 0012 — Validação de catálogos e evidências da análise

**Status:** aceito.

Cada catálogo OSV novo é validado com o OSV-Scanner offline, em um
diretório temporário que contém somente o pacote de controle daquele
ecossistema e sua cópia candidata do catálogo. O índice só muda depois
de o scanner encontrar o advisory esperado e de o SHA-256 ser conferido
novamente. Catálogos anteriores continuam utilizáveis e aparecem como
pendentes de controle positivo até a próxima atualização.

O relatório preserva severidade declarada, vetores, pontuações CVSS base
e correções publicadas por advisory e pacote. O cálculo de CVSS v2 e
v3 usa as equações publicadas pela FIRST. O CVSS v4 usa a implementação
BSD-2-Clause da Red Hat e da FIRST, vendorizada com a licença, na revisão
`b0930b7646be5892492df16ba81cd8d8423eb49a`. A prioridade máxima do KEV
vigente permanece atribuída pelo scanner e pelos dados locais.

A fonte Git local opcional resolve a referência para um commit e lê a
árvore e os blobs regulares desse objeto. O relatório guarda os
identificadores do commit e da árvore. O diretório de trabalho permanece
disponível como outra fonte de análise local.

A exportação completa publica uma pasta com JSON e Markdown das
evidências do scanner. Se houver orientação ou decisão de IA, o parecer
fica em um JSON separado que contém o SHA-256 dos bytes exatos de
`relatorio.json`. A exportação JSON existente mantém os campos aceitos
pelos consumidores anteriores.

Referências: [CVSS v2](https://www.first.org/cvss/v2/cvss-v2-guide.pdf),
[CVSS v3.1](https://www.first.org/cvss/v3-1/specification-document) e
[calculador CVSS v4](https://github.com/RedHatProductSecurity/cvss-v4-calculator/tree/b0930b7646be5892492df16ba81cd8d8423eb49a).
