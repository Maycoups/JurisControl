# JurisControl — Arquitetura

> Documento de referência técnica. Escrito depois de uma rodada de
> organização geral do projeto (ago/2026), pra registrar como o sistema é
> montado, por que as decisões foram tomadas assim, e o que falta pra ir
> pra produção. Ponto de partida pra quem entrar no projeto agora (incluindo
> o programador que vai acompanhar/monitorar o Beta).

## 1. Visão geral

JurisControl é um sistema de gestão jurídica pra advogados autônomos:
processos, clientes (CRM), financeiro, agenda de prazos, integração com
tribunais (TJRJ real, DataJud/CNJ real), jurisprudência, e um assistente de
IA com três provedores (Gemini, Claude, ChatGPT). Roda como site (deploy
estático no Vercel) e como aplicativo desktop Windows (Electron).

Piloto atual: uma usuária real (Dra. Camila Gomes Nunes, OAB 172090/RJ),
projetado com foco geográfico no Rio de Janeiro (TJRJ — capital, Grande Rio,
Niterói, Região dos Lagos).

## 2. Stack e por que não tem build

- **Frontend**: React 18 + JSX, escrito direto num único `index.html`,
  transpilado **no navegador, em tempo real**, pelo Babel Standalone (CDN).
  Estilo via Tailwind CSS (CDN, JIT). Sem bundler, sem `npm run build`.
- **Por quê**: é uma escolha deliberada, não um esquecimento — sem etapa de
  build, qualquer mudança de código é testável imediatamente (recarregar a
  página), o que foi importante pra iterar rápido nas muitas rodadas de
  features deste projeto. O preço dessa escolha: sem checagem de tipos, sem
  lint automático até esta rodada (ver seção 8), e um arquivo único que já
  passa de 4700 linhas de script.
- **Backend**: Supabase — Postgres (com Row Level Security), Auth, e Edge
  Functions (Deno/TypeScript) pras integrações que precisam rodar no
  servidor (chaves de API, scraping, chamadas de IA).
- **Desktop**: Electron (`main.js` + `preload.js`), empacotado com
  `electron-builder`. Usa `safeStorage` do Electron pra guardar credenciais
  de IA localmente, criptografadas pela conta do Windows do usuário.

## 3. Mapa de pastas

```
index.html                  App inteiro (frontend) — única fonte de verdade da UI
main.js / preload.js        Casca do app desktop Electron
package.json                Scripts (start, dist, lint) e deps do Electron
scripts/lint.mjs            Linter do projeto (ver seção 8)

supabase/
  config.toml                Config do projeto Supabase (CLI)
  functions/                 Edge Functions (backend, Deno/TypeScript)
    _shared/auth.ts            Guarda de autenticação compartilhada
    busca-tjrj/                 Integração TJRJ (real, via DJEN/eproc)
    datajud-busca/               Movimentações processuais (API pública DataJud/CNJ, real)
    busca-jurisprudencia/         Jurisprudência (só TJRJ é real; outros tribunais = simulação rotulada)
    criar-peca-ia/                 Assistente de IA (Gemini/Claude/ChatGPT)
    verificar-convite/              Checagem de e-mail na lista de convidados
  migrations/                 Schema do banco (SQL, versionado)

docs/
  arquitetura/                Este documento + ROADMAP.txt
  legal/                       Termos de Uso / Política de Privacidade (fonte)
  referencias-design/          Protótipos e material de referência visual (não faz parte do app)

pesquisa-stf-dados-abertos/  Dataset bruto de uma pesquisa em andamento sobre
                             jurisprudência do STF (fora do controle de
                             versão — ver seção 7, item em espera)
```

## 4. Modelo de dados

Todas as tabelas de negócio seguem o mesmo padrão: **uma linha por
registro, dado guardado como JSONB**, em vez de uma coluna por campo.

```sql
id text primary key,
user_id uuid default auth.uid() references auth.users(id),
data jsonb not null,
updated_at timestamptz not null default now()
```

Motivo: os ~40 componentes React que consomem esses objetos (cliente,
processo, lançamento financeiro...) já esperam um objeto JS solto com
qualquer formato de campo — mapear isso 1:1 pra colunas SQL tradicionais
exigiria reescrever a camada de acesso a dados toda vez que um campo novo
fosse adicionado a um formulário. Com JSONB, um campo novo no formulário
React não precisa de migration nenhuma.

Tabelas: `clients`, `processes`, `financials`, `tribunais_conhecimento`
(base de conhecimento de varas/tribunais anotada pelo usuário),
`modelos_documento` (modelos de documento próprios do usuário).

Tabelas à parte (não seguem o padrão JSONB, têm propósito diferente):
- `uso_ia_gratuita` (user_id, mês, contagem) — controla a cota mensal do
  plano gratuito de IA, gravada só pela Edge Function (nunca pelo cliente).
- `allowed_emails` (email, nome) — lista de convite. RLS ligado e **sem
  nenhuma policy** — nem usuário logado consegue ler/escrever nela pela API
  pública, só quem tem a `service_role` key.

## 5. Autenticação e autorização

- Supabase Auth (e-mail + senha). Cadastro é **por convite**: um trigger
  Postgres (`verificar_email_permitido`, roda `BEFORE INSERT on auth.users`)
  bloqueia a criação de qualquer conta cujo e-mail não esteja em
  `allowed_emails` — não tem como contornar isso pelo front-end, a checagem
  é no banco. A Edge Function `verificar-convite` só existe pra dar um
  retorno rápido e com mensagem clara na tela de login *antes* de tentar o
  cadastro de verdade.
- Toda tabela de negócio tem RLS: `auth.uid() = user_id`, então cada usuário
  só vê os próprios dados — mesmo que o app tivesse um bug, o banco não
  deixaria vazar dado de outro usuário.
- Todas as Edge Functions (exceto `verificar-convite`, que precisa ser
  chamável antes do login) exigem um usuário autenticado, checado via
  `_shared/auth.ts`.
- **Senha**: mínimo 8 caracteres, com maiúscula+minúscula+número
  (`minimum_password_length`/`password_requirements` em
  `supabase/config.toml`, validado também no cliente antes de gastar uma
  chamada). O hash é feito pelo próprio Supabase Auth (bcrypt), a senha em
  texto puro nunca chega a ficar salva em lugar nenhum.
- **MFA (autenticação em duas etapas, TOTP)**: disponível desde a branch
  `dev/seguranca-e-performance` — opt-in, ativado em Configurações
  (`SegurancaMfaCard`, `index.html`). Quem ativa passa a precisar do
  código de 6 dígitos em todo login novo (`MfaChallengeView`, decidido em
  `App()` via `auth.mfa.getAuthenticatorAssuranceLevel()`). É 100% API do
  `supabase-js` já embutida no app — nada de servidor próprio.
- **Login com Google (OAuth) — botão pronto, falta a configuração no
  Supabase**: o botão "Continuar com Google" já chama
  `auth.signInWithOAuth({ provider: 'google' })`, e o convite
  (`allowed_emails`) vale pra qualquer provedor, sem exceção. O que falta
  é uma configuração manual, feita uma vez, fora do código:
  1. No [Google Cloud Console](https://console.cloud.google.com/), criar
     um projeto (ou usar um existente) e configurar a tela de
     consentimento OAuth (tipo "Externo" é suficiente pro uso atual).
  2. Em "Credenciais" → "Criar credenciais" → "ID do cliente OAuth", tipo
     "Aplicativo da Web". Em "URIs de redirecionamento autorizados",
     adicionar exatamente:
     `https://yenznpfqqocdkzlcfhdv.supabase.co/auth/v1/callback`
  3. Copiar o **Client ID** e o **Client Secret** gerados.
  4. No painel do Supabase: Authentication → Providers → Google → ativar
     e colar as duas credenciais. Salvar.
  5. Testar: o botão já existe no login, é só ele passar a completar o
     fluxo de verdade a partir desse ponto.
  (Ligar isso direto no painel do Supabase, e não via `config.toml`/CLI —
  `supabase config push` sincroniza o arquivo inteiro, é fácil mexer em
  algo sem querer junto; já aconteceu uma vez neste projeto.)

## 6. Sistema de IA

Três provedores, dois modelos de custo:

| Provedor | Modelo padrão | Custo |
|---|---|---|
| Gemini (Google) | `gemini-3.6-flash` | **Grátis** até 10 gerações/mês/usuário (chave da casa) — depois, exige BYOK |
| Claude (Anthropic) | `claude-sonnet-5` | Sempre BYOK (sem chave da casa) |
| ChatGPT (OpenAI) | `gpt-5.1` | Sempre BYOK (sem chave da casa) |

BYOK = "bring your own key": o usuário conecta a própria chave em
Configurações (`ConfigurarIAModal`), guardada localmente (Electron
`safeStorage` ou `localStorage` na versão web) — nunca no servidor. A
função `resolverProvedorIA()` no front-end decide qual chave usar, nesta
ordem de prioridade: Claude > ChatGPT > Gemini (Gemini fica por último de
propósito, é o único com plano gratuito).

A Edge Function `criar-peca-ia` centraliza todas as chamadas de IA do app,
com 6 tarefas: `minuta` (peça processual), `resumo`, `proximo_passo`,
`modelo_documento` (cria modelo reutilizável do zero, com placeholders),
`revisar_texto` (ajusta um texto já preenchido com dados reais, sem
introduzir placeholders — usado no Gerador de Documentos), e
`sugestao_prazo` (Calculadora de Prazos).

## 7. Integrações externas e limitações conhecidas

- **TJRJ**: real. Scraping do sistema eproc público
  (`eproc1g.tjrj.jus.br`), incluindo o texto integral da decisão quando
  disponível.
- **DJEN** (Diário de Justiça Eletrônico Nacional, CNJ): real, API pública
  oficial — usado pra localizar processos por OAB.
- **DataJud** (CNJ): real, API pública oficial — movimentações processuais
  por número CNJ.
- **Jurisprudência de outros tribunais (STF, STJ, TJs de outros estados)**:
  **simulada**, e claramente rotulada como tal na resposta (`simulado:
  true`). Investigado e decidido conscientemente: as fontes reais desses
  tribunais estão atrás de proteção anti-bot que só cederia com técnicas de
  evasão (simular navegador de verdade) — decisão de não fazer isso, é
  frágil e arriscaria a reputação do IP de saída do projeto, que também é
  usado pra TJRJ/DJEN (que funcionam de verdade). Uma fonte de dados aberta
  do STF (Base dos Dados, formato BigQuery) foi encontrada e está em
  avaliação separada — dataset bruto salvo em `pesquisa-stf-dados-abertos/`
  (fora do controle de versão), decisão de uso ainda pendente.

## 8. Qualidade de código

- **Linter**: `npm run lint` (`scripts/lint.mjs`). Extrai o bloco de script
  do `index.html` e transpila com `@babel/standalone` (a mesma engine que
  roda no navegador), reportando qualquer erro de sintaxe/JSX com linha
  exata. Faz o mesmo (sintaxe TypeScript, sem checagem de tipos — ver
  limitação no cabeçalho do script) pras Edge Functions.
- **O que esse linter NÃO faz**: checagem de tipos nas Edge Functions (isso
  exigiria o CLI do Deno, `deno check`, não instalado no ambiente onde este
  documento foi escrito) — hoje esse tipo de erro só apareceria no
  `supabase functions deploy`, que falha alto e claro quando acontece.
  Também não faz uma auditoria de qualidade/segurança mais profunda —
  pra isso, o comando `/code-review ultra` (Claude Code, multi-agente, sob
  demanda) é a ferramenta recomendada antes do Alfa 2.
- **Estado no momento desta organização**: `npm run lint` passa limpo;
  varredura manual não achou `console.log`, `TODO`/`FIXME` esquecidos, nem
  classes de cor "órfãs" (de uma paleta antiga que teria ficado pra trás
  numa troca de tema) — o código está mais organizado do que o esperado
  pra esse estágio do projeto.

## 9. Pipeline de deploy (os dois alvos são diferentes)

O pipeline clássico "Código → Linter → Builder → Produção" não se aplica
igual nos dois alvos de deploy deste projeto:

- **Web (Vercel) — é o que a Camila vai usar**: `Código → Produção`,
  direto. Não existe "builder" pra essa parte porque não existe artefato
  diferente pra gerar — o `index.html` commitado **é** o que vai pro ar; o
  Babel transpila no navegador de quem acessa. `.vercelignore` já configura
  o deploy pra mandar só o necessário (efetivamente, `index.html`).
- **Desktop (Windows/Electron)**: aqui sim existe um builder — já pronto,
  `electron-builder` (`npm run dist`), que gera o instalador em `dist/`.

### Checklist pra colocar a versão web no ar (Vercel)

O código já está pronto pro deploy estático; o que falta é **infraestrutura
de deploy**, não código:

1. `git remote add origin <url-do-repositorio-no-github>` (o repositório
   local não tem nenhum remoto configurado ainda) + `git push -u origin
   master`.
2. Conectar esse repositório a um projeto novo no Vercel (dashboard do
   Vercel → "Add New Project" → importar do GitHub). Framework preset:
   "Other" / estático — não precisa de build command nem output directory
   customizados, é servir `index.html` direto.
3. **Não precisa de nenhuma variável de ambiente secreta** — a
   `SUPABASE_ANON_KEY` já está no código de propósito (é uma chave pública
   por design do Supabase, protegida pelas policies de RLS no banco, não
   por estar escondida).
4. **Passo que costuma ser esquecido**: depois que o Vercel gerar o domínio
   final (ex. `jurisconrol.vercel.app` ou um domínio próprio), registrar
   esse domínio nas *Redirect URLs* / *Site URL* do painel do Supabase
   (Authentication → URL Configuration) — sem isso, o login funciona em
   `localhost`/Electron mas falha silenciosamente em produção.
5. Teste fim a fim na URL de produção (não só local): criar conta,
   confirmar RLS/dados isolados por usuário, testar IA gratuita, testar
   integração TJRJ.

## 10. Respostas diretas (registradas por escrito, pra referência)

**Já dá pra lançar uma versão beta de controle?** Sim, no sentido que a
própria definição de Beta 1.0 do roadmap prevê ("exatamente como está
agora" — ver `ROADMAP.txt`). A base funcional é real (não é protótipo):
autenticação, dados na nuvem com isolamento por usuário, TJRJ e DataJud
reais, IA com 3 provedores, gerador de documentos, financeiro, kanban. As
lacunas conhecidas (jurisprudência do STF/STJ simulada, sem testes
automatizados) são aceitáveis pra um piloto de 1 usuária. O que falta é
**processo de deploy** (seção 9), não código.

**Em que ponto do pipeline Código → Linter → Builder → Produção estamos?**
Ver seção 9 — o pipeline não é o mesmo pros dois alvos. Pro alvo que
importa agora (web/Vercel): Linter já existe (esta rodada), não há
"Builder" por desenho da arquitetura, e falta só a etapa de infraestrutura
de deploy (conectar repositório + Vercel) pra chegar em Produção.
