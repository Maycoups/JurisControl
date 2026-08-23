# Handoff — Agente de Base de Dados de Jurisprudência

Pacote de contexto pra colar no repositório do agente novo (criado fora
deste projeto) cuja missão é construir uma base de dados de jurisprudência
de verdade — hoje o JurisControl só tem cobertura real de um tribunal.

Escrito em: agosto de 2026, a partir do estado atual do JurisControl
(`c:\Users\Maycon\Desktop\Nova pasta`, branch `dev/seguranca-e-performance`).

## O que é o JurisControl (contexto rápido)

App de gestão jurídica pra advogado(a) autônomo(a) — React 18 +
Babel Standalone (zero build, JSX direto no navegador) num `index.html`
único, backend Supabase (Postgres + Auth + Edge Functions), deploy
Electron (desktop) e Vercel (web). Em uso real por uma advogada piloto.
Detalhes de arquitetura completos não são necessários pra esta missão —
o que importa aqui é só a peça de jurisprudência, isolada abaixo.

## O problema que este agente resolve

O JurisControl busca jurisprudência relacionada em duas situações:

1. **Na ficha de um processo** — aba "Jurisprudência", termo de busca
   derivado automaticamente da ação/área do processo (editável pelo
   usuário).
2. **Ao gerar uma peça com IA** — a jurisprudência encontrada entra como
   fundamentação real no prompt da IA, e as fontes aparecem citadas
   (com link) ao lado da minuta gerada.

Hoje isso é resolvido por uma Edge Function (`busca-jurisprudencia`, ver
`referencia-codigo-atual/busca-jurisprudencia.ts` nesta pasta) que tenta,
nesta ordem:

1. **LexML Brasil** (rede nacional que agrega legislação/jurisprudência
   de vários tribunais, protocolo SRU) — na prática, quase sempre
   bloqueado por verificação anti-bot do lado deles.
2. **eproc do TJRJ** (busca pública de jurisprudência do próprio
   tribunal, sem autenticação/CAPTCHA) — funciona de verdade, mas só
   cobre o TJRJ.
3. Se os dois falharem: resultado vazio com mensagem clara. **Nunca dado
   simulado/fake** — essa é uma decisão de produto deliberada e deve
   continuar valendo pra qualquer coisa que este agente construir também.

**Ou seja: hoje só existe cobertura real pra um tribunal (TJRJ).** STF,
STJ e os demais TJs ficaram de fora porque bloqueiam scraping automatizado
de forma mais agressiva (STJ/SCON devolve bloqueio de WAF, STF devolve 403
já na primeira requisição) — e a decisão tomada foi não tentar contornar
isso de forma evasiva (arriscaria a reputação do IP de saída do projeto,
que também atende integrações que funcionam de verdade, como TJRJ/DJEN e
DataJud/CNJ).

**A missão deste agente é justamente essa: construir uma base de dados de
jurisprudência de verdade, com cobertura mais ampla que só o TJRJ, sem
depender de scraping ao vivo contra tribunais que bloqueiam isso.**

## Arquivos nesta pasta

- `contrato-de-dados.md` — o formato exato de entrada/saída que o
  JurisControl espera hoje (pra compatibilidade, caso o agente vá
  substituir/complementar a function atual).
- `escopo-e-prioridades.md` — o que priorizar, restrições éticas/legais,
  e como pensar a fonte de dados (dump oficial > scraping ao vivo).
- `referencia-codigo-atual/` — cópia fiel do código que resolve isso hoje
  no JurisControl (a Edge Function de busca de jurisprudência, e a de
  integração com o DataJud/CNJ, que é um projeto irmão relevante — ver
  nota no escopo).

## Como isso deve voltar a se conectar (decisão em aberto)

Este documento não amarra a arquitetura do agente novo — só deixa claro o
formato de saída esperado (`contrato-de-dados.md`) pra que, quando a base
estiver pronta, plugar de volta no JurisControl seja trocar a
implementação de uma function por outra fonte, não redesenhar a interface.
Duas formas plausíveis de expor o resultado, ambas compatíveis com o
contrato:

- **API HTTP própria** que o JurisControl passa a chamar no lugar de (ou
  além de) `busca-jurisprudencia` — mais simples de integrar, mantém a
  arquitetura atual (Edge Function troca de fonte).
- **Dataset consultável diretamente do Postgres** (uma tabela/índice que
  o Supabase do JurisControl também enxerga, ou um espelho sincronizado)
  — evita uma chamada de rede extra por busca, mas exige decidir
  atualização/sincronização entre os dois bancos.

Não precisa decidir isso agora — só manter em mente que o formato de
resposta (`contrato-de-dados.md`) é o contrato real entre os dois
projetos, seja qual for a forma de transporte escolhida depois.
