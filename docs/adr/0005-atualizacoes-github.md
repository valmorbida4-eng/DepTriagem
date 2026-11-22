# ADR 0005 — Atualizações de versão pelo GitHub

**Status:** aceito.

O DepTriagem consulta releases estáveis de `valmorbida4-eng/DepTriagem`.
A origem de atualização é fixa. A API pública dispensa login e, enquanto
o repositório for privado, a consulta usa o GitHub CLI autenticado.
A UI consulta ao iniciar e a cada 24 horas enquanto aberta, com opção
de desligar essa consulta. Somente uma ação explícita instala a atualização.

O contrato da release exige tag `vX.Y.Z`, o instalador
`DepTriagem-Setup-X.Y.Z-win-x64.exe` e seu arquivo `.exe.sha256`.
Os dois arquivos são gerados por `npm run dist:win`. O hash anunciado
no metadado do GitHub, o SHA-256 publicado e o hash calculado no download
precisam coincidir. Uma release sem esse conjunto pode exibir notas,
mas não pode ser instalada pelo atualizador.

Na edição instalada, o auxiliar Windows aguarda o fim do processo
principal, confere novamente o SHA-256 e abre o NSIS visível para o
usuário atual. A CLI usa a mesma transferência com o NSIS silencioso e
retorna um estado pendente enquanto encerra seu próprio processo.
O auxiliar verifica o código do instalador e a versão da CLI instalada
antes de registrar a conclusão. A UI apresenta o resultado em
Atualizações e a CLI oferece `update status`. O NSIS pede que processos
do DepTriagem sejam fechados e preserva os dados do perfil.

Para preparar uma release, publique primeiro o commit e a tag
correspondentes e anexe os dois artefatos com os nomes exatos. Por padrão,
drafts e versões marcadas como pré-release ficam fora do canal estável.
