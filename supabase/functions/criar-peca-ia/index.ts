// Edge Function: criar-peca-ia
// Recebe { tarefa, contexto, provedor?, apiKey?, modelo? } e devolve { texto }.
//
// Assistente de IA do JurisControl, usado em dois lugares:
//   - Aba "Criação de Peças (IA)" -> tarefa 'minuta', contexto = { tipoPeca, instrucoes, cliente?, processo? }
//   - Painel de IA nos detalhes de um processo -> as 3 tarefas, contexto sempre traz { processo }
//
// MODELO DE CUSTO (dois caminhos):
//   1. Plano gratuito (padrão, sem `apiKey` no corpo): usa o Gemini com uma chave
//      da CASA (secret GEMINI_API_KEY), dentro do free tier do Google — custo
//      zero pra quem administra o JurisControl. Limitado a
//      LIMITE_GRATUITO_MENSAL gerações/mês por usuário (tabela uso_ia_gratuita),
//      controlado aqui no servidor pra não dar pra burlar.
//   2. BYOK ("bring your own key"): o app manda `apiKey` (+ `provedor`) — a
//      chave de que o(a) próprio(a) advogado(a) conectou em Configurações. Nesse
//      caso não há limite nem contagem: o custo é 100% dela, na conta dela.
//      Provedores aceitos em BYOK: "gemini" e "anthropic".
//
// IMPORTANTE: não existe mais fallback pra uma chave da Anthropic da casa — o
// Claude só está disponível via BYOK. Isso existe de propósito: era o principal
// risco de custo (Opus/Sonnet são pagos por token desde a primeira chamada,
// diferente do free tier do Gemini).
//
// Todo texto gerado é sempre uma SUGESTÃO/MINUTA — precisa de revisão humana
// antes de qualquer uso real, e a função deixa isso explícito na resposta.
//
// Esta função exige um usuário autenticado do JurisControl (ver _shared/auth.ts).

import Anthropic from "npm:@anthropic-ai/sdk";
import { GoogleGenAI } from "npm:@google/genai";
import { createClient } from "npm:@supabase/supabase-js@2";
import { verificarUsuarioAutenticado, respostaNaoAutenticado } from "../_shared/auth.ts";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Modelo padrão do free tier — "flash" é a linha rápida/barata do Gemini, feita
// pra caber em cotas gratuitas. Se o Google lançar uma linha "flash" mais nova
// ainda coberta pelo free tier, é só trocar aqui.
const GEMINI_MODELO_PADRAO = "gemini-2.5-flash";
const LIMITE_GRATUITO_MENSAL = 10;

const MODELO_ANTHROPIC_PADRAO = "claude-sonnet-5";
const MODELOS_ANTHROPIC_PERMITIDOS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"];

const PROVEDORES_VALIDOS = ["gemini", "anthropic"] as const;
type Provedor = (typeof PROVEDORES_VALIDOS)[number];

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
    provedor?: string;
    apiKey?: string;
    modelo?: string;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Corpo da requisição inválido (esperado JSON)." }, 400);
  }

  const tarefa = (body.tarefa ?? "").toString().trim() as Tarefa;
  if (!TAREFAS_VALIDAS.includes(tarefa)) {
    return jsonResponse({ error: `Tarefa inválida. Use uma de: ${TAREFAS_VALIDAS.join(", ")}.` }, 400);
  }

  const contexto = body.contexto ?? {};
  const processo = contexto.processo ?? {};

  if (tarefa === "minuta" && !(contexto.tipoPeca ?? "").toString().trim()) {
    return jsonResponse({ error: "Selecione o tipo de peça a ser gerada." }, 400);
  }
  if ((tarefa === "resumo" || tarefa === "proximo_passo") && Object.keys(processo).length === 0) {
    return jsonResponse({ error: "Dados do processo ausentes no contexto." }, 400);
  }

  const chaveByok = (body.apiKey ?? "").toString().trim() || null;
  const usandoChavePropria = !!chaveByok;
  // Sem chave própria, o único provedor disponível é o gratuito (Gemini) —
  // ignora um `provedor: "anthropic"` sem chave em vez de deixar passar sem cobrança.
  const provedor: Provedor = usandoChavePropria && PROVEDORES_VALIDOS.includes(body.provedor as Provedor)
    ? (body.provedor as Provedor)
    : "gemini";

  const userPrompt = montarPrompt(tarefa, processo, contexto.cliente, contexto.tipoPeca, contexto.instrucoes);

  // --- Plano gratuito: checa e reserva a cota ANTES de gastar a chamada ---
  let clienteAdmin: ReturnType<typeof createClient> | null = null;
  let novaContagem = 0;
  const mesAtual = new Date().toISOString().slice(0, 7); // 'YYYY-MM'

  if (!usandoChavePropria) {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ error: "Configuração do servidor incompleta (uso gratuito)." }, 500);
    }
    clienteAdmin = createClient(supabaseUrl, serviceRoleKey);

    const { data: usoAtual, error: erroUso } = await clienteAdmin
      .from("uso_ia_gratuita")
      .select("contagem")
      .eq("user_id", usuario.id)
      .eq("mes", mesAtual)
      .maybeSingle();
    if (erroUso) {
      console.error("Erro ao consultar uso gratuito:", erroUso);
      return jsonResponse({ error: "Erro ao verificar seu limite gratuito. Tente novamente." }, 500);
    }

    const contagemAtual = usoAtual?.contagem ?? 0;
    if (contagemAtual >= LIMITE_GRATUITO_MENSAL) {
      return jsonResponse(
        {
          error:
            `Você atingiu o limite gratuito de ${LIMITE_GRATUITO_MENSAL} gerações este mês. ` +
            'Conecte sua própria chave (Gemini ou Anthropic) em "Configurações" para uso ilimitado, ou aguarde o próximo mês.',
          limiteAtingido: true,
        },
        429,
      );
    }
    novaContagem = contagemAtual + 1;
  }

  try {
    let textoGerado = "";
    let modeloUsado = "";
    let tokensUsados: { entrada: number; saida: number } | undefined;

    if (provedor === "anthropic") {
      const modelo = MODELOS_ANTHROPIC_PERMITIDOS.includes(body.modelo ?? "")
        ? (body.modelo as string)
        : MODELO_ANTHROPIC_PADRAO;
      modeloUsado = modelo;

      const anthropic = new Anthropic({ apiKey: chaveByok as string });
      const mensagem = await anthropic.messages.create({
        model: modelo,
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      });

      if (mensagem.stop_reason === "refusal") {
        return jsonResponse(
          { error: "A IA recusou-se a gerar este conteúdo. Revise o pedido e tente novamente com mais contexto." },
          422,
        );
      }

      textoGerado = mensagem.content
        .filter((bloco): bloco is Anthropic.TextBlock => bloco.type === "text")
        .map((bloco) => bloco.text)
        .join("\n");
      tokensUsados = { entrada: mensagem.usage.input_tokens, saida: mensagem.usage.output_tokens };
    } else {
      // provedor === "gemini" (gratuito da casa, ou BYOK com chave própria do Gemini)
      const chaveGemini = chaveByok || Deno.env.get("GEMINI_API_KEY");
      if (!chaveGemini) {
        return jsonResponse(
          {
            error:
              'IA gratuita indisponível: o administrador ainda não configurou a chave do Gemini no servidor ' +
              '("supabase secrets set GEMINI_API_KEY=..."). Conecte sua própria chave em "Configurações" enquanto isso.',
          },
          500,
        );
      }
      modeloUsado = GEMINI_MODELO_PADRAO;

      const ai = new GoogleGenAI({ apiKey: chaveGemini });
      const resposta = await ai.models.generateContent({
        model: GEMINI_MODELO_PADRAO,
        contents: userPrompt,
        config: { systemInstruction: SYSTEM_PROMPT, maxOutputTokens: 4000 },
      });

      textoGerado = (resposta.text ?? "").trim();
      if (!textoGerado) {
        return jsonResponse(
          { error: "A IA não retornou texto (possível bloqueio de segurança do provedor). Tente reformular o pedido." },
          422,
        );
      }
      const uso = resposta.usageMetadata;
      if (uso) {
        tokensUsados = { entrada: uso.promptTokenCount ?? 0, saida: uso.candidatesTokenCount ?? 0 };
      }
    }

    // Só grava a contagem depois que a geração deu certo (não cobra cota por chamada que falhou).
    let usoGratuito: { usadas: number; limite: number } | undefined;
    if (!usandoChavePropria && clienteAdmin) {
      const { error: erroGravar } = await clienteAdmin
        .from("uso_ia_gratuita")
        .upsert({ user_id: usuario.id, mes: mesAtual, contagem: novaContagem, atualizado_em: new Date().toISOString() });
      if (erroGravar) console.error("Erro ao gravar contagem de uso gratuito:", erroGravar);
      usoGratuito = { usadas: novaContagem, limite: LIMITE_GRATUITO_MENSAL };
    }

    return jsonResponse({
      texto: textoGerado,
      tarefa,
      provedor,
      modelo: modeloUsado,
      tokensUsados,
      usoGratuito,
    });
  } catch (err) {
    console.error("Erro ao chamar assistente de IA:", err);
    return jsonResponse(
      { error: `Erro ao chamar a IA (${provedor}): ${errMsg(err)}. Verifique se a chave é válida e tem créditos/cota.` },
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
