// Edge Function: criar-peca-ia
// Recebe { tarefa, contexto, provedor?, apiKey?, modelo? } e devolve { texto }.
//
// Assistente de IA do JurisControl, usado em vários lugares:
//   - Aba "Criação de Peças (IA)" -> tarefa 'minuta', contexto = { tipoPeca, instrucoes, cliente?, processo? }
//   - Painel de IA nos detalhes de um processo -> 'resumo'/'proximo_passo', contexto = { processo }
//   - Meus Modelos / Gerador de Documentos -> 'modelo_documento' (cria do zero, com placeholders),
//     'revisar_texto' (ajusta um texto já preenchido com dados reais, sem introduzir placeholders)
//   - Calculadora de Prazos -> 'sugestao_prazo', contexto = { instrucoes }
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
//      Provedores aceitos em BYOK: "gemini", "anthropic" e "openai".
//
// IMPORTANTE: não existe fallback pra uma chave da casa pra Anthropic nem pra
// OpenAI — os dois só estão disponíveis via BYOK. Isso existe de propósito:
// era o principal risco de custo (modelos pagos por token desde a primeira
// chamada, diferente do free tier do Gemini).
//
// Todo texto gerado é sempre uma SUGESTÃO/MINUTA — precisa de revisão humana
// antes de qualquer uso real, e a função deixa isso explícito na resposta.
//
// Esta função exige um usuário autenticado do JurisControl (ver _shared/auth.ts).

import Anthropic from "npm:@anthropic-ai/sdk";
import OpenAI from "npm:openai";
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
const GEMINI_MODELO_PADRAO = "gemini-3.6-flash";
const LIMITE_GRATUITO_MENSAL = 10;

const MODELO_ANTHROPIC_PADRAO = "claude-sonnet-5";
const MODELOS_ANTHROPIC_PERMITIDOS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"];

const MODELO_OPENAI_PADRAO = "gpt-5.1";
const MODELOS_OPENAI_PERMITIDOS = ["gpt-5.1", "gpt-5.1-mini"];

const PROVEDORES_VALIDOS = ["gemini", "anthropic", "openai"] as const;
type Provedor = (typeof PROVEDORES_VALIDOS)[number];

const TAREFAS_VALIDAS = ["minuta", "resumo", "proximo_passo", "modelo_documento", "sugestao_prazo", "revisar_texto"] as const;
type Tarefa = (typeof TAREFAS_VALIDAS)[number];

const SYSTEM_PROMPT = `Você é um assistente jurídico especializado em direito brasileiro, integrado ao sistema JurisControl de um(a) advogado(a) autônomo(a).

Sua função é auxiliar na gestão de processos e na redação de peças, sempre produzindo texto para REVISÃO HUMANA — nunca para uso direto sem revisão.

Regras gerais:
- Escreva em português do Brasil, em linguagem jurídica formal e tecnicamente correta.
- Use apenas os dados de cliente/processo fornecidos no contexto (ou já presentes no texto que lhe for enviado pra revisão). Quando um dado necessário não for fornecido nem estiver no texto, use um placeholder claro entre colchetes, como [OAB Nº 000.000], nunca invente informações factuais.
- Não invente jurisprudência, súmulas ou precedentes específicos com número/data — se for citar, cite de forma genérica (ex: "conforme entendimento consolidado dos tribunais superiores") a menos que o contexto forneça a fonte.
- Nunca use formatação markdown (sem **negrito**, *itálico*, #títulos, listas com -/*, etc.) — devolva texto simples, como um documento jurídico de verdade seria digitado.
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
      textoAtual?: string;
      // Resultados reais de supabase/functions/busca-jurisprudencia (LexML/TJRJ),
      // já buscados pelo front-end antes de chamar esta function — nunca gerados
      // aqui. Servem pra fundamentar a tese com jurisprudência de verdade, com
      // link, em vez do modelo "inventar" precedentes.
      jurisprudencia?: Array<{ titulo?: string; tribunal?: string; ementa?: string; link?: string; data?: string }>;
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
  if ((tarefa === "modelo_documento" || tarefa === "sugestao_prazo" || tarefa === "revisar_texto") && !(contexto.instrucoes ?? "").toString().trim()) {
    return jsonResponse({ error: "Descreva o que você precisa." }, 400);
  }
  if (tarefa === "revisar_texto" && !(contexto.textoAtual ?? "").toString().trim()) {
    return jsonResponse({ error: "Texto atual ausente no contexto." }, 400);
  }

  const chaveByok = (body.apiKey ?? "").toString().trim() || null;
  const usandoChavePropria = !!chaveByok;
  // Sem chave própria, o único provedor disponível é o gratuito (Gemini) —
  // ignora um `provedor: "anthropic"` sem chave em vez de deixar passar sem cobrança.
  const provedor: Provedor = usandoChavePropria && PROVEDORES_VALIDOS.includes(body.provedor as Provedor)
    ? (body.provedor as Provedor)
    : "gemini";

  const userPrompt = montarPrompt(tarefa, processo, contexto.cliente, contexto.tipoPeca, contexto.instrucoes, contexto.textoAtual, contexto.jurisprudencia);

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
    } else if (provedor === "openai") {
      const modelo = MODELOS_OPENAI_PERMITIDOS.includes(body.modelo ?? "")
        ? (body.modelo as string)
        : MODELO_OPENAI_PADRAO;
      modeloUsado = modelo;

      const openai = new OpenAI({ apiKey: chaveByok as string });
      const resposta = await openai.chat.completions.create({
        model: modelo,
        max_completion_tokens: 4000,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      });

      const escolha = resposta.choices[0];
      if (escolha?.finish_reason === "content_filter") {
        return jsonResponse(
          { error: "A IA recusou-se a gerar este conteúdo (filtro de conteúdo). Revise o pedido e tente novamente com mais contexto." },
          422,
        );
      }

      textoGerado = (escolha?.message?.content ?? "").trim();
      if (!textoGerado) {
        return jsonResponse(
          { error: "A IA não retornou texto. Tente reformular o pedido." },
          422,
        );
      }
      if (resposta.usage) {
        tokensUsados = { entrada: resposta.usage.prompt_tokens, saida: resposta.usage.completion_tokens };
      }
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
  textoAtual?: string,
  jurisprudencia?: Array<{ titulo?: string; tribunal?: string; ementa?: string; link?: string; data?: string }>,
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
      `\nEstruture a peça de acordo com as praxes forenses brasileiras (endereçamento, qualificação das partes, fatos, fundamentos jurídicos com citação de dispositivos legais pertinentes, pedidos, valor da causa, fechamento). Use os títulos de seção tradicionais em MAIÚSCULAS, cada um em linha própria (ex.: DOS FATOS, DO DIREITO, DOS PEDIDOS).`,
    );

    const jurisValida = (jurisprudencia ?? []).filter(j => (j.ementa || j.titulo));
    if (jurisValida.length > 0) {
      const blocoJuris = jurisValida.slice(0, 5).map((j, i) =>
        `[${i + 1}] ${j.tribunal || "Tribunal não informado"} — ${j.titulo || "sem título"}${j.data ? ` (${j.data.slice(0, 10)})` : ""}\nEmenta/trecho: ${(j.ementa || "").slice(0, 500)}`
      ).join("\n\n");
      partes.push(
        `\nJurisprudência real levantada sobre o tema (fonte: consulta pública ao tribunal, já verificada — pode ser citada especificamente, inclusive apontando o número entre colchetes [1], [2] etc. para indicar qual referência fundamenta cada trecho):\n${blocoJuris}`,
        `\nCom base nessa jurisprudência, desenvolva UMA tese jurídica principal fundamentada nela. Ao final da peça, em bloco separado com o título "TESE ALTERNATIVA (SUGESTÃO GENÉRICA)", ofereça em poucas frases uma segunda linha de argumentação que NÃO dependa dessa jurisprudência específica — uma alternativa genérica para o(a) advogado(a) comparar.`,
      );
    } else {
      partes.push(
        `\nNão foi encontrada jurisprudência específica para este tema na consulta automática. Desenvolva a fundamentação com base na legislação aplicável. Ao final da peça, em bloco separado com o título "TESE ALTERNATIVA (SUGESTÃO GENÉRICA)", ofereça em poucas frases uma linha de argumentação alternativa para o(a) advogado(a) comparar.`,
      );
    }

    partes.push(
      `\nTudo isso — a tese principal e a alternativa — são SUGESTÕES DE PARTIDA: deixe explícito que cabe ao(à) advogado(a) revisar, aprofundar e adaptar antes de usar. Ao final de tudo, inclua em linha separada: "${AVISO_MINUTA}"`,
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

  if (tarefa === "proximo_passo") {
    return [
      "Com base na fase atual e no próximo prazo (se houver) do processo abaixo, sugira em até 5 frases qual deve ser o próximo passo processual do(a) advogado(a) — ex: providência a tomar, peça a preparar, prazo a observar.",
      dadosProcesso,
      `\nSe não houver prazo/fase suficiente para uma sugestão específica, diga isso explicitamente em vez de inventar um próximo passo.\nAo final, inclua em linha separada: "${AVISO_SUGESTAO}"`,
    ].join("\n");
  }

  if (tarefa === "modelo_documento") {
    return [
      `Redija um MODELO REUTILIZÁVEL de documento jurídico com base nesta descrição: "${(instrucoes ?? "").trim()}".`,
      "Este texto vai virar um modelo salvo pelo(a) advogado(a) para reutilizar em vários casos diferentes — por isso, em vez de dados específicos de um cliente/processo, use OBRIGATORIAMENTE estes placeholders onde fizer sentido: {{cliente.nome}}, {{cliente.documento}}, {{cliente.endereco}}, {{cliente.cidade}}, {{cliente.uf}}, {{processo.numero}}, {{processo.vara}}, {{processo.acao}}, {{advogado.nome}}, {{advogado.oab}}, {{data}}.",
      "Estruture de acordo com as praxes forenses brasileiras (endereçamento quando aplicável, qualificação das partes usando os placeholders, corpo do texto, fechamento com assinatura).",
      "Devolva SÓ o texto do modelo (com os placeholders), sem explicações antes ou depois.",
    ].join("\n");
  }

  if (tarefa === "revisar_texto") {
    return [
      "O texto abaixo JÁ ESTÁ PREENCHIDO com dados reais de um cliente/processo verdadeiro — ele não é um modelo nem um rascunho incompleto. Todo nome, número, valor, endereço e data que aparecem nele são informações reais e corretas, não placeholders faltando preenchimento.",
      `Sua tarefa é só revisar/ajustar esse texto aplicando esta instrução do(a) advogado(a): "${(instrucoes ?? "").trim()}".`,
      "Regra mais importante: mantenha TODOS os dados reais já presentes no texto exatamente como estão (nomes, números de processo, valores, endereços, datas etc.) — NÃO substitua nenhum deles por placeholders como {{...}} ou [...], e não invente dados novos. Ajuste só o que a instrução pedir (redação, tom, estrutura, inclusão/remoção de trechos), preservando o resto do texto ao pé da letra.",
      dadosCliente,
      dadosProcesso,
      `\n--- TEXTO ATUAL A REVISAR ---\n${(textoAtual ?? "").trim()}`,
      "\nDevolva SÓ o texto revisado completo (mesmo formato de documento, sem markdown), sem explicações antes ou depois.",
    ].filter(Boolean).join("\n");
  }

  // sugestao_prazo
  return [
    `O(a) advogado(a) descreveu esta situação processual: "${(instrucoes ?? "").trim()}".`,
    "Identifique, com base no CPC (Código de Processo Civil brasileiro) e na prática forense, qual é o prazo processual aplicável (em dias, indicando se são dias úteis ou corridos), a partir de quando ele começa a contar, e cite o dispositivo legal correspondente quando souber com segurança.",
    "Se a situação for ambígua ou não permitir identificar o prazo com segurança, diga isso explicitamente e liste as hipóteses mais prováveis em vez de inventar um número.",
    `Responda em até 5 frases.\nAo final, inclua em linha separada: "${AVISO_SUGESTAO} Confira sempre a contagem no sistema oficial do tribunal."`,
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
