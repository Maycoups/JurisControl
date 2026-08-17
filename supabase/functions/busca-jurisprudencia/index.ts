// Edge Function: busca-jurisprudencia
// Recebe { termo, uf? } e devolve { resultados, simulado, fonte, mensagem }.
//
// FONTE PRIMÁRIA: LexML Brasil (Rede de Informação Legislativa e Jurídica)
// https://www.lexml.gov.br/ — agrega legislação e jurisprudência de STF, STJ, TST e
// diversos tribunais estaduais (inclusive TJRJ) que publicam nessa rede. Protocolo
// SRU (Search/Retrieve via URL) padrão da Library of Congress, consulta em CQL.
// Endpoint: https://www.lexml.gov.br/busca/SRU?operation=searchRetrieve&query=<CQL>
// Na prática costuma estar bloqueado por verificação anti-bot do Senado.
//
// FONTE SECUNDÁRIA (fallback real): sistema eproc do próprio TJRJ — busca de
// jurisprudência pública, sem autenticação e sem CAPTCHA, direto na base de acórdãos
// e decisões monocráticas do tribunal. Como o JurisControl trabalha com processos do
// TJRJ, essa é a fonte mais relevante quando o LexML está fora do ar.
// Endpoint: https://eproc1g.tjrj.jus.br/eproc/externo_controlador.php?acao=jurisprudencia@jurisprudencia/listar_resultados
//
// Tenta a consulta real (LexML) primeiro; se bloquear (timeout, XML inesperado),
// cai para o eproc do TJRJ; se os dois falharem, cai para dados de demonstração —
// o front-end é avisado via `simulado`/`mensagem` em qualquer um dos casos.

import { verificarUsuarioAutenticado, respostaNaoAutenticado } from "../_shared/auth.ts";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const LEXML_ENDPOINT = "https://www.lexml.gov.br/busca/SRU";
const MAX_RESULTADOS = 8;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Método não suportado. Use POST." }, 405);
  }

  // Exige usuário logado no JurisControl — evita virar proxy público para
  // LexML/TJRJ (uso indevido por quem descobrir a URL).
  const usuario = await verificarUsuarioAutenticado(req);
  if (!usuario) return respostaNaoAutenticado(CORS_HEADERS);

  let body: { termo?: string; uf?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Corpo da requisição inválido (esperado JSON)." }, 400);
  }

  const termo = (body.termo ?? "").toString().trim();
  const uf = (body.uf ?? "").toString().trim().toUpperCase();

  if (!termo) {
    return jsonResponse({ error: "Informe um termo de pesquisa (ex: assunto do processo)." }, 400);
  }

  // 1ª tentativa: LexML (mais amplo — agrega STF/STJ/TST/TJRJ e outros).
  try {
    const resultados = await buscarLexML(termo);
    return jsonResponse({
      resultados,
      simulado: false,
      fonte: "lexml",
      mensagem:
        resultados.length > 0
          ? `${resultados.length} resultado(s) reais do LexML (rede que agrega STF, STJ, TST e tribunais estaduais).`
          : "Nenhum resultado encontrado no LexML para este termo.",
    });
  } catch (lexmlErr) {
    console.error("LexML indisponível, tentando eproc TJRJ:", lexmlErr);

    // 2ª tentativa: busca de jurisprudência do eproc/TJRJ (cobertura só do TJRJ, mas
    // sem bloqueio anti-bot — funciona de fato via chamada de servidor).
    try {
      const resultados = await buscarTJRJ(termo);
      return jsonResponse({
        resultados,
        simulado: false,
        fonte: "tjrj",
        mensagem:
          resultados.length > 0
            ? `LexML indisponível no momento (${errMsg(lexmlErr)}). Mostrando ${resultados.length} resultado(s) reais do TJRJ (eproc).`
            : "LexML indisponível e nenhum resultado encontrado no TJRJ para este termo.",
      });
    } catch (tjrjErr) {
      console.error("eproc TJRJ também indisponível, retornando dados de demonstração:", tjrjErr);
      const resultados = gerarJurisprudenciaSimulada(termo, uf);
      return jsonResponse({
        resultados,
        simulado: true,
        fonte: "simulacao",
        mensagem: `Não foi possível consultar LexML (${errMsg(lexmlErr)}) nem o TJRJ (${errMsg(tjrjErr)}) agora. Exibindo dados de demonstração com a mesma estrutura da resposta real.`,
      });
    }
  }
});

// ---------------------------------------------------------------------------
// eproc/TJRJ (dados reais) — busca pública de jurisprudência do próprio tribunal,
// sem autenticação e sem CAPTCHA. Devolve HTML (não há API JSON documentada), então
// a resposta é parseada abaixo. A página responde em ISO-8859-1 (Latin-1), não UTF-8.
// ---------------------------------------------------------------------------

const TJRJ_EPROC_ENDPOINT =
  "https://eproc1g.tjrj.jus.br/eproc/externo_controlador.php?acao=jurisprudencia@jurisprudencia/listar_resultados";

async function buscarTJRJ(termo: string): Promise<ResultadoJurisprudencia[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let res: Response;
  try {
    const params = new URLSearchParams({
      txtPesquisa: termo,
      rdoCampo: "E", // busca no texto da ementa (mais preciso e rápido que inteiro teor)
      chkAgruparResultados: "on", // evita duplicar o mesmo julgado (acórdão + decisão monocrática)
    });
    res = await fetch(TJRJ_EPROC_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (compatible; JurisControl/1.0)",
      },
      body: params.toString(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`Consulta de jurisprudência do TJRJ respondeu HTTP ${res.status}`);
  }

  const buffer = await res.arrayBuffer();
  const html = new TextDecoder("iso-8859-1").decode(buffer);

  if (!html.includes("resultadoItem")) {
    // Nenhum resultado para o termo, ou página de erro/manutenção — trata como vazio.
    return [];
  }

  return parseRegistrosTJRJ(html).slice(0, MAX_RESULTADOS);
}

function parseRegistrosTJRJ(html: string): ResultadoJurisprudencia[] {
  const registros: ResultadoJurisprudencia[] = [];
  const blocos = html.split('class="card mb-3 resultadoItem"').slice(1);

  for (const bloco of blocos) {
    const numeroProcesso = extrairPrimeiro(bloco, /class="numero-processo"[^>]*>\s*([^<]+?)\s*<\/a>/i);
    const linkProcesso = extrairPrimeiro(bloco, /<a href="([^"]+)"[^>]*class="numero-processo"/i);
    const tipoDocumento = extrairPrimeiro(bloco, /class="resValueTipoJurisprudencia">([^<]*)<\/div>/i);
    const orgaoJulgador = extrairPrimeiro(
      bloco,
      /RG[ÃA]O JULGADOR<\/div>\s*<div class="resValue[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    );
    const relator = extrairPrimeiro(bloco, /RELATOR<\/div>\s*<div class="resValue[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const dataJulgamento = extrairPrimeiro(
      bloco,
      /DATA DO JULGAMENTO<\/div>\s*<div class="resValue[^"]*"[^>]*>([^<]*)<\/div>/i,
    );
    const ementaBruta = extrairPrimeiro(bloco, />EMENTA<\/div>\s*<div class="resValue[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

    if (!numeroProcesso && !ementaBruta) continue;

    registros.push({
      titulo: `${decodificarEntidades(tipoDocumento) || "Julgado"} — Processo ${numeroProcesso || "não informado"}`,
      ementa: decodificarEntidades(ementaBruta || "").slice(0, 400),
      tribunal:
        `TJRJ${orgaoJulgador ? ` — ${decodificarEntidades(orgaoJulgador)}` : ""}` +
        `${relator ? ` — Rel. ${decodificarEntidades(relator)}` : ""}`,
      data: converterDataBr(dataJulgamento),
      urn: numeroProcesso,
      link: linkProcesso,
    });
  }

  return registros;
}

function extrairPrimeiro(texto: string, regex: RegExp): string {
  const m = texto.match(regex);
  return m ? m[1].trim() : "";
}

function converterDataBr(data: string): string {
  const m = data.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : data;
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

interface ResultadoJurisprudencia {
  titulo: string;
  ementa: string;
  tribunal: string;
  data: string;
  urn: string;
  link: string;
}

// ---------------------------------------------------------------------------
// LexML (dados reais) — protocolo SRU, resposta em XML/Dublin Core
// ---------------------------------------------------------------------------

async function buscarLexML(termo: string): Promise<ResultadoJurisprudencia[]> {
  // CQL: restringe a documentos jurisprudenciais e busca o termo no índice padrão.
  const cql = `tipoDocumento any "jurisprudencia" and (${termo})`;
  const params = new URLSearchParams({
    operation: "searchRetrieve",
    version: "1.1",
    query: cql,
    startRecord: "1",
    maximumRecords: String(MAX_RESULTADOS),
  });
  const url = `${LEXML_ENDPOINT}?${params.toString()}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "Accept": "application/xml, text/xml",
        "User-Agent": "Mozilla/5.0 (compatible; JurisControl/1.0)",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`LexML respondeu HTTP ${res.status}`);
  }

  const xml = await res.text();

  if (!xml.includes("<srw:record") && !xml.includes("<record")) {
    // Página de bloqueio/verificação anti-bot ou formato inesperado — não é uma resposta SRU válida.
    throw new Error("Resposta do LexML não é um XML SRU válido (possível bloqueio anti-bot)");
  }

  return parseRegistrosLexML(xml).slice(0, MAX_RESULTADOS);
}

function parseRegistrosLexML(xml: string): ResultadoJurisprudencia[] {
  const registros: ResultadoJurisprudencia[] = [];
  const blocos = xml.split(/<(?:srw:)?record[ >]/i).slice(1);

  for (const bloco of blocos) {
    const titulo = extrairTag(bloco, "dc:title") || extrairTag(bloco, "title");
    const ementa = extrairTag(bloco, "dc:description") || extrairTag(bloco, "description");
    const urn = extrairTag(bloco, "dc:identifier") || extrairTag(bloco, "identifier");
    const data = extrairTag(bloco, "dc:date") || extrairTag(bloco, "date");
    const autoridade = extrairTag(bloco, "dc:publisher") || extrairTag(bloco, "publisher");

    if (!titulo && !ementa) continue;

    registros.push({
      titulo: decodificarEntidades(titulo || "Documento sem título"),
      ementa: decodificarEntidades(ementa || "").slice(0, 400),
      tribunal: decodificarEntidades(autoridade || "—"),
      data: data || "",
      urn: urn || "",
      link: urn ? `https://www.lexml.gov.br/urn/${encodeURIComponent(urn.replace(/^urn:lex:/, ""))}` : "",
    });
  }

  return registros;
}

function extrairTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? match[1].trim() : "";
}

function decodificarEntidades(texto: string): string {
  return texto
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Simulação (fallback quando o LexML está indisponível/bloqueado)
// ---------------------------------------------------------------------------

function gerarJurisprudenciaSimulada(termo: string, uf: string): ResultadoJurisprudencia[] {
  let seed = 0;
  for (const ch of termo) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  if (seed === 0) seed = 7;
  const proximo = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 0xffffffff;
  };

  const tribunais = ["STJ", "TJRJ", "TST", "STF", "TRF2"];
  const relatoresPorTribunal: Record<string, string[]> = {
    STJ: ["Min. Nancy Andrighi", "Min. Luis Felipe Salomão"],
    TJRJ: ["Des. Marco Aurélio Bezerra de Melo", "Des.ª Cristina Tereza Gaulia"],
    TST: ["Min. Maria Helena Mallmann"],
    STF: ["Min. Cármen Lúcia"],
    TRF2: ["Des. Fed. Ricardo Perlingeiro"],
  };

  const total = 2 + Math.floor(proximo() * 3);
  const resultados: ResultadoJurisprudencia[] = [];

  for (let i = 0; i < total; i++) {
    const tribunal = tribunais[Math.floor(proximo() * tribunais.length)];
    const relatores = relatoresPorTribunal[tribunal];
    const relator = relatores[Math.floor(proximo() * relatores.length)];
    const ano = 2022 + Math.floor(proximo() * 4);

    resultados.push({
      titulo: `${tribunal} — Julgado sobre "${termo}" (${ano})`,
      ementa: `EMENTA SIMULADA. Trata-se de demonstração relacionada ao termo "${termo}". Quando o LexML estiver acessível, este campo trará a ementa real do acórdão/decisão localizado.`,
      tribunal: `${tribunal} — Rel. ${relator}`,
      data: `${ano}-0${1 + Math.floor(proximo() * 9)}-1${Math.floor(proximo() * 9)}`,
      urn: "",
      link: "",
    });
  }

  return resultados;
}
