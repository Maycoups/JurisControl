-- Base de conhecimento de tribunais/varas/fóruns — anotações livres que o(a)
-- próprio(a) advogado(a) cadastra (ex: peculiaridades daquela vara, como
-- peticionar, contatos). Mesmo padrão JSONB das outras tabelas de dados de
-- negócio (clients/processes/financials): motivo documentado na migration
-- 20260817000000_dados_usuario.sql.

create table if not exists public.tribunais_conhecimento (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists tribunais_conhecimento_user_id_idx on public.tribunais_conhecimento (user_id);

alter table public.tribunais_conhecimento enable row level security;

drop policy if exists "somente do proprio usuario" on public.tribunais_conhecimento;
create policy "somente do proprio usuario" on public.tribunais_conhecimento
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
