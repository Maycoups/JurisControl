-- Perfil de administrador + "modo avançado": só a estrutura de segurança por
-- enquanto, nenhuma funcionalidade nova de administrador ainda.
--
-- Duas peças, cada uma uma barreira independente:
--
-- 1) app_metadata.role = 'admin' na conta mayconpessanh@gmail.com. Diferente
--    de user_metadata (que o próprio usuário pode alterar chamando
--    supabaseClient.auth.updateUser()), app_metadata só é gravável pelo
--    servidor — o gatilho abaixo roda dentro do Postgres, o app nunca escreve
--    nele. É só o que decide se o BOTÃO "Ativar modo avançado" aparece em
--    Configurações; não concede nenhum privilégio sozinho.
--
-- 2) admin_lista_oculta: uma segunda lista, separada de allowed_emails,
--    guardando não o e-mail em si mas o hash SHA-256 dele. Mesmo padrão de
--    allowed_emails — RLS ligado, ZERO policies, só service_role (usado pelas
--    Edge Functions) consegue ler. É a Edge Function ativar-modo-avancado
--    (ver supabase/functions/ativar-modo-avancado) que de fato decide se o
--    modo avançado é liberado: exige estar nessa lista E ter completado a
--    verificação em duas etapas (MFA) nesta sessão (aal2). As duas condições
--    são checadas no servidor, nunca confiando no que o front-end manda.

create or replace function public.atribuir_perfil_administrador()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if lower(new.email) = 'mayconpessanh@gmail.com' then
    new.raw_app_meta_data = coalesce(new.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', 'admin');
  end if;
  return new;
end;
$$;

drop trigger if exists trigger_atribuir_perfil_administrador on auth.users;
create trigger trigger_atribuir_perfil_administrador
  before insert on auth.users
  for each row
  execute function public.atribuir_perfil_administrador();

create table if not exists public.admin_lista_oculta (
  email_hash text primary key,
  criado_em timestamptz not null default now()
);

alter table public.admin_lista_oculta enable row level security;
-- Propositalmente sem nenhuma "create policy" aqui — só service_role lê/escreve.
