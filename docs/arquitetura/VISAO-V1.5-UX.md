# Visão — Beta 1.5: Landing Page da Organização + UI/UX e Gamificação do JurisControl

Escrito em: agosto de 2026, junto com a decisão de separar este trabalho
do ciclo normal de manutenção (ver `docs/arquitetura/ROADMAP.txt`, trilha
"Projeto de UI/UX separado").

Este documento é o brief de handoff pra sessão de UI/UX — pensado pra ser
colado como prompt inicial dessa sessão nova. Não é uma decisão final de
design, é o ponto de partida: a sessão de UX deve questionar, refinar e
propor variações em cima disto, não seguir cegamente.

**Onde esse trabalho deve rodar**: numa pasta separada (worktree git ou
cópia), numa branch própria (ex.: `v1.5-ux-gamificacao`), sem tocar na
pasta/branch que atende a Dra. Camila em produção. Só volta pra produção
depois de validado e com decisão explícita de merge.

---

## 1. Contexto

O JurisControl está na Beta 1.0, em uso real por uma advogada piloto
(Dra. Camila Gomes Nunes). Funciona bem, mas o design é utilitário —
nunca passou por um projeto de UI/UX de verdade. A Beta 1.5 prevista no
roadmap é "melhorias de funcionalidades, IA e novo design".

Agora entra uma segunda peça: uma **organização/marca guarda-chuva**
(nome ainda não definido — placeholder "Organização X" neste documento)
da qual o JurisControl é um produto. Essa organização ganha uma landing
page própria.

## 2. As duas frentes

### 2.1 Landing Page da Organização

- Site novo, separado do JurisControl (pode ser stack diferente — não
  precisa herdar a arquitetura zero-build do app).
- Apresenta a organização como uma ideia maior, não só "propaganda do
  JurisControl" — o produto aparece como uma das iniciativas, com link
  claro pra ele.
- **Sem anúncios, sem cobrança, sem captura agressiva de lead** nesta
  fase — o objetivo agora é experiência, não conversão/monetização.
- Padrão alto: limpo, moderno, fluido. Transições suaves (scroll,
  hover, entrada de seção) — não efeitos gratuitos, cada transição deve
  ter uma razão (guiar atenção, dar feedback, criar respiro visual).
  microinterações discretas (não literal jogo/pontos como no
  produto).
- **Referência de padrão de qualidade**: já existe uma pasta
  `docs/referencias-design/` no projeto — vale revisar antes de propor
  algo do zero.

### 2.2 JurisControl — UI/UX geral + camada de gamificação

Duas coisas diferentes, tratar separadamente:

**(a) Aprimoramento de UI/UX geral** — refino visual e de interação em
cima do que já existe (hierarquia, espaçamento, consistência, estados de
carregamento/vazio/erro, responsividade, acessibilidade). Isso vale
mesmo sem nenhuma gamificação.

**(b) Sistema de créditos e gamificação** — a parte nova pedida:
- Vários sistemas de créditos **internos, gratuitos, sem qualquer
  ligação com dinheiro real** — não é um mecanismo de cobrança disfarçado,
  é reforço comportamental puro.
- Toda ação relevante do usuário custa ou recompensa crédito(s) —
  completar um cadastro de processo, gerar uma peça, resolver um prazo
  antes do vencimento, manter uma sequência de dias de uso, etc.
- Animações e "gatilhos de dopamina" no sentido correto do termo:
  feedback imediato e satisfatório (não só um toast — uma transição que
  comunica "isso valeu a pena"), progresso visível (barras, streaks,
  níveis), recompensa variável ocasional (não 100% previsível — é o que
  sustenta curiosidade sem virar mecânico/chato).
- Base em psicologia comportamental de verdade (reforço variável,
  efeito Zeigarnik — tarefa incompleta gera tensão que motiva concluir,
  progresso visível aumenta motivação/comprometimento — efeito
  "endowed progress"), não só "copiar joguinho de celular".

## 3. Guardrails — o que NÃO fazer

Importante porque o público é advogado(a) em ambiente profissional, não
usuário de rede social:

- **Nada de dark pattern**: sem culpa forçada ("você vai perder sua
  sequência!"), sem notificação ansiogênica, sem fricção artificial pra
  segurar o usuário. Reforço positivo, não retenção manipulativa.
- **Não comprometer a credibilidade profissional do produto** — é uma
  ferramenta de trabalho jurídico; a camada de gamificação tem que
  parecer polida e opcional/discreta, nunca infantilizar a tela onde a
  advogada está lendo uma intimação real.
- **Créditos nunca tocam dinheiro real** nesta fase — nada de estrutura
  que pareça (mesmo de longe) aposta, loot box ou compra.
- **Acessibilidade não é opcional**: contraste, `prefers-reduced-motion`
  respeitado (usuário que desativa animação no SO não deve ver as
  transições), navegação por teclado.
- **Não pode quebrar o fluxo de trabalho real da Camila** — daí a
  decisão de desenvolver isso fora da pasta/branch de produção.

## 4. Restrições técnicas conhecidas

- JurisControl hoje: React 18 + Babel Standalone (JSX direto no
  navegador, sem build) + Tailwind via CDN, um único `index.html`,
  Supabase de backend, deploy Electron (desktop) + Vercel (web). Ver
  `docs/arquitetura/ARQUITETURA.md`.
- Uma reformulação de UI/UX **não precisa manter zero-build** por
  princípio — se ficar claro que vale a pena introduzir uma etapa de
  build (Vite, por exemplo) pra sustentar um design system mais sério
  (componentização, animações mais ricas), essa é uma decisão real a
  tomar na sessão de UX, com trade-offs explícitos, não um tabu herdado
  da fase anterior.
- Landing page da organização: sem essa amarra nenhuma, pode ser
  qualquer stack adequado (inclusive site estático simples).

## 5. Em aberto — a sessão de UX deve resolver isso, não eu antecipar

- Nome da organização (placeholder "Organização X" aqui).
- Identidade visual: paleta, tipografia, tom de voz — hoje o
  JurisControl usa uma paleta "navy/stone/amber" utilitária; decidir se
  a landing herda algo dela ou propõe uma identidade nova pra
  organização (com o produto se adaptando depois, ou não).
  Sistema de crédito: nomenclatura, unidade visual (moeda? XP? selo?),
  onde ele aparece no app (barra fixa? só no perfil?).
- Se algum crédito acumulado deve desbloquear algo de verdade dentro do
  produto (ex.: tema extra, badge no perfil) ou é só feedback/vaidade.

## 6. Fases sugeridas (não vinculante)

1. Definir identidade (nome da organização, paleta, tom) — landing e
   produto.
2. Protótipo visual da landing page (estático, sem funcionalidade real).
3. Protótipo do sistema de créditos/gamificação isolado (uma tela de
   exemplo, não o app inteiro) pra validar se "parece profissional e
   não brega" antes de espalhar pelo app inteiro.
4. Aplicar o novo UI/UX + gamificação no JurisControl, fora da branch de
   produção.
5. Revisão conjunta, decisão de merge pra produção.
