-- =====================================================================
-- جرد المخزون — Double Roses : قاعدة بيانات Supabase
-- الصق هذا الملف كاملاً في: Supabase → SQL Editor → New query → Run
-- آمن لإعادة التشغيل.
-- =====================================================================

-- ---------- المستخدمون والصلاحيات ----------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text unique,
  role       text not null default 'staff' check (role in ('admin','staff')),
  created_at timestamptz not null default now()
);

-- كل مستخدم جديد يُنشأ له ملف تلقائياً بدور "موظف"
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username)
  values (new.id, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.my_username() returns text
language sql stable security definer set search_path = public as $$
  select username from public.profiles where id = auth.uid();
$$;

-- ---------- المنتجات (كل صف = موديل + لون + مقاس) ----------
create table if not exists public.items (
  id          text primary key,
  sku         text,
  model       text not null default '',
  brand       text not null default '',
  category    text not null default 'Eid Dress',
  color       text not null,
  size        text not null,
  qty         integer not null default 0 check (qty >= 0),
  price       numeric(10,2),
  compare_at  numeric(10,2),
  title       text not null default '',
  descr       text not null default '',
  counted     integer check (counted >= 0),
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);
create unique index if not exists items_sku_unique on public.items (sku) where sku is not null and sku <> '';
create index if not exists items_model_idx on public.items (model);

-- الموظف يعدّل عدّاد الجرد فقط — أي تعديل آخر يُرفض من قاعدة البيانات نفسها
create or replace function public.items_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    if (to_jsonb(new) - 'counted' - 'updated_at' - 'updated_by')
       is distinct from (to_jsonb(old) - 'counted' - 'updated_at' - 'updated_by') then
      raise exception 'غير مسموح: صلاحية الموظف هي الجرد والتصوير فقط';
    end if;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
drop trigger if exists items_guard on public.items;
create trigger items_guard before update on public.items
  for each row execute function public.items_guard();

-- ---------- سجل العمليات: من غيّر ماذا ومتى ----------
create table if not exists public.audit_log (
  id       bigserial primary key,
  at       timestamptz not null default now(),
  user_id  uuid,
  username text,
  action   text not null,
  item_id  text,
  sku      text,
  changes  jsonb
);
create index if not exists audit_log_at_idx on public.audit_log (at desc);

create or replace function public.items_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o jsonb; n jsonb; ch jsonb := '{}'::jsonb; k text;
begin
  if tg_op = 'INSERT' then
    insert into public.audit_log (user_id, username, action, item_id, sku, changes)
    values (auth.uid(), public.my_username(), 'insert', new.id, new.sku, to_jsonb(new));
    return new;
  elsif tg_op = 'DELETE' then
    insert into public.audit_log (user_id, username, action, item_id, sku, changes)
    values (auth.uid(), public.my_username(), 'delete', old.id, old.sku, to_jsonb(old));
    return old;
  end if;
  o := to_jsonb(old); n := to_jsonb(new);
  for k in select jsonb_object_keys(n) loop
    if k not in ('updated_at', 'updated_by', 'counted') and (o -> k) is distinct from (n -> k) then
      ch := ch || jsonb_build_object(k, jsonb_build_array(o -> k, n -> k));
    end if;
  end loop;
  if ch <> '{}'::jsonb then
    insert into public.audit_log (user_id, username, action, item_id, sku, changes)
    values (auth.uid(), public.my_username(), 'update', new.id, new.sku, ch);
  end if;
  return new;
end $$;
drop trigger if exists items_audit on public.items;
create trigger items_audit after insert or update or delete on public.items
  for each row execute function public.items_audit();

-- ---------- الجرد ----------
-- مسح باركود: يزيد العدّاد قطعة واحدة (آمن عند الجرد من أكثر من جوال بنفس الوقت)
create or replace function public.count_scan(p_sku text) returns setof public.items
language sql security invoker set search_path = public as $$
  update public.items set counted = coalesce(counted, 0) + 1
  where sku = upper(trim(p_sku))
  returning *;
$$;

create or replace function public.start_count() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.is_admin() then raise exception 'للمدير فقط'; end if;
  update public.items set counted = 0 where id is not null;
  get diagnostics n = row_count;
  insert into public.audit_log (user_id, username, action) values (auth.uid(), public.my_username(), 'start_count');
  return n;
end $$;

-- اعتماد الجرد: الكمية = العدد الفعلي
create or replace function public.apply_count() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.is_admin() then raise exception 'للمدير فقط'; end if;
  update public.items set qty = counted where counted is not null and counted <> qty;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- الصور ----------
create table if not exists public.photos (
  id         text primary key,          -- مثل 34185-BLU-1
  grp        text not null,             -- مثل 34185-BLU
  n          integer not null,
  path       text not null,             -- المسار في Storage
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index if not exists photos_grp_idx on public.photos (grp);

insert into storage.buckets (id, name, public)
values ('photos', 'photos', true)
on conflict (id) do nothing;

-- ---------- سياسات الأمان (RLS) ----------
alter table public.profiles  enable row level security;
alter table public.items     enable row level security;
alter table public.photos    enable row level security;
alter table public.audit_log enable row level security;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists items_read on public.items;
create policy items_read on public.items for select to authenticated using (true);
drop policy if exists items_insert on public.items;
create policy items_insert on public.items for insert to authenticated with check (public.is_admin());
drop policy if exists items_update on public.items;
create policy items_update on public.items for update to authenticated using (true) with check (true); -- items_guard يقيّد الموظف
drop policy if exists items_delete on public.items;
create policy items_delete on public.items for delete to authenticated using (public.is_admin());

drop policy if exists photos_read on public.photos;
create policy photos_read on public.photos for select to authenticated using (true);
drop policy if exists photos_insert on public.photos;
create policy photos_insert on public.photos for insert to authenticated with check (true);
drop policy if exists photos_delete on public.photos;
create policy photos_delete on public.photos for delete to authenticated
  using (public.is_admin() or created_by = auth.uid());

drop policy if exists audit_read on public.audit_log;
create policy audit_read on public.audit_log for select to authenticated using (public.is_admin());

drop policy if exists "photos bucket read" on storage.objects;
create policy "photos bucket read" on storage.objects for select using (bucket_id = 'photos');
drop policy if exists "photos bucket upload" on storage.objects;
create policy "photos bucket upload" on storage.objects for insert to authenticated with check (bucket_id = 'photos');
drop policy if exists "photos bucket delete" on storage.objects;
create policy "photos bucket delete" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (public.is_admin() or owner = auth.uid()));

-- صلاحيات صريحة (تعمل حتى لو كان خيار "Automatically expose new tables" مطفأ) — الحماية الفعلية عبر RLS أعلاه
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.items, public.photos to authenticated;
grant select, update on public.profiles to authenticated;
grant select on public.audit_log to authenticated;
revoke all on public.items, public.photos, public.profiles, public.audit_log from anon;

revoke execute on function public.count_scan(text), public.start_count(), public.apply_count() from public, anon;
grant execute on function public.count_scan(text) to authenticated;
grant execute on function public.start_count()   to authenticated;
grant execute on function public.apply_count()   to authenticated;

-- ---------- التحديث المباشر بين الأجهزة ----------
do $$ begin
  begin alter publication supabase_realtime add table public.items;  exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.photos; exception when duplicate_object then null; end;
end $$;

-- =====================================================================
-- بعد إنشاء حسابك من Authentication → Users، اجعل نفسك مديراً:
--   update public.profiles set role = 'admin' where username = 'khalid';
-- =====================================================================
