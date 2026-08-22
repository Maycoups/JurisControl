-- Histórico de acessos (login) — primeira função de verdade atrás do "modo
-- avançado" (perfil administrador). Cada login real (evento SIGNED_IN do
-- Supabase Auth — não dispara em reload de página, só em entrada nova, ver
-- App() em index.html) grava uma linha aqui, feita pelo próprio front-end
-- (sem Edge Function: é só um log de INSERT, não precisa de lógica no
-- servidor). Quem lê tudo é só o administrador, mesmo padrão de RLS já usado
-- em feedback_usuario (auth.jwt() -> app_metadata ->> role = 'admin').

create table if not exists public.historico_acessos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  nome text,
  user_agent text,
  criado_em timestamptz not null default now()
);

create index if not exists historico_acessos_criado_em_idx
  on public.historico_acessos (criado_em desc);

alter table public.historico_acessos enable row level security;

create policy "usuario registra seu proprio acesso"
  on public.historico_acessos for insert
  with check (auth.uid() = user_id);

create policy "administrador ve todo historico de acesso"
  on public.historico_acessos for select
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
