// Edge Function: ativar-modo-avancado
// Não recebe corpo — usa só o token de quem chama (Authorization: Bearer ...).
// Devolve { liberado: boolean, motivo?: string }.
//
// Esta função é a barreira de verdade do "modo avançado" (perfil administrador).
// Ainda não libera NENHUMA funcionalidade nova — só decide se o toggle em
// Configurações pode ligar. Três checagens, todas no servidor (nunca confiando
// em nada que o front-end mande):
//
//   1) app_metadata.role === 'admin' — gravado só por um gatilho no banco
//      (ver migration 20260821000000_perfil_administrador.sql), nunca pelo
//      próprio usuário. Sem isso, nem continua.
//   2) A sessão atual completou a verificação em duas etapas (aal2). Hoje só
//      existe TOTP implementado (compatível com Google Authenticator e afins);
//      não há fator por e-mail/SMS ainda — isso ficaria pra uma rodada futura.
//   3) O hash SHA-256 do e-mail está em admin_lista_oculta — uma segunda lista,
//      separada de allowed_emails, sem NENHUMA policy de RLS (só service_role
//      enxerga). Guardamos o hash, não o e-mail em texto puro, então mesmo um
//      acesso de leitura à tabela não expõe diretamente quem está nela.
//
// As três precisam passar. Falhar qualquer uma nunca revela detalhe pra quem
// não tem role 'admin' — só quem já passou pela barreira 1 recebe o motivo
// específico das barreiras 2/3, pra conseguir se corrigir (ex.: "ative o MFA").

import { createClient } from "npm:@supabase/supabase-js@2";
import { verificarUsuarioAutenticado, respostaNaoAutenticado } from "../_shared/auth.ts";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Método não suportado. Use POST." }, 405);
  }

  const usuario = await verificarUsuarioAutenticado(req);
  if (!usuario) {
    return respostaNaoAutenticado(CORS_HEADERS);
  }

  // Daqui pra baixo, "liberado: false" é sempre um resultado de negócio (HTTP
  // 200) e não um erro de transporte — supabaseClient.functions.invoke() só
  // devolve resultado.data quando o status é 2xx, e resultado.motivo é o que
  // a interface usa pra mostrar a mensagem certa em cada barreira.

  // Barreira 1: só quem tem app_metadata.role === 'admin' passa daqui — e essa
  // flag só é gravada pelo gatilho no banco, nunca pelo app.
  if (usuario.app_metadata?.role !== "admin") {
    return jsonResponse({ liberado: false, motivo: "Recurso não disponível para esta conta." });
  }

  // Barreira 2: a sessão atual precisa ter completado o segundo fator (aal2).
  // getUser() não devolve o claim `aal` — vem só no próprio token, então
  // decodificamos o payload do JWT já validado por verificarUsuarioAutenticado.
  const aal = extrairAal(req);
  if (aal !== "aal2") {
    return jsonResponse({
      liberado: false,
      motivo: "Ative a verificação em duas etapas em Configurações → Segurança e faça login novamente antes de ativar o modo avançado.",
    });
  }

  // Barreira 3: hash do e-mail precisa estar na lista oculta.
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Configuração do servidor incompleta." }, 500);
  }
  const emailHash = await sha256Hex((usuario.email ?? "").trim().toLowerCase());
  const client = createClient(supabaseUrl, serviceRoleKey);
  const { data, error } = await client
    .from("admin_lista_oculta")
    .select("email_hash")
    .eq("email_hash", emailHash)
    .maybeSingle();

  if (error) {
    console.error("Erro ao consultar admin_lista_oculta:", error);
    return jsonResponse({ error: "Erro ao verificar autorização. Tente novamente." }, 500);
  }
  if (!data) {
    return jsonResponse({ liberado: false, motivo: "Esta conta ainda não está na lista de administradores avançados." });
  }

  return jsonResponse({ liberado: true });
});

function extrairAal(req: Request): string | null {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const partes = token.split(".");
  if (partes.length !== 3) return null;
  try {
    const payloadBase64 = partes[1].replace(/-/g, "+").replace(/_/g, "/");
    const payloadJson = atob(payloadBase64.padEnd(payloadBase64.length + (4 - (payloadBase64.length % 4)) % 4, "="));
    const payload = JSON.parse(payloadJson);
    return payload.aal ?? null;
  } catch {
    return null;
  }
}

async function sha256Hex(texto: string): Promise<string> {
  const dados = new TextEncoder().encode(texto);
  const hashBuffer = await crypto.subtle.digest("SHA-256", dados);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
