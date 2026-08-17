// Edge Function: busca-tjrj
// Recebe { oab, uf } do front-end (JurisControl) e devolve { processos, simulado, fonte, mensagem }.
//
// FONTE REAL: DJEN — Diário de Justiça Eletrônico Nacional (CNJ)
// https://comunica.pje.jus.br/ | API: https://comunicaapi.pje.jus.br/api/v1/comunicacao
//
// O DJEN reúne as publicações/intimações processuais de TODOS os tribunais do país
// (incluindo o TJRJ) e é a ÚNICA fonte pública que realmente permite buscar por
// número de OAB, sem exigir convênio institucional. Parâmetros de consulta
// confirmados na especificação da API (SwaggerHub cnj/pcp):
//   numeroOab, ufOab, nomeAdvogado, nomeParte, numeroProcesso,
//   dataDisponibilizacaoInicio, dataDisponibilizacaoFim (todos opcionais, formato yyyy-mm-dd)
//
// Importante: o DJEN devolve COMUNICAÇÕES (citações/intimações), não a "capa" completa
// do processo (não há classe processual, valor da causa etc. — só o que gerou publicação).
// Para a capa completa por número de processo, seria necessário o MNI (convênio) ou o
// DataJud (metadados, sem indexação por OAB).
//
// Como o endpoint do DJEN fica atrás de proteção anti-bot (WAF) que pode bloquear
// chamadas de servidores na nuvem, esta função tenta a consulta real primeiro e,
// se falhar por qualquer motivo (bloqueio, timeout, formato inesperado), cai
// automaticamente para dados de demonstração — o front-end é avisado em ambos os casos
// via `simulado` e `mensagem`.

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DJEN_ENDPOINT = "https://comunicaapi.pje.jus.br/api/v1/comunicacao";
const JANELA_DIAS = 90; // últimos N dias de publicações consultados por padrão
const MAX_PROCESSOS = 30; // limite de processos distintos devolvidos ao front-end

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Método não suportado. Use POST." }, 405);
  }

  let body: { oab?: string; uf?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Corpo da requisição inválido (esperado JSON)." }, 400);
  }

  const oabBruta = (body.oab ?? "").toString().trim();
  const oab = oabBruta.replace(/\D/g, ""); // DJEN espera só dígitos
  const uf = (body.uf ?? "RJ").toString().trim().toUpperCase() || "RJ";

  if (!oab) {
    return jsonResponse({ error: "Informe o número da OAB." }, 400);
  }

  try {
    const real = await buscarComunicacoesDJEN(oab, uf);

    return jsonResponse({
      processos: real.processos,
      comunicacoes: real.comunicacoes,
      simulado: false,
      fonte: "djen",
      mensagem:
        real.processos.length > 0
          ? `Dados reais do DJEN (Diário de Justiça Eletrônico Nacional): ${real.totalComunicacoes} comunicação(ões) nos últimos ${JANELA_DIAS} dias, agrupadas em ${real.processos.length} processo(s). Isto são publicações/intimações, não a capa completa do processo (para isso seria necessário o MNI, via convênio com o TJRJ).`
          : `Nenhuma comunicação encontrada no DJEN para esta OAB nos últimos ${JANELA_DIAS} dias.`,
    });
  } catch (err) {
    console.error("Falha ao consultar o DJEN, retornando dados de demonstração:", err);
    const processos = gerarProcessosSimulados(oab, uf);
    return jsonResponse({
      processos,
      comunicacoes: processos.map((p, idx) => processoSimuladoParaComunicacao(p, idx)),
      simulado: true,
      fonte: "simulacao",
      mensagem: `Não foi possível consultar o DJEN agora (${errMsg(err)}). Exibindo dados de demonstração com a mesma estrutura da resposta real.`,
    });
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

interface ProcessoResultado {
  numero: string;
  classe: string;
  assunto: string;
  areaEstimada: string;
  orgaoJulgador: string;
  poloAtivo: string;
  poloPassivo: string;
  situacao: string;
  dataDistribuicao: string;
}

// Comunicação individual (não agrupada por processo) — usada pelo feed de Alertas.
interface ComunicacaoResultado {
  id: string; // chave estável para deduplicação no front-end
  numero: string;
  tipo: string;
  texto: string;
  orgaoJulgador: string;
  data: string;
  poloAtivo: string;
}

// ---------------------------------------------------------------------------
// DJEN (dados reais)
// ---------------------------------------------------------------------------

interface DestinatarioDJEN {
  nome?: string;
  polo?: string; // "A" (ativo) | "P" (passivo)
}

interface ComunicacaoDJEN {
  id?: number;
  hash?: string;
  numero_processo?: string;
  numeroprocessocommascara?: string;
  data_disponibilizacao?: string;
  datadisponibilizacao?: string;
  siglaTribunal?: string;
  nomeOrgao?: string;
  tipoComunicacao?: string;
  texto?: string;
  destinatarios?: DestinatarioDJEN[];
}

async function buscarComunicacoesDJEN(
  oab: string,
  uf: string,
): Promise<{ processos: ProcessoResultado[]; comunicacoes: ComunicacaoResultado[]; totalComunicacoes: number }> {
  const hoje = new Date();
  const inicio = new Date(hoje);
  inicio.setDate(inicio.getDate() - JANELA_DIAS);
  const fmt = (d: Date) => d.toISOString().split("T")[0];

  const params = new URLSearchParams({
    numeroOab: oab,
    ufOab: uf,
    dataDisponibilizacaoInicio: fmt(inicio),
    dataDisponibilizacaoFim: fmt(hoje),
  });

  const url = `${DJEN_ENDPOINT}?${params.toString()}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; JurisControl/1.0)",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`DJEN respondeu HTTP ${res.status}`);
  }

  const data = await res.json();
  const items: ComunicacaoDJEN[] = Array.isArray(data?.items) ? data.items : [];

  // Uma OAB pode ter várias comunicações para o mesmo processo — agrupa mantendo a mais recente.
  const porProcesso = new Map<string, ComunicacaoDJEN>();
  for (const item of items) {
    const numero = item.numeroprocessocommascara || item.numero_processo || "";
    if (!numero) continue;
    const dataAtual = dataDoItem(porProcesso.get(numero));
    const dataItem = dataDoItem(item);
    if (!porProcesso.has(numero) || dataItem > dataAtual) {
      porProcesso.set(numero, item);
    }
  }

  const processos = [...porProcesso.values()]
    .map(mapComunicacaoParaProcesso)
    .slice(0, MAX_PROCESSOS);

  // Lista crua (uma linha por comunicação, sem agrupar) — usada pelo feed de Alertas.
  const comunicacoes = items
    .map(mapComunicacaoParaComunicacao)
    .slice(0, MAX_PROCESSOS * 3);

  return { processos, comunicacoes, totalComunicacoes: items.length };
}

function dataDoItem(item?: ComunicacaoDJEN): string {
  return item?.data_disponibilizacao || item?.datadisponibilizacao || "";
}

// O texto das publicações do DJEN vem em HTML "cru" (às vezes com <style>/<script>
// embutidos e entidades HTML de sistemas legados) — limpa para exibição em texto simples.
const ENTIDADES_HTML: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  aacute: "á", agrave: "à", acirc: "â", atilde: "ã",
  eacute: "é", egrave: "è", ecirc: "ê",
  iacute: "í", icirc: "î",
  oacute: "ó", ograve: "ò", ocirc: "ô", otilde: "õ",
  uacute: "ú", ugrave: "ù", ucirc: "û",
  ccedil: "ç", ntilde: "ñ",
  Aacute: "Á", Agrave: "À", Acirc: "Â", Atilde: "Ã",
  Eacute: "É", Ecirc: "Ê",
  Iacute: "Í",
  Oacute: "Ó", Otilde: "Õ",
  Uacute: "Ú",
  Ccedil: "Ç",
  ordm: "º", ordf: "ª", deg: "°",
};

function limparTextoPublicacao(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ") // remove CSS embutido inteiro
    .replace(/<script[\s\S]*?<\/script>/gi, " ") // remove JS embutido inteiro
    .replace(/<[^>]+>/g, " ") // remove as demais tags, preservando o texto
    .replace(/&#(\d+);/g, (_, cod) => String.fromCharCode(Number(cod))) // entidades numéricas
    .replace(/&([a-zA-Z]+);/g, (m, nome) => ENTIDADES_HTML[nome] ?? m) // entidades nomeadas
    .replace(/\s+/g, " ")
    .trim();
}

function mapComunicacaoParaProcesso(c: ComunicacaoDJEN): ProcessoResultado {
  const poloAtivo =
    c.destinatarios?.find((d) => d.polo === "A")?.nome ||
    c.destinatarios?.[0]?.nome ||
    "Parte não identificada";
  const poloPassivo = c.destinatarios?.find((d) => d.polo === "P")?.nome || "";
  const textoResumo = limparTextoPublicacao(c.texto || "").slice(0, 180);

  return {
    numero: c.numeroprocessocommascara || c.numero_processo || "",
    classe: c.tipoComunicacao || "Comunicação Processual",
    assunto: textoResumo,
    areaEstimada: "", // o DJEN não informa área do direito
    orgaoJulgador: [c.nomeOrgao, c.siglaTribunal].filter(Boolean).join(" - "),
    poloAtivo,
    poloPassivo,
    situacao: "Publicado no DJEN",
    dataDistribuicao: dataDoItem(c),
  };
}

function mapComunicacaoParaComunicacao(c: ComunicacaoDJEN): ComunicacaoResultado {
  const poloAtivo =
    c.destinatarios?.find((d) => d.polo === "A")?.nome ||
    c.destinatarios?.[0]?.nome ||
    "Parte não identificada";

  return {
    id: c.hash || String(c.id ?? `${c.numero_processo || ""}-${dataDoItem(c)}`),
    numero: c.numeroprocessocommascara || c.numero_processo || "",
    tipo: c.tipoComunicacao || "Comunicação Processual",
    texto: limparTextoPublicacao(c.texto || "").slice(0, 300),
    orgaoJulgador: [c.nomeOrgao, c.siglaTribunal].filter(Boolean).join(" - "),
    data: dataDoItem(c),
    poloAtivo,
  };
}

// ---------------------------------------------------------------------------
// Simulação (fallback quando o DJEN está indisponível/bloqueado)
// ---------------------------------------------------------------------------

// Gera resultados determinísticos (mesma OAB -> mesmos processos) apenas para
// fins de demonstração da interface — não consulta nenhum sistema real.
function gerarProcessosSimulados(oab: string, uf: string): ProcessoResultado[] {
  let seed = 0;
  for (const ch of oab) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  if (seed === 0) seed = 42;

  const proximo = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 0xffffffff;
  };

  const classes = [
    "Procedimento Comum Cível",
    "Reclamação Trabalhista",
    "Execução Fiscal",
    "Ação de Alimentos",
    "Mandado de Segurança",
  ];
  const assuntos = [
    "Indenização por Dano Moral",
    "Rescisão Contratual",
    "Cobrança de Dívida Ativa",
    "Revisão de Alimentos",
    "Ato Administrativo",
  ];
  const areas = ["Cível", "Trabalhista", "Tributário", "Família", "Administrativo"];
  const varas = [
    "1ª Vara Cível",
    "3ª Vara do Trabalho",
    "Vara de Execução Fiscal",
    "2ª Vara de Família",
    "Vara da Fazenda Pública",
  ];
  const partes = [
    "Maria Aparecida Souza",
    "João Batista Lima",
    "Comércio Exemplo Ltda",
    "Roberto Nunes Cardoso",
    "Ana Beatriz Ramos",
  ];

  const total = 2 + Math.floor(proximo() * 3); // 2 a 4 processos
  const processos: ProcessoResultado[] = [];

  for (let i = 0; i < total; i++) {
    const idx = Math.floor(proximo() * classes.length);
    const ano = 2023 + Math.floor(proximo() * 3);
    const seq = String(Math.floor(proximo() * 9000000) + 1000000);
    const digitoVerificador = String(Math.floor(proximo() * 90) + 10);
    const numOrgao = String(Math.floor(proximo() * 9) + 1).padStart(4, "0");

    let poloAtivo = partes[Math.floor(proximo() * partes.length)];
    let poloPassivo = partes[Math.floor(proximo() * partes.length)];
    if (poloAtivo === poloPassivo) {
      poloPassivo = partes[(partes.indexOf(poloPassivo) + 1) % partes.length];
    }

    processos.push({
      numero: `${seq}-${digitoVerificador}.${ano}.8.19.${numOrgao}`,
      classe: classes[idx],
      assunto: assuntos[idx],
      areaEstimada: areas[idx],
      orgaoJulgador: `${varas[idx]} - Comarca da Capital/${uf}`,
      poloAtivo,
      poloPassivo,
      situacao: "Em andamento",
      dataDistribuicao: `${ano}-0${1 + Math.floor(proximo() * 9)}-1${Math.floor(proximo() * 9)}`,
    });
  }

  return processos;
}

function processoSimuladoParaComunicacao(p: ProcessoResultado, idx: number): ComunicacaoResultado {
  return {
    id: `simulado-${p.numero}-${idx}`,
    numero: p.numero,
    tipo: p.classe,
    texto: p.assunto,
    orgaoJulgador: p.orgaoJulgador,
    data: p.dataDistribuicao,
    poloAtivo: p.poloAtivo,
  };
}
