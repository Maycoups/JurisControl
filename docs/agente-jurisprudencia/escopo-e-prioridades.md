# Escopo e prioridades

## Por que "não fazer scraping ao vivo contra STF/STJ" é uma restrição real, não preguiça

Testado na prática (curl direto, documentado no código atual): STJ/SCON
devolve bloqueio de WAF, STF devolve 403 já na primeira requisição, sem
um endpoint alternativo óbvio como o eproc do TJRJ. A decisão tomada foi
não tentar contornar isso de forma evasiva (headers falsos, rotação de
IP, resolução de CAPTCHA automatizada) — motivo duplo:

1. **Risco de reputação de IP compartilhado**: o mesmo IP de saída do
   projeto atende integrações que funcionam de verdade e de forma
   legítima (TJRJ/DJEN, DataJud/CNJ) — um bloqueio por comportamento
   abusivo detectado numa delas pode prejudicar as outras.
2. **Postura do produto**: é uma ferramenta profissional pra
   advogado(a) — dado errado ou obtido de forma questionável é pior que
   não ter o dado. Ver a regra "nunca dado simulado" no contrato de
   dados.

Essa mesma lógica deve valer pra este agente: **prioriza fontes que
autorizam/toleram acesso automatizado** (APIs públicas oficiais, dumps de
dados abertos, protocolos desenhados pra isso) **sobre scraping de
interface feita pra humano**, mesmo quando tecnicamente possível.

## Fontes já conhecidas e comprovadamente funcionais neste ecossistema

- **eproc do TJRJ** — já integrado e funcionando (ver referência de
  código). Se a base nova for reindexar TJRJ também, pode reaproveitar
  esse conhecimento (endpoint, parsing de HTML, formato de resposta)
  como ponto de partida, embora provavelmente valha a pena migrar pra
  uma ingestão em lote em vez de busca sob demanda.
- **DataJud (CNJ)** — API pública oficial, chave pública compartilhada
  (sem necessidade de credencial própria), já integrada no JurisControl
  pra outra finalidade (andamento processual — ver
  `referencia-codigo-atual/datajud-busca.ts`). Cobre múltiplos tribunais
  via um alias por tribunal (`api_publica_tjsp`, `api_publica_tjrj`,
  `api_publica_stj`, etc. — ver `CNJ_TRIBUNAL_MAP` no arquivo de
  referência). **Importante**: essa API indexa principalmente
  metadados/movimentação processual, não necessariamente o texto
  completo de ementas/acórdãos — vale investigar se o índice do DataJud
  cobre o que este agente precisa (jurisprudência de verdade, com
  ementa) ou só serve como fonte auxiliar de metadados. Documentação:
  https://datajud-wiki.cnj.jus.br/api-publica/

## Fontes a pesquisar (não confirmadas — pesquisar antes de assumir)

Não valido aqui nenhuma URL/API específica de STF, STJ ou outros
tribunais além das já citadas acima, porque não tenho confirmação atual
de que existam (ou continuem existindo, com essas condições) — melhor
pesquisar de forma independente do que herdar uma suposição errada deste
documento. Direções plausíveis pra investigar:

- Portais de dados abertos oficiais do STF e do STJ (transparência
  judicial costuma ter iniciativas de dataset público, separadas da
  interface de consulta processual voltada pro público geral).
- Se o CNJ mantém algum dataset agregado de jurisprudência (distinto do
  DataJud, que é mais focado em andamento) — o próprio DataJud pode ter
  crescido escopo desde a última verificação.
- Bases acadêmicas/de pesquisa jurídica que já tenham resolvido esse
  problema de agregação com autorização (ex.: iniciativas de "jurimetria"
  costumam ter enfrentado o mesmo obstáculo).

## Sugestão de prioridade (não vinculante)

1. **STF e STJ** — maior demanda de fundamentação (jurisprudência de
   tribunal superior pesa mais numa peça jurídica) e hoje é o maior buraco
   (zero cobertura).
2. **Outros TJs além do RJ** (SP, MG, etc., em ordem de volume de uso
   real do JurisControl) — hoje só RJ tem cobertura real.
3. **TRTs/TRFs** — menor prioridade a princípio, mas vale confirmar com
   o volume real de processos trabalhistas/federais na base de usuários.

## Compliance — nota rápida

Decisões judiciais públicas não são dado sigiloso, mas ementas/acórdãos
às vezes citam nome de parte (pessoa física) — vale considerar se algum
tratamento de anonimização é necessário dependendo de como os dados vão
ser armazenados/expostos, principalmente se a base ficar acessível além
do uso interno do JurisControl. Não é um bloqueio pra começar o projeto,
só um ponto a não esquecer antes de expor a base publicamente.
