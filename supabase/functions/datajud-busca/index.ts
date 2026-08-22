// Edge Function: datajud-busca
// Recebe { numeroCNJ, apiKey? } e devolve { movimentacoes, classe, orgaoJulgador,
// dataAjuizamento, assuntos, ultimaMovimentacao, tribunal, fonte, mensagem }.
// classe/orgaoJulgador/dataAjuizamento/assuntos/ultimaMovimentacao existem pra
// alimentar o preenchimento automático (e o botão de reiniciar) dos campos
// Andamento/Classe Judicial/Vara do processo — ver DataJudPanel no index.html.
//
// FONTE: API Pública do DataJud (CNJ) — https://datajud-wiki.cnj.jus.br/api-publica/
// Endpoint por tribunal: https://api-publica.datajud.cnj.jus.br/api_publica_{alias}/_search
//
// A API do DataJud é pública e usa uma chave PÚBLICA COMPARTILHADA, divulgada
// oficialmente pelo CNJ na wiki (https://datajud-wiki.cnj.jus.br/api-publica/) — não é
// preciso cadastro nem chave pessoal. Por isso ela está embutida abaixo como padrão
// (DEFAULT_DATAJUD_API_KEY): é segura de manter no código porque é, por definição,
// pública e igual para todos os consumidores da API.
//
// A chave usada em cada chamada é resolvida nesta ordem de prioridade:
//   1. `apiKey` no corpo da requisição — permite que o app envie uma chave diferente
//      guardada no armazenamento local seguro (Configurações > safeStorage do Electron),
//      caso o CNJ troque o modelo no futuro ou o usuário tenha uma chave própria.
//   2. A secret DATAJUD_API_KEY configurada no projeto Supabase (opcional):
//        supabase secrets set DATAJUD_API_KEY=sua-chave-aqui
//   3. DEFAULT_DATAJUD_API_KEY (a chave pública oficial, usada por padrão).
//
// A chamada real ao DataJud é feita aqui (server-side), nunca direto do front-end —
// evita bloqueio de CORS numa requisição com header Authorization custom.

import { verificarUsuarioAutenticado, respostaNaoAutenticado } from "../_shared/auth.ts";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DATAJUD_BASE = "https://api-publica.datajud.cnj.jus.br";
const MAX_MOVIMENTACOES = 30;

// Chave pública oficial do DataJud (divulgada pelo CNJ, mesma para todos). Ver comentário acima.
const DEFAULT_DATAJUD_API_KEY = "cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw";

// Mapeamento "segmento(J).tribunal(TR)" do número CNJ -> alias do endpoint DataJud.
// Cobre os tribunais que aparecem nos dados de exemplo do JurisControl e os solicitados
// pelo usuário (TJSP, TJRJ, TRT-2, TRF-3, TRF-2, STJ). Para adicionar outro: descubra o
// par J.TR no número do processo (formato NNNNNNN-DD.AAAA.J.TR.OOOO) e o alias oficial
// do endpoint na wiki (https://datajud-wiki.cnj.jus.br/api-publica/endpoints/), e inclua
// uma linha aqui.
const CNJ_TRIBUNAL_MAP: Record<string, string> = {
  "8.26": "api_publica_tjsp", // TJSP
  "8.19": "api_publica_tjrj", // TJRJ
  "5.02": "api_publica_trt2", // TRT da 2ª Região (SP)
  "4.03": "api_publica_trf3", // TRF da 3ª Região (SP/MS)
  "4.02": "api_publica_trf2", // TRF da 2ª Região (RJ/ES)
  "3.00": "api_publica_stj", // STJ
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Método não suportado. Use POST." }, 405);
  }

  // Exige usuário logado no JurisControl — evita virar proxy público para o
  // DataJud (uso indevido por quem descobrir a URL).
  const usuario = await verificarUsuarioAutenticado(req);
  if (!usuario) return respostaNaoAutenticado(CORS_HEADERS);

  let body: { numeroCNJ?: string; apiKey?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Corpo da requisição inválido (esperado JSON)." }, 400);
  }

  const apiKey = (body.apiKey && body.apiKey.trim())
    || Deno.env.get("DATAJUD_API_KEY")
    || DEFAULT_DATAJUD_API_KEY;

  const numeroBruto = (body.numeroCNJ ?? "").toString().trim();
  const digitos = numeroBruto.replace(/\D/g, ""); // DataJud indexa numeroProcesso sem pontuação (20 dígitos)

  if (digitos.length !== 20) {
    return jsonResponse(
      { error: "Número de processo inválido. Esperado o formato CNJ NNNNNNN-DD.AAAA.J.TR.OOOO." },
      400,
    );
  }

  // Posições dentro dos 20 dígitos (NNNNNNN=7, DD=2, AAAA=4, J=1, TR=2, OOOO=4).
  const segmento = digitos.slice(13, 14); // J
  const tribunalCodigo = digitos.slice(14, 16); // TR
  const chaveMapa = `${Number(segmento)}.${tribunalCodigo}`;

  const alias = CNJ_TRIBUNAL_MAP[chaveMapa];
  if (!alias) {
    return jsonResponse(
      {
        error:
          `Tribunal não mapeado para este número (segmento.tribunal = ${chaveMapa}). ` +
          `Adicione o alias correspondente em CNJ_TRIBUNAL_MAP (supabase/functions/datajud-busca/index.ts) — ` +
          `veja o comentário no topo do arquivo para instruções.`,
      },
      501,
    );
  }

  try {
    const resposta = await fetch(`${DATAJUD_BASE}/${alias}/_search`, {
      method: "POST",
      headers: {
        Authorization: `APIKey ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: { match: { numeroProcesso: digitos } } }),
    });

    if (!resposta.ok) {
      const texto = await resposta.text().catch(() => "");
      return jsonResponse(
        { error: `DataJud respondeu ${resposta.status}: ${texto || resposta.statusText}` },
        502,
      );
    }

    const json = await resposta.json();
    const hits = json?.hits?.hits ?? [];

    if (hits.length === 0) {
      return jsonResponse({
        movimentacoes: [],
        tribunal: alias,
        fonte: "datajud",
        mensagem: "Nenhum processo encontrado no DataJud para este número neste tribunal.",
      });
    }

    // Cada hit é a "capa" do processo indexada pelo tribunal; o array de movimentações
    // processuais fica em _source.movimentos (nome de campo padrão do DataJud). O
    // resto da "capa" (classe, órgão julgador, assuntos, data de ajuizamento) também
    // vem em _source — só não era aproveitado antes, ficava só o array de movimentos.
    const origem = hits[0]?._source ?? {};
    const movimentos = Array.isArray(origem.movimentos) ? origem.movimentos : [];

    const movimentacoes = movimentos
      .slice(0, MAX_MOVIMENTACOES)
      .map((m: Record<string, unknown>) => ({
        data: m.dataHora ?? null,
        codigo: m.codigo ?? null,
        nome: m.nome ?? "(sem descrição)",
      }))
      .sort((a: { data: string | null }, b: { data: string | null }) =>
        (b.data ?? "").localeCompare(a.data ?? ""),
      );

    const classe = (origem.classe as { nome?: string } | undefined)?.nome ?? null;
    const orgaoJulgador = (origem.orgaoJulgador as { nome?: string } | undefined)?.nome ?? null;
    const dataAjuizamento = (origem.dataAjuizamento as string | undefined) ?? null;
    const assuntos = Array.isArray(origem.assuntos)
      ? (origem.assuntos as Array<{ nome?: string }>).map((a) => a.nome).filter(Boolean)
      : [];
    // A movimentação mais recente já vem ordenada em 1º lugar acima — é o retrato
    // mais atual do "andamento" do processo, pronto pra sugerir como valor do campo.
    const ultimaMovimentacao = movimentacoes[0]?.nome ?? null;

    return jsonResponse({
      movimentacoes,
      classe,
      orgaoJulgador,
      dataAjuizamento,
      assuntos,
      ultimaMovimentacao,
      tribunal: alias,
      fonte: "datajud",
      mensagem: `${movimentacoes.length} movimentação(ões) encontrada(s) no DataJud.`,
    });
  } catch (err) {
    console.error("Erro ao consultar DataJud:", err);
    return jsonResponse({ error: `Erro ao consultar o DataJud: ${errMsg(err)}` }, 500);
  }
});

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
