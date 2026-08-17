-- Dados de negócio por usuário (clientes, processos, financeiro).
--
-- Guardamos cada registro como um objeto JSONB inteiro (não uma coluna por campo).
-- Motivo: o front-end (Index.html) já tem ~15 telas que consomem esses objetos
-- exatamente como estão hoje (client.nome, process.valorCausa, process.kanbanStatus,
-- etc.). Guardando o objeto inteiro como JSONB, só muda de onde o dado vem — nenhuma
-- tela precisa ser reescrita agora. Dá pra normalizar em colunas de verdade depois,
-- se algum dia precisarmos filtrar/consultar direto no banco.
--
-- RLS: cada linha só é visível/editável pelo dono (auth.uid() = user_id). Sem policy
-- nenhuma, ninguém enxerga nada — nem o próprio dono — então a policy "for all" é
-- obrigatória para o app funcionar.

create table if not exists public.clients (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.processes (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.financials (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists clients_user_id_idx on public.clients (user_id);
create index if not exists processes_user_id_idx on public.processes (user_id);
create index if not exists financials_user_id_idx on public.financials (user_id);

alter table public.clients enable row level security;
alter table public.processes enable row level security;
alter table public.financials enable row level security;

drop policy if exists "somente do proprio usuario" on public.clients;
create policy "somente do proprio usuario" on public.clients
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "somente do proprio usuario" on public.processes;
create policy "somente do proprio usuario" on public.processes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "somente do proprio usuario" on public.financials;
create policy "somente do proprio usuario" on public.financials
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
