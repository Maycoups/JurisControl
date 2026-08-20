# JurisControl — Especificação: módulo de IA (BYOK + plano gratuito)

## Decisão tomada
- Orçamento inicial é zero. Não usar API paga por conta da casa no lançamento.
- Estratégia: **BYOK (bring your own key)**. O usuário cola a própria chave de API (Anthropic, OpenAI ou Google) e o sistema chama a API dele. Custo de uso fica 100% com o usuário.
- Plano gratuito por padrão: todo usuário novo já começa com IA ativa via camada gratuita (ex: Google Gemini free tier), com limite mensal de gerações (ex: 10/mês).
- Quem conecta a própria chave tem uso ilimitado (limitado apenas pelo próprio provedor).
- Sem login de conta de terceiros embutido no site (inviável: ChatGPT/Claude/Gemini bloqueiam iframe via X-Frame-Options/CSP, e não expõem forma de o site "operar" a conta do usuário). A única integração viável é API key.

## Fluxo do usuário
1. Usuário cria conta → já entra usando plano gratuito (Gemini free tier), sem precisar configurar nada.
2. Tela inicial mostra status "IA gratuita ativa · X de 10 gerações este mês".
3. Botão "Conectar sua IA" abre modal/bottom sheet:
   - Seleciona provedor: Claude (Anthropic) / ChatGPT (OpenAI) / Gemini (Google)
   - Cola a chave de API (campo password)
   - Link "Como gerar minha chave em 3 passos" → abre tela de tutorial
   - Chave salva **apenas no navegador do usuário** (ex: localStorage/IndexedDB local, nunca no backend) — importante para reduzir responsabilidade sobre dado sensível
4. Ao salvar, IA passa a rodar com a chave própria do usuário nas próximas gerações.

## Tela de tutorial (passo a passo da chave)
- 3 passos genéricos por provedor (acessar o console do provedor → criar/gerar chave → copiar e colar no JurisControl)
- Deve ter abas ou seleção de provedor (Claude / ChatGPT / Gemini), já que o passo a passo muda um pouco por provedor
- Links diretos para as páginas oficiais de geração de chave de cada provedor

## Notas técnicas para implementação
- Backend (Node/Electron) recebe: dados do processo + tarefa (ex: gerar embargos de declaração) → monta prompt → chama a API do provedor escolhido usando a chave (do usuário, se configurada, ou a chave da camada gratuita da casa, se não).
- Nunca logar/persistir a chave do usuário no servidor.
- Modelos-alvo iniciais: geração de peças processuais moderadamente complexas — RESP (Recurso Especial) e Embargos de Declaração.
- Atenção a risco de alucinação jurídica (citação de lei/jurisprudência incorreta) — considerar aviso visível de revisão humana obrigatória antes de protocolar qualquer peça gerada.

## Referência visual
Duas telas já prototipadas em HTML (anexas nesta conversa):
1. Tela inicial com status de IA gratuita + botão "Conectar sua IA" abrindo bottom sheet de seleção de provedor + chave.
2. Tela de tutorial passo a passo para gerar a chave de API por provedor.
