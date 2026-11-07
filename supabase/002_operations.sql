-- =====================================================================
-- Bellarosita — تحديث 2: العمليات (بيع/استلام/مرتجع/تالف/حجز) + التكلفة + الإعدادات
-- الصق هذا الملف في SQL Editor → Run   (آمن لإعادة التشغيل، لا يحذف بيانات)
--
-- الحماية:
--   • سعر التكلفة في جداول منفصلة للمدير فقط (item_costs, movement_costs) — الموظف لا يقرأه أبداً
--   • مرتجع الموظف مربوط بفاتورة بيع سابقة، وبحد الكمية المباعة فيها، وبسعرها الأصلي
--   • خصم الموظف محدود بإعداد max_discount_pct (الافتراضي 10%)
-- =====================================================================

-- ---------- أعمدة جديدة للمنتجات (بدون التكلفة) ----------
alter table public.items add column if not exists location  text not null default '';
alter table public.items add column if not exists title_ar  text not null default '';
alter table public.items add column if not exists descr_en  text not null default '';

alter table public.photos add column if not exists shot text not null default 'other'; -- front/back/detail/mannequin/other

-- ---------- التكلفة: جدول منفصل للمدير فقط ----------
create table if not exists public.item_costs (
  item_id    text primary key references public.items(id) on delete cascade,
  cost       numeric(10,2) check (cost >= 0),
  updated_at timestamptz not null default now()
);
-- لو شُغّلت نسخة سابقة من هذا الملف أضافت items.cost: انقلها ثم احذف العمود
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='items' and column_name='cost') then
    insert into public.item_costs (item_id, cost) select id, cost from public.items where cost is not null on conflict (item_id) do nothing;
    alter table public.items drop column cost;
  end if;
end $$;

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
  ref       text,                      -- رقم العملية
  orig_ref  text,                      -- للمرتجع: رقم فاتورة البيع الأصلية
  item_id   text references public.items(id) on delete set null,
  sku       text,
  model     text, color text, size text,
  qty       integer not null,          -- موجب دائماً؛ الاتجاه حسب النوع (adjust: الفرق)
  price     numeric(10,2),             -- سعر البيع الفعلي للقطعة
  channel   text not null default 'studio', -- studio / online / salla
  customer  text,
  note      text
);
alter table public.movements add column if not exists orig_ref text;
create index if not exists movements_at_idx   on public.movements (at desc);
create index if not exists movements_type_idx on public.movements (type, at desc);
create index if not exists movements_ref_idx  on public.movements (ref);
create index if not exists movements_orig_idx on public.movements (orig_ref);

-- تكلفة كل حركة وقت تنفيذها (للمدير فقط)
create table if not exists public.movement_costs (
  movement_id bigint primary key references public.movements(id) on delete cascade,
  cost        numeric(10,2)
);
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='movements' and column_name='cost') then
    insert into public.movement_costs (movement_id, cost) select id, cost from public.movements where cost is not null on conflict do nothing;
    alter table public.movements drop column cost;
  end if;
end $$;

-- ---------- الإعدادات ----------
create table if not exists public.settings (
  key   text primary key,
  value jsonb not null
);
insert into public.settings (key, value) values
  ('markup_pct', '100'), ('low_stock', '1'), ('whatsapp', '""'), ('studio_name', '"Bellarosita"'), ('max_discount_pct', '10')
on conflict (key) do nothing;

-- ---------- تنفيذ عملية مخزون (ذرّية: إما كلها أو لا شيء) ----------
-- p_lines = [{"id":"...","qty":2,"price":330}, ...]
drop function if exists public.stock_move(text, jsonb, text, text, text, text);
create or replace function public.stock_move(p_type text, p_lines jsonb, p_ref text default null,
  p_customer text default null, p_note text default null, p_channel text default 'studio', p_orig_ref text default null)
returns text language plpgsql security definer set search_path = public as $$
declare
  l jsonb; it public.items; q integer; sign integer; pr numeric; mid bigint; c numeric;
  adm boolean := public.is_admin();
  max_disc numeric := coalesce((select (value #>> '{}')::numeric from public.settings where key = 'max_discount_pct'), 0);
  sold integer; returned integer; sold_price numeric;
  ref text := coalesce(nullif(p_ref, ''),
    case p_type when 'sale' then 'S' when 'receive' then 'IN' when 'return' then 'RT' when 'damage' then 'D' else 'A' end
    || to_char(now() at time zone 'Asia/Riyadh', 'YYMMDD-HH24MISS') || '-' || substr(md5(random()::text), 1, 3));
begin
  if auth.uid() is null then raise exception 'سجّل الدخول أولاً'; end if;
  if p_type not in ('sale','receive','return','damage','adjust') then raise exception 'نوع عملية غير معروف'; end if;
  if p_type in ('receive','damage','adjust') and not adm then raise exception 'هذه العملية للمدير فقط'; end if;
  if p_type = 'return' and not adm and coalesce(p_orig_ref, '') = '' then
    raise exception 'المرتجع يحتاج رقم فاتورة البيع الأصلية';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'لا توجد قطع'; end if;

  perform set_config('app.stock_op', 'on', true);
  for l in select * from jsonb_array_elements(p_lines) loop
    q := (l->>'qty')::integer;
    select * into it from public.items where id = l->>'id' for update;
    if not found then raise exception 'منتج غير موجود: %', l->>'id'; end if;
    select ic.cost into c from public.item_costs ic where ic.item_id = it.id;

    if p_type = 'adjust' then
      if q is null or q < 0 then raise exception 'كمية غير صحيحة'; end if;
      insert into public.movements (username, type, ref, item_id, sku, model, color, size, qty, channel, customer, note)
      values (public.my_username(), 'adjust', ref, it.id, it.sku, it.model, it.color, it.size, q - it.qty, p_channel, p_customer, p_note)
      returning id into mid;
      insert into public.movement_costs (movement_id, cost) values (mid, c);
      update public.items set qty = q where id = it.id;
      continue;
    end if;

    if q is null or q <= 0 then raise exception 'كمية غير صحيحة'; end if;
    pr := (l->>'price')::numeric;

    -- البيع: حد الخصم للموظف
    if p_type = 'sale' then
      pr := coalesce(pr, it.price);
      if pr is null then raise exception 'المنتج % بدون سعر — اطلب من المدير تحديد السعر', it.sku; end if;
      if pr < 0 then raise exception 'سعر غير صحيح'; end if;
      if not adm and it.price is not null and pr < round(it.price * (1 - max_disc / 100), 2) then
        raise exception 'السعر % أقل من الحد المسموح للكود % (أقل سعر %)', pr, it.sku, round(it.price * (1 - max_disc / 100), 2);
      end if;
    end if;

    -- المرتجع: مربوط بفاتورة البيع وكميتها وسعرها
    if p_type = 'return' and coalesce(p_orig_ref, '') <> '' then
      select coalesce(sum(m.qty), 0), max(m.price) into sold, sold_price
        from public.movements m where m.type = 'sale' and m.ref = p_orig_ref and m.item_id = it.id;
      if sold = 0 then raise exception 'الكود % غير موجود في الفاتورة %', it.sku, p_orig_ref; end if;
      select coalesce(sum(m.qty), 0) into returned
        from public.movements m where m.type = 'return' and m.orig_ref = p_orig_ref and m.item_id = it.id;
      if returned + q > sold then
        raise exception 'المرتجع أكثر من المباع للكود % في الفاتورة % (المتبقي %)', it.sku, p_orig_ref, sold - returned;
      end if;
      if not adm or pr is null then pr := sold_price; end if;
    end if;

    sign := case when p_type in ('receive','return') then 1 else -1 end;
    if sign < 0 and it.qty < q then
      raise exception 'الكمية غير كافية للكود % (المتوفر %)', it.sku, it.qty;
    end if;
    update public.items set qty = qty + sign * q where id = it.id;
    insert into public.movements (username, type, ref, orig_ref, item_id, sku, model, color, size, qty, price, channel, customer, note)
    values (public.my_username(), p_type, ref, nullif(p_orig_ref, ''), it.id, it.sku, it.model, it.color, it.size, q,
            case when p_type in ('sale','return') then coalesce(pr, it.price) end, p_channel, p_customer, p_note)
    returning id into mid;
    insert into public.movement_costs (movement_id, cost) values (mid, c);
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

-- إتمام حجز = بيع (يخضع لنفس حد الخصم)
create or replace function public.complete_reservation(p_id bigint, p_price numeric default null)
returns text language plpgsql security definer set search_path = public as $$
declare r public.reservations; ref text;
begin
  select * into r from public.reservations where id = p_id and status = 'active' for update;
  if not found then raise exception 'الحجز غير موجود أو مغلق'; end if;
  ref := public.stock_move('sale', jsonb_build_array(jsonb_build_object('id', r.item_id, 'qty', r.qty, 'price', p_price)),
                           null, r.customer, 'من حجز #' || r.id, 'studio', null);
  update public.reservations set status = 'sold', closed_at = now() where id = p_id;
  return ref;
end $$;

-- ---------- الأمان ----------
alter table public.item_costs     enable row level security;
alter table public.movements      enable row level security;
alter table public.movement_costs enable row level security;
alter table public.reservations   enable row level security;
alter table public.settings       enable row level security;

drop policy if exists item_costs_admin on public.item_costs;
create policy item_costs_admin on public.item_costs for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists movement_costs_admin on public.movement_costs;
create policy movement_costs_admin on public.movement_costs for select to authenticated using (public.is_admin());

drop policy if exists movements_read on public.movements;
create policy movements_read on public.movements for select to authenticated using (true);
-- لا insert/update/delete مباشر على الحركات — فقط عبر stock_move

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

grant select, insert, update, delete on public.item_costs to authenticated;
grant select on public.movements, public.movement_costs to authenticated;
grant select, insert, update, delete on public.reservations, public.settings to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke all on public.item_costs, public.movements, public.movement_costs, public.reservations, public.settings from anon;

revoke execute on function public.stock_move(text, jsonb, text, text, text, text, text), public.complete_reservation(bigint, numeric) from public, anon;
grant execute on function public.stock_move(text, jsonb, text, text, text, text, text), public.complete_reservation(bigint, numeric) to authenticated;

do $$ begin
  begin alter publication supabase_realtime add table public.reservations; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.movements;    exception when duplicate_object then null; end;
end $$;
