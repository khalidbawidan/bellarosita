-- =====================================================================
-- Bellarosita — تحديث 2: العمليات (بيع/استلام/مرتجع/تالف/حجز) + التكلفة + الإعدادات
-- الصق هذا الملف في SQL Editor → Run   (آمن لإعادة التشغيل، لا يحذف بيانات)
-- =====================================================================

-- ---------- أعمدة جديدة للمنتجات ----------
alter table public.items add column if not exists cost      numeric(10,2);          -- سعر التكلفة
alter table public.items add column if not exists location  text not null default ''; -- الرف / الصندوق
alter table public.items add column if not exists title_ar  text not null default '';
alter table public.items add column if not exists descr_en  text not null default '';

alter table public.photos add column if not exists shot text not null default 'other'; -- front/back/detail/mannequin/other

-- الموظف لا يرى سعر التكلفة؟ (يُخفى في الواجهة؛ قاعدة البيانات تمنعه من تعديله عبر items_guard)

-- ---------- السماح للعمليات المعتمدة بتعديل الكمية ----------
create or replace function public.items_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() and coalesce(current_setting('app.stock_op', true), '') <> 'on' then
    if (to_jsonb(new) - 'counted' - 'updated_at' - 'updated_by')
       is distinct from (to_jsonb(old) - 'counted' - 'updated_at' - 'updated_by') then
      raise exception 'غير مسموح: صلاحية الموظف هي الجرد والتصوير والبيع فقط';
    end if;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

-- ---------- حركات المخزون ----------
create table if not exists public.movements (
  id        bigserial primary key,
  at        timestamptz not null default now(),
  user_id   uuid default auth.uid(),
  username  text,
  type      text not null check (type in ('sale','receive','return','damage','adjust')),
  ref       text,                      -- رقم العملية (فاتورة بيع / استلام)
  item_id   text references public.items(id) on delete set null,
  sku       text,
  model     text, color text, size text,
  qty       integer not null,          -- موجب دائماً؛ الاتجاه حسب النوع
  price     numeric(10,2),             -- سعر البيع الفعلي للقطعة
  cost      numeric(10,2),             -- التكلفة وقت العملية
  channel   text not null default 'studio', -- studio / online / salla
  customer  text,
  note      text
);
create index if not exists movements_at_idx   on public.movements (at desc);
create index if not exists movements_type_idx on public.movements (type, at desc);
create index if not exists movements_ref_idx  on public.movements (ref);

-- تنفيذ عملية على عدة قطع دفعة واحدة (ذرّية: إما كلها أو لا شيء)
-- p_lines = [{"id":"...","qty":2,"price":330}, ...]
create or replace function public.stock_move(p_type text, p_lines jsonb, p_ref text default null,
  p_customer text default null, p_note text default null, p_channel text default 'studio')
returns text language plpgsql security definer set search_path = public as $$
declare
  l jsonb; it public.items; q integer; sign integer; ref text := coalesce(nullif(p_ref, ''),
    case p_type when 'sale' then 'S' when 'receive' then 'IN' when 'return' then 'RT' when 'damage' then 'D' else 'A' end
    || to_char(now() at time zone 'Asia/Riyadh', 'YYMMDD-HH24MISS') || '-' || substr(md5(random()::text), 1, 3));
begin
  if auth.uid() is null then raise exception 'سجّل الدخول أولاً'; end if;
  if p_type not in ('sale','receive','return','damage','adjust') then raise exception 'نوع عملية غير معروف'; end if;
  if p_type in ('receive','damage','adjust') and not public.is_admin() then raise exception 'هذه العملية للمدير فقط'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'لا توجد قطع'; end if;

  perform set_config('app.stock_op', 'on', true);
  for l in select * from jsonb_array_elements(p_lines) loop
    q := (l->>'qty')::integer;
    select * into it from public.items where id = l->>'id' for update;
    if not found then raise exception 'منتج غير موجود: %', l->>'id'; end if;
    if p_type = 'adjust' then
      sign := 1; -- qty هنا = الكمية الجديدة
      insert into public.movements (username, type, ref, item_id, sku, model, color, size, qty, price, cost, channel, customer, note)
      values (public.my_username(), 'adjust', ref, it.id, it.sku, it.model, it.color, it.size, q - it.qty, null, it.cost, p_channel, p_customer, p_note);
      update public.items set qty = q where id = it.id;
      continue;
    end if;
    if q is null or q <= 0 then raise exception 'كمية غير صحيحة'; end if;
    sign := case when p_type in ('receive','return') then 1 else -1 end;
    if sign < 0 and it.qty < q then
      raise exception 'الكمية غير كافية للكود % (المتوفر %)', it.sku, it.qty;
    end if;
    update public.items set qty = qty + sign * q where id = it.id;
    insert into public.movements (username, type, ref, item_id, sku, model, color, size, qty, price, cost, channel, customer, note)
    values (public.my_username(), p_type, ref, it.id, it.sku, it.model, it.color, it.size, q,
            coalesce((l->>'price')::numeric, it.price), it.cost, p_channel, p_customer, p_note);
  end loop;
  perform set_config('app.stock_op', '', true);
  return ref;
end $$;

-- ---------- الحجوزات ----------
create table if not exists public.reservations (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  user_id    uuid default auth.uid(),
  item_id    text not null references public.items(id) on delete cascade,
  sku        text,
  qty        integer not null default 1 check (qty > 0),
  customer   text not null,
  phone      text,
  note       text,
  status     text not null default 'active' check (status in ('active','sold','cancelled')),
  until      date,
  closed_at  timestamptz
);
create index if not exists reservations_status_idx on public.reservations (status);

-- إتمام حجز = بيع
create or replace function public.complete_reservation(p_id bigint, p_price numeric default null)
returns text language plpgsql security definer set search_path = public as $$
declare r public.reservations; ref text;
begin
  select * into r from public.reservations where id = p_id and status = 'active' for update;
  if not found then raise exception 'الحجز غير موجود أو مغلق'; end if;
  ref := public.stock_move('sale', jsonb_build_array(jsonb_build_object('id', r.item_id, 'qty', r.qty, 'price', p_price)),
                           null, r.customer, 'من حجز #' || r.id, 'studio');
  update public.reservations set status = 'sold', closed_at = now() where id = p_id;
  return ref;
end $$;

-- ---------- الإعدادات ----------
create table if not exists public.settings (
  key   text primary key,
  value jsonb not null
);
insert into public.settings (key, value) values
  ('markup_pct', '100'), ('low_stock', '1'), ('whatsapp', '""'), ('studio_name', '"Bellarosita"')
on conflict (key) do nothing;

-- ---------- الأمان ----------
alter table public.movements    enable row level security;
alter table public.reservations enable row level security;
alter table public.settings     enable row level security;

drop policy if exists movements_read on public.movements;
create policy movements_read on public.movements for select to authenticated using (true);
-- لا insert/update/delete مباشر — فقط عبر stock_move

drop policy if exists reservations_read on public.reservations;
create policy reservations_read on public.reservations for select to authenticated using (true);
drop policy if exists reservations_insert on public.reservations;
create policy reservations_insert on public.reservations for insert to authenticated with check (status = 'active');
drop policy if exists reservations_update on public.reservations;
create policy reservations_update on public.reservations for update to authenticated using (status = 'active') with check (status in ('active','cancelled'));
drop policy if exists reservations_delete on public.reservations;
create policy reservations_delete on public.reservations for delete to authenticated using (public.is_admin());

drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings for select to authenticated using (true);
drop policy if exists settings_write on public.settings;
create policy settings_write on public.settings for all to authenticated using (public.is_admin()) with check (public.is_admin());

grant select on public.movements to authenticated;
grant select, insert, update, delete on public.reservations, public.settings to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke all on public.movements, public.reservations, public.settings from anon;

revoke execute on function public.stock_move(text, jsonb, text, text, text, text), public.complete_reservation(bigint, numeric) from public, anon;
grant execute on function public.stock_move(text, jsonb, text, text, text, text), public.complete_reservation(bigint, numeric) to authenticated;

do $$ begin
  begin alter publication supabase_realtime add table public.reservations; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.movements;    exception when duplicate_object then null; end;
end $$;
