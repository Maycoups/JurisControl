-- Restringe a criação de contas a uma lista de e-mails pré-aprovados (convite),
-- sem exigir nenhum passo extra do usuário na tela de cadastro.
--
-- Como funciona: um gatilho (trigger) roda DENTRO do Postgres antes de qualquer
-- linha nova ser inserida em auth.users (ou seja, antes de qualquer conta ser
-- criada, seja pelo formulário do app, por outra ferramenta, ou por qualquer
-- chamada direta à API do Supabase). Se o e-mail não estiver na tabela
-- allowed_emails, a criação é abortada com uma mensagem clara. Não há como
-- contornar isso pelo front-end — a checagem não depende do HTML/JS de forma
-- nenhuma.
--
-- allowed_emails fica com RLS ligado e SEM NENHUMA policy — isso significa que
-- nem usuários logados conseguem ler ou escrever nela pela API pública. Só quem
-- tem a service_role key (você, via SQL Editor do Supabase ou `supabase db push`)
-- consegue gerenciar a lista. Isso evita que a lista de e-mails autorizados vaze
-- ou seja adulterada por alguém de fora.

create table if not exists public.allowed_emails (
  email text primary key,
  nome text,
  criado_em timestamptz not null default now()
);

alter table public.allowed_emails enable row level security;
-- Propositalmente sem nenhuma "create policy" aqui.

create or replace function public.verificar_email_permitido()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.allowed_emails
    where lower(email) = lower(new.email)
  ) then
    raise exception 'E-mail não autorizado a criar conta no JurisControl. Peça um convite ao administrador.';
  end if;
  return new;
end;
$$;

drop trigger if exists trigger_verificar_email_permitido on auth.users;
create trigger trigger_verificar_email_permitido
  before insert on auth.users
  for each row
  execute function public.verificar_email_permitido();
