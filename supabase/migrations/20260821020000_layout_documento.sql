-- Layout de página (cabeçalho, rodapé, logotipo) pra Criação de Peças: um
-- "modelo" salvo por usuário, reaplicado em qualquer peça — não é conteúdo
-- de uma peça específica, é a configuração fixa do escritório (mesmo
-- princípio de allowed_emails/admin_lista_oculta: RLS restrita a quem é
-- dono da linha, sem policy nenhuma pra ninguém mais enxergar).

create table if not exists public.configuracoes_documento (
  user_id uuid primary key references auth.users(id) on delete cascade,
  cabecalho text,
  rodape text,
  logo_url text,
  atualizado_em timestamptz not null default now()
);

alter table public.configuracoes_documento enable row level security;

create policy "usuario le sua propria configuracao de documento"
  on public.configuracoes_documento for select
  using (auth.uid() = user_id);

create policy "usuario grava sua propria configuracao de documento"
  on public.configuracoes_documento for insert
  with check (auth.uid() = user_id);

create policy "usuario atualiza sua propria configuracao de documento"
  on public.configuracoes_documento for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Bucket de Storage pro logotipo do escritório — privado (public=false); o
-- app pede uma signed URL na hora de mostrar/exportar, nunca expõe a pasta
-- inteira. Cada usuário só mexe na própria pasta ({user_id}/...), garantido
-- pelas policies de storage.objects abaixo (comparando o 1º segmento do
-- caminho do arquivo com o auth.uid() de quem está pedindo).
insert into storage.buckets (id, name, public)
values ('logos-documento', 'logos-documento', false)
on conflict (id) do nothing;

create policy "usuario le seu proprio logo"
  on storage.objects for select
  using (bucket_id = 'logos-documento' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "usuario envia seu proprio logo"
  on storage.objects for insert
  with check (bucket_id = 'logos-documento' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "usuario substitui seu proprio logo"
  on storage.objects for update
  using (bucket_id = 'logos-documento' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'logos-documento' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "usuario remove seu proprio logo"
  on storage.objects for delete
  using (bucket_id = 'logos-documento' and (storage.foldername(name))[1] = auth.uid()::text);
