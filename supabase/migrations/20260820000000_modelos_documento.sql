-- Modelos de documento próprios do usuário (além dos modelos fixos do app) —
-- mesmo padrão JSONB das outras tabelas de dados de negócio, ver
-- 20260817000000_dados_usuario.sql pro motivo de usar JSONB em vez de colunas.

create table if not exists public.modelos_documento (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists modelos_documento_user_id_idx on public.modelos_documento (user_id);

alter table public.modelos_documento enable row level security;

drop policy if exists "somente do proprio usuario" on public.modelos_documento;
create policy "somente do proprio usuario" on public.modelos_documento
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
