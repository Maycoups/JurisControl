// Edge Function: busca-jurisprudencia
// Recebe { termo, uf? } e devolve { resultados, fonte, mensagem }.
//
// Só TJRJ por enquanto — de propósito. STF, STJ e tribunais de outros estados
// saíram do escopo desta function: testado na prática (curl direto), os dois
// bloqueiam acesso automatizado com mais rigor que o TJRJ (STJ/SCON devolve
// bloqueio de WAF, STF devolve 403 já na primeira requisição, sem um endpoint
// alternativo óbvio como o eproc do TJRJ). Não fazemos scraping evasivo pra
// contornar isso (arriscaria a reputação do IP de saída do projeto, que
// também é usado pelo TJRJ/DJEN que funcionam de verdade), então em vez de
// devolver dado simulado/fake pra esses tribunais, a function simplesmente
// não os atende — volta quando houver uma fonte de dados real pra eles.
//
// FONTE PRIMÁRIA: LexML Brasil (Rede de Informação Legislativa e Jurídica)
// https://www.lexml.gov.br/ — agrega legislação e jurisprudência de vários
// tribunais (inclusive TJRJ) que publicam nessa rede. Protocolo SRU
// (Search/Retrieve via URL) padrão da Library of Congress, consulta em CQL.
// Endpoint: https://www.lexml.gov.br/busca/SRU?operation=searchRetrieve&query=<CQL>
// Na prática costuma estar bloqueado por verificação anti-bot do Senado.
//
// FONTE SECUNDÁRIA (fallback real): sistema eproc do próprio TJRJ — busca de
// jurisprudência pública, sem autenticação e sem CAPTCHA, direto na base de
// acórdãos e decisões monocráticas do tribunal.
// Endpoint: https://eproc1g.tjrj.jus.br/eproc/externo_controlador.php?acao=jurisprudencia@jurisprudencia/listar_resultados
//
// Tenta o LexML primeiro; se bloquear, cai pro eproc do TJRJ; se os dois
// falharem, devolve resultado vazio com uma mensagem clara — nunca dado
// simulado/fake.

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

  if (!termo) {
    return jsonResponse({ error: "Informe um termo de pesquisa (ex: assunto do processo)." }, 400);
  }

  // 1ª tentativa: LexML (mais amplo — agrega vários tribunais, incluindo TJRJ).
  try {
    const resultados = await buscarLexML(termo);
    return jsonResponse({
      resultados,
      fonte: "lexml",
      mensagem:
        resultados.length > 0
          ? `${resultados.length} resultado(s) reais do LexML.`
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
        fonte: "tjrj",
        mensagem:
          resultados.length > 0
            ? `LexML indisponível no momento (${errMsg(lexmlErr)}). Mostrando ${resultados.length} resultado(s) reais do TJRJ (eproc).`
            : "LexML indisponível e nenhum resultado encontrado no TJRJ para este termo.",
      });
    } catch (tjrjErr) {
      console.error("eproc TJRJ também indisponível:", tjrjErr);
      // Nunca dado simulado/fake — resultado vazio com o motivo real.
      return jsonResponse({
        resultados: [],
        fonte: "indisponivel",
        mensagem: `Não foi possível consultar jurisprudência agora — LexML (${errMsg(lexmlErr)}) e TJRJ (${errMsg(tjrjErr)}) indisponíveis. Tente novamente em alguns minutos.`,
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
    // Texto integral do dispositivo/decisão — o eproc já entrega isso escondido num
    // div "completo" (o "limitado" corta em 5000 caracteres); usamos pra permitir
    // ler a decisão inteira no próprio site, sem precisar sair do JurisControl.
    const decisaoIntegral = extrairPrimeiro(bloco, /id="campo-completo-[^"]*-DECIS[ÃA]O"[^>]*>([\s\S]*?)<\/div>/i);

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
      decisaoIntegral: decisaoIntegral ? decodificarEntidades(decisaoIntegral) : "",
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
  decisaoIntegral?: string;
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

