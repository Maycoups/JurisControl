// Verificação de usuário autenticado, compartilhada por todas as Edge Functions.
//
// IMPORTANTE: `verify_jwt = true` no config.toml só garante que o cabeçalho
// Authorization contém ALGUM JWT válido assinado pelo projeto — isso inclui a
// própria chave pública "anon" (que fica embutida no index.html, então é pública
// por definição). Ou seja, `verify_jwt = true` sozinho NÃO impede uma pessoa
// anônima de chamar a função usando só a chave anon.
//
// Esta função faz a checagem que realmente importa: confirma que o token pertence
// a uma sessão de usuário de verdade (alguém que fez login no JurisControl), não
// apenas a chave pública. Isso é o que protege as funções que custam dinheiro
// (criar-peca-ia usa a API da Anthropic) ou que poderiam ser abusadas em massa
// (buscas no DJEN/TJRJ/DataJud) contra uso por qualquer pessoa que descubra a URL.

import { createClient } from "npm:@supabase/supabase-js@2";

export async function verificarUsuarioAutenticado(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) return null;

  const client = createClient(supabaseUrl, anonKey);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

export function respostaNaoAutenticado(corsHeaders: Record<string, string>) {
  return new Response(
    JSON.stringify({ error: "Não autenticado. Faça login no JurisControl para usar esta função." }),
    { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}
