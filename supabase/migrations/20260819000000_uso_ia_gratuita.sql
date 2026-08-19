-- Controle de uso do plano gratuito de IA (Gemini, pago pela casa dentro do free
-- tier do Google) — evita que o custo dependa de configuração no front-end.
--
-- Cada linha = quantas gerações um usuário já fez num mês (formato 'YYYY-MM').
-- Só a Edge Function (com service_role) pode gravar/incrementar — isso impede
-- que alguém zere ou infle a própria contagem chamando a API direto. O front-end
-- só tem permissão de LEITURA da própria linha, pra mostrar "X de 10 este mês"
-- sem precisar de uma chamada extra a alguma function.

create table if not exists public.uso_ia_gratuita (
  user_id uuid not null references auth.users(id) on delete cascade,
  mes text not null, -- 'YYYY-MM'
  contagem integer not null default 0,
  atualizado_em timestamptz not null default now(),
  primary key (user_id, mes)
);

alter table public.uso_ia_gratuita enable row level security;

drop policy if exists "le apenas o proprio uso" on public.uso_ia_gratuita;
create policy "le apenas o proprio uso" on public.uso_ia_gratuita
  for select using (auth.uid() = user_id);
-- Propositalmente sem policy de insert/update/delete — só service_role grava.
