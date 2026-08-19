// Edge Function: verificar-convite
// Recebe { email } e devolve { permitido: boolean }.
//
// Usada pela tela de login ANTES de chamar supabase.auth.signUp(), pra dar um
// retorno rápido e com mensagem clara quando o e-mail não está na lista de
// convidados (tabela allowed_emails).
//
// Por que não bastava só o gatilho no banco (verificar_email_permitido, ver
// migration 20260818000000): o gatilho barra a criação da conta corretamente,
// mas o GoTrue devolve isso como HTTP 500. O cliente supabase-js trata 500 como
// "erro que talvez valha tentar de novo" e faz retries automáticos — quando as
// tentativas se esgotam, ele troca a mensagem original por um texto genérico
// ("Database error saving new user"), então o usuário nunca vê a mensagem
// específica. Verificando antes, evitamos esse caminho instável.
//
// O gatilho no banco continua ativo como camada de segurança de verdade (defesa
// em profundidade) — mesmo que alguém chame signUp() direto, sem passar por
// esta função, a conta ainda não é criada.
//
// Esta função é uma exceção deliberada à regra "toda function exige login"
// (ver _shared/auth.ts): ela precisa ser chamável ANTES de existir qualquer
// conta/sessão. É segura de deixar aberta porque só devolve um boolean — nunca
// expõe a lista de e-mails, não custa dinheiro (não chama nenhuma API paga) e
// não expõe nenhum dado sensível.

import { createClient } from "npm:@supabase/supabase-js@2";

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

  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Corpo da requisição inválido (esperado JSON)." }, 400);
  }

  const email = (body.email ?? "").toString().trim().toLowerCase();
  if (!email) {
    return jsonResponse({ error: "Informe um e-mail." }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Configuração do servidor incompleta." }, 500);
  }

  // service_role ignora RLS de propósito aqui — é a única forma de consultar
  // allowed_emails, já que a tabela não tem nenhuma policy pública.
  const client = createClient(supabaseUrl, serviceRoleKey);
  const { data, error } = await client
    .from("allowed_emails")
    .select("email")
    .ilike("email", email)
    .maybeSingle();

  if (error) {
    console.error("Erro ao verificar convite:", error);
    return jsonResponse({ error: "Erro ao verificar o convite. Tente novamente." }, 500);
  }

  return jsonResponse({ permitido: !!data });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
