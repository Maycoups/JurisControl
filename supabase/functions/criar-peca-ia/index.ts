// Edge Function: criar-peca-ia
// Recebe { tarefa: 'minuta' | 'resumo' | 'proximo_passo', contexto, apiKey? } e devolve { texto }.
//
// Assistente de IA do JurisControl, usado em dois lugares:
//   - Aba "Criação de Peças (IA)" -> tarefa 'minuta', contexto = { tipoPeca, instrucoes, cliente?, processo? }
//   - Painel de IA nos detalhes de um processo -> as 3 tarefas, contexto sempre traz { processo }
//
// A chave da Anthropic pode vir de duas formas (nessa ordem de prioridade):
//   1. `apiKey` no corpo da requisição — enviada pelo app a partir do armazenamento local
//      seguro (Configurações > safeStorage do Electron). Usada só nesta chamada, nunca
//      persistida aqui.
//   2. A secret ANTHROPIC_API_KEY configurada no projeto Supabase:
//        supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//
// Modelo: claude-sonnet-5 por padrão — bom equilíbrio entre qualidade e custo para
// redação jurídica estruturada (o Opus custa sensivelmente mais por token; para uso
// pontual por advogado(a) autônomo(a) o Sonnet já entrega qualidade alta). Quem
// quiser mais qualidade (ao custo de mais $) pode enviar `modelo: "claude-opus-5"`
// no corpo da requisição; quem quiser o mais barato possível pode enviar
// `modelo: "claude-haiku-4-5-20251001"`. Todo texto gerado é sempre uma
// SUGESTÃO/MINUTA — precisa de revisão humana antes de qualquer uso real, e a
// função deixa isso explícito na resposta.
//
// Esta função exige um usuário autenticado do JurisControl (ver _shared/auth.ts) —
// sem isso, qualquer pessoa que descobrisse a URL poderia gastar a chave da
// Anthropic configurada no servidor.

import Anthropic from "npm:@anthropic-ai/sdk";
import { verificarUsuarioAutenticado, respostaNaoAutenticado } from "../_shared/auth.ts";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODELO_PADRAO = "claude-sonnet-5";
const MODELOS_PERMITIDOS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"];

const TAREFAS_VALIDAS = ["minuta", "resumo", "proximo_passo"] as const;
type Tarefa = (typeof TAREFAS_VALIDAS)[number];

const SYSTEM_PROMPT = `Você é um assistente jurídico especializado em direito brasileiro, integrado ao sistema JurisControl de um(a) advogado(a) autônomo(a).

Sua função é auxiliar na gestão de processos e na redação de peças, sempre produzindo texto para REVISÃO HUMANA — nunca para uso direto sem revisão.

Regras gerais:
- Escreva em português do Brasil, em linguagem jurídica formal e tecnicamente correta.
- Use apenas os dados de cliente/processo fornecidos no contexto. Quando um dado necessário não for fornecido (ex: OAB, endereço completo, valor exato), use um placeholder claro entre colchetes, como [OAB Nº 000.000], nunca invente informações factuais.
- Não invente jurisprudência, súmulas ou precedentes específicos com número/data — se for citar, cite de forma genérica (ex: "conforme entendimento consolidado dos tribunais superiores") a menos que o contexto forneça a fonte.
- Devolva apenas o texto pedido, sem comentários fora dele.`;

const AVISO_MINUTA =
  "⚠️ MINUTA GERADA POR IA — revise cuidadosamente antes de protocolar ou enviar. Verifique jurisprudência, prazos e dados factuais.";
const AVISO_SUGESTAO =
  "⚠️ SUGESTÃO GERADA POR IA — use como apoio à decisão, não como orientação definitiva.";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Método não suportado. Use POST." }, 405);
  }

  const usuario = await verificarUsuarioAutenticado(req);
  if (!usuario) return respostaNaoAutenticado(CORS_HEADERS);

  let body: {
    tarefa?: string;
    contexto?: {
      processo?: Record<string, unknown>;
      cliente?: Record<string, unknown>;
      tipoPeca?: string;
      instrucoes?: string;
    };
    apiKey?: string;
    modelo?: string;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Corpo da requisição inválido (esperado JSON)." }, 400);
  }

  const modelo = MODELOS_PERMITIDOS.includes(body.modelo ?? "") ? (body.modelo as string) : MODELO_PADRAO;

  const apiKey = (body.apiKey && body.apiKey.trim()) || Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return jsonResponse(
      {
        error:
          'Chave da API Anthropic não configurada. Configure-a na aba "Configurações" do app, ou rode "supabase secrets set ANTHROPIC_API_KEY=sk-ant-..." no seu terminal.',
      },
      500,
    );
  }

  const tarefa = (body.tarefa ?? "").toString().trim() as Tarefa;
  if (!TAREFAS_VALIDAS.includes(tarefa)) {
    return jsonResponse(
      { error: `Tarefa inválida. Use uma de: ${TAREFAS_VALIDAS.join(", ")}.` },
      400,
    );
  }

  const contexto = body.contexto ?? {};
  const processo = contexto.processo ?? {};

  if (tarefa === "minuta" && !(contexto.tipoPeca ?? "").toString().trim()) {
    return jsonResponse({ error: "Selecione o tipo de peça a ser gerada." }, 400);
  }
  if ((tarefa === "resumo" || tarefa === "proximo_passo") && Object.keys(processo).length === 0) {
    return jsonResponse({ error: "Dados do processo ausentes no contexto." }, 400);
  }

  const userPrompt = montarPrompt(tarefa, processo, contexto.cliente, contexto.tipoPeca, contexto.instrucoes);

  try {
    const anthropic = new Anthropic({ apiKey });
    const mensagem = await anthropic.messages.create({
      model: modelo,
      max_tokens: 4000, // ~3000 palavras, suficiente para a maioria das peças; reduz custo por chamada
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    if (mensagem.stop_reason === "refusal") {
      return jsonResponse(
        {
          error:
            "A IA recusou-se a gerar este conteúdo. Revise o pedido (pode ter sido interpretado como sensível) e tente novamente com mais contexto.",
        },
        422,
      );
    }

    const textoGerado = mensagem.content
      .filter((bloco): bloco is Anthropic.TextBlock => bloco.type === "text")
      .map((bloco) => bloco.text)
      .join("\n");

    return jsonResponse({
      texto: textoGerado,
      tarefa,
      modelo,
      tokensUsados: {
        entrada: mensagem.usage.input_tokens,
        saida: mensagem.usage.output_tokens,
      },
    });
  } catch (err) {
    console.error("Erro ao chamar assistente de IA:", err);
    return jsonResponse(
      { error: `Erro ao chamar a IA: ${errMsg(err)}. Verifique se a chave da Anthropic é válida e tem créditos.` },
      500,
    );
  }
});

function montarPrompt(
  tarefa: Tarefa,
  processo: Record<string, unknown>,
  cliente: Record<string, unknown> | undefined,
  tipoPeca?: string,
  instrucoes?: string,
): string {
  const dadosProcesso = Object.keys(processo).length > 0
    ? `\nDados do processo:\n${JSON.stringify(processo, null, 2)}`
    : "";
  const dadosCliente = cliente && Object.keys(cliente).length > 0
    ? `\nDados do cliente:\n${JSON.stringify(cliente, null, 2)}`
    : "";

  if (tarefa === "minuta") {
    const partes = [`Redija uma minuta de: ${tipoPeca}.`, dadosCliente, dadosProcesso];
    if (instrucoes && instrucoes.trim()) {
      partes.push(`\nInstruções adicionais do(a) advogado(a):\n${instrucoes.trim()}`);
    }
    partes.push(
      `\nEstruture a peça de acordo com as praxes forenses brasileiras (endereçamento, qualificação das partes, fatos, fundamentos jurídicos com citação de dispositivos legais pertinentes, pedidos, valor da causa, fechamento). Ao final, inclua em linha separada: "${AVISO_MINUTA}"`,
    );
    return partes.join("\n");
  }

  if (tarefa === "resumo") {
    return [
      "Resuma o processo abaixo em linguagem simples e objetiva, em até 6 frases, destacando: partes envolvidas, objeto da ação, fase atual e eventual prazo pendente.",
      dadosProcesso,
      `\nAo final, inclua em linha separada: "${AVISO_SUGESTAO}"`,
    ].join("\n");
  }

  // proximo_passo
  return [
    "Com base na fase atual e no próximo prazo (se houver) do processo abaixo, sugira em até 5 frases qual deve ser o próximo passo processual do(a) advogado(a) — ex: providência a tomar, peça a preparar, prazo a observar.",
    dadosProcesso,
    `\nSe não houver prazo/fase suficiente para uma sugestão específica, diga isso explicitamente em vez de inventar um próximo passo.\nAo final, inclua em linha separada: "${AVISO_SUGESTAO}"`,
  ].join("\n");
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
