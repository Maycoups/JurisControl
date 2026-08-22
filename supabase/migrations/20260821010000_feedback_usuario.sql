-- Gestor de notas/avaliações: qualquer conta pode enviar (a UI só mostra o
-- formulário na conta da Camila por enquanto, mas a trava de verdade é a
-- policy de INSERT abaixo — só grava feedback em nome de quem está logado).
-- Quem lê tudo é só o perfil administrador (mayconpessanh@gmail.com, via o
-- mesmo app_metadata.role='admin' do modo avançado) — reaproveita o claim já
-- gravado pelo gatilho de supabase/migrations/20260821000000_perfil_administrador.sql,
-- direto na policy de SELECT, sem precisar de Edge Function nova.

create table if not exists public.feedback_usuario (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  autor_nome text,
  tipo text not null default 'sugestao' check (tipo in ('critica', 'sugestao', 'avaliacao')),
  nota smallint check (nota is null or (nota between 1 and 5)),
  mensagem text not null,
  lido boolean not null default false,
  criado_em timestamptz not null default now()
);

alter table public.feedback_usuario enable row level security;

create policy "usuario insere seu proprio feedback"
  on public.feedback_usuario for insert
  with check (auth.uid() = user_id);

create policy "usuario ve seu proprio feedback"
  on public.feedback_usuario for select
  using (auth.uid() = user_id);

create policy "administrador ve todo feedback"
  on public.feedback_usuario for select
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create policy "administrador marca feedback como lido"
  on public.feedback_usuario for update
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
