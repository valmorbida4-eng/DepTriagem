# Segurança e privacidade

Relate falhas de segurança pelo [canal de advisories do repositório](https://github.com/valmorbida4-eng/DepTriagem/security/advisories)
quando a opção de relato privado estiver disponível. Use um canal privado
com o mantenedor para compartilhar detalhes que possam expor dados.

Tokens do Launcher ficam no processo ou em variáveis de ambiente.
A interface pode guardar o token de controle por opção explícita com a
proteção do sistema, vinculada à porta configurada. O token não aparece
em configurações exportadas ou em relatórios. A
autenticação para repositórios GitHub é administrada pelo GitHub CLI.
Consulte apenas repositórios para os quais sua conta tem autorização.

As chaves de modelos externos fornecidas na interface ficam em memória até
o fechamento do processo. Provedores externos recebem, com autorização
para aquela execução, contagens por linguagem, lacunas de cobertura, total
de achados e identificadores permitidos de verificações anteriores. Código,
caminhos, nomes de repositório, dependências, versões e identificadores de CVE
ficam fora desse resumo. A integração nunca inclui chaves no relatório.

Catálogos, relatórios exportados e configurações ficam, por padrão, em
`%LOCALAPPDATA%\DepTriagem`, fora do código do projeto. Relatórios podem
revelar dependências, versões, nomes de repositórios e estrutura do código.
Revise o conteúdo antes de anexá-los a issues ou compartilhar o JSON.

Na publicação, inclua o código e os artefatos de distribuição previstos.
Arquivos de ambiente, chaves, arquivos de configuração de credenciais,
logs, transcrições e dados de análise não fazem parte do repositório.
Revise também os metadados dos commits e qualquer outro material anexado.
Os registros de empacotamento do instalador são gravados fora do
workspace, em `%LOCALAPPDATA%\DepTriagem\build`.
