create table if not exists public.profiles (
    id uuid primary key references auth.users (id) on delete cascade,
    username text not null,
    total_xp integer not null default 0 check (total_xp >= 0),
    created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
grant select on public.profiles to service_role;

create table if not exists public.xp_awards (
    user_id uuid not null references auth.users (id) on delete cascade,
    round_id text not null,
    amount integer not null check (amount between 0 and 150),
    created_at timestamptz not null default now(),
    primary key (user_id, round_id)
);

alter table public.xp_awards enable row level security;

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    profile_name text;
begin
    profile_name := coalesce(
        nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
        nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
        'Learner'
    );

    insert into public.profiles (id, username)
    values (new.id, left(profile_name, 24))
    on conflict (id) do nothing;

    return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
    after insert on auth.users
    for each row execute procedure public.create_profile_for_new_user();

create or replace function public.award_quiz_xp(
    p_user_id uuid,
    p_round_id text,
    p_amount integer
)
returns table (total_xp integer, awarded boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
    inserted_rows integer;
begin
    if p_amount < 0 or p_amount > 150 then
        raise exception 'XP amount is out of range';
    end if;

    insert into public.xp_awards (user_id, round_id, amount)
    values (p_user_id, p_round_id, p_amount)
    on conflict (user_id, round_id) do nothing;

    get diagnostics inserted_rows = row_count;
    if inserted_rows = 0 then
        return query
            select profiles.total_xp, false
            from public.profiles
            where profiles.id = p_user_id;
        return;
    end if;

    return query
        update public.profiles
        set total_xp = profiles.total_xp + p_amount
        where profiles.id = p_user_id
        returning profiles.total_xp, true;

    if not found then
        raise exception 'Profile does not exist';
    end if;
end;
$$;

revoke all on function public.award_quiz_xp(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.award_quiz_xp(uuid, text, integer) to service_role;
