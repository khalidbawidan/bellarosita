-- =====================================================================
-- Bella Rosita — تحديث 3: الربط مع سلة
-- الصق هذا الملف في SQL Editor → Run   (آمن لإعادة التشغيل، لا يحذف بيانات)
-- =====================================================================

-- ---------- حقول SEO للمنتج ----------
alter table public.items add column if not exists seo_title    text not null default '';
alter table public.items add column if not exists seo_desc     text not null default '';
alter table public.items add column if not exists seo_keywords text not null default '';

-- ---------- ربط المنتجات بسلة ----------
-- كل موديل+لون = منتج في سلة
create table if not exists public.salla_products (
  grp         text primary key,          -- مثل 34185-BLU
  product_id  bigint,
  synced_at   timestamptz,
  last_error  text
);
-- كل مقاس = متغيّر (variant) في سلة
create table if not exists public.salla_variants (
  item_id     text primary key references public.items(id) on delete cascade,
  product_id  bigint,
  variant_id  bigint,
  synced_qty  integer,
  synced_at   timestamptz
);

-- مفاتيح سلة — لا يقرأها أحد من الموقع (بدون أي سياسة RLS = الخدمة الداخلية فقط)
create table if not exists public.salla_tokens (
  merchant          bigint primary key,
  access_token      text not null,
  refresh_token     text,
  expires_at        timestamptz,
  scope             text,
  refreshing_until  timestamptz,
  updated_at        timestamptz not null default now()
);

-- طلبات سلة المطبّقة على المخزون (لمنع التكرار)
create table if not exists public.salla_orders (
  order_id      bigint primary key,
  reference_id  text,
  lines         jsonb,
  missing       jsonb,
  applied       jsonb,               -- [{item_id, deducted, movement_id}] الكمية المخصومة فعلاً
  cancelled     boolean not null default false,
  received_at   timestamptz not null default now(),
  cancelled_at  timestamptz
);

-- سجل أحداث الربط
create table if not exists public.salla_log (
  id       bigserial primary key,
  at       timestamptz not null default now(),
  kind     text not null,      -- event / push / error
  message  text,
  payload  jsonb
);
alter table public.salla_orders add column if not exists applied jsonb;
create index if not exists salla_log_at_idx on public.salla_log (at desc);

-- ---------- تطبيق طلب سلة على المخزون (تستدعيه الخدمة الداخلية فقط) ----------
-- p_lines = [{"sku":"34185-BLU-8Y","qty":1,"price":365}, ...]
create or replace function public.apply_salla_order(p_order_id bigint, p_reference text, p_lines jsonb, p_customer text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare l jsonb; it public.items; q integer; d integer; mid bigint; c numeric; missing jsonb := '[]'::jsonb; applied jsonb := '[]'::jsonb; n integer := 0;
begin
  if exists (select 1 from public.salla_orders where order_id = p_order_id) then
    return jsonb_build_object('status', 'duplicate');
  end if;
  perform set_config('app.stock_op', 'on', true);
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    q := greatest(coalesce((l->>'qty')::integer, 0), 0);
    select * into it from public.items where sku = upper(trim(l->>'sku')) for update;
    if not found or q = 0 then missing := missing || jsonb_build_array(l); continue; end if;
    select ic.cost into c from public.item_costs ic where ic.item_id = it.id;
    d := least(it.qty, q);
    update public.items set qty = qty - d where id = it.id;
    insert into public.movements (username, type, ref, item_id, sku, model, color, size, qty, price, channel, customer, note)
    values ('سلة', 'sale', 'SALLA-' || coalesce(p_reference, p_order_id::text), it.id, it.sku, it.model, it.color, it.size, q,
            coalesce((l->>'price')::numeric, it.price), 'salla', p_customer,
            case when it.qty < q then 'تنبيه: المخزون في الموقع كان أقل من الطلب' end)
    returning id into mid;
    insert into public.movement_costs (movement_id, cost) values (mid, c);
    applied := applied || jsonb_build_array(jsonb_build_object('item_id', it.id, 'deducted', d, 'movement_id', mid));
    n := n + 1;
  end loop;
  perform set_config('app.stock_op', '', true);
  insert into public.salla_orders (order_id, reference_id, lines, missing, applied) values (p_order_id, p_reference, p_lines, missing, applied);
  return jsonb_build_object('status', 'applied', 'lines', n, 'missing', missing);
end $$;

-- إلغاء طلب سلة: ترجع القطع للمخزون
create or replace function public.cancel_salla_order(p_order_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.salla_orders; a jsonb; m public.movements; mid bigint; d integer; n integer := 0;
begin
  select * into o from public.salla_orders where order_id = p_order_id for update;
  if not found then return jsonb_build_object('status', 'unknown_order'); end if;
  if o.cancelled then return jsonb_build_object('status', 'already_cancelled'); end if;
  perform set_config('app.stock_op', 'on', true);
  for a in select * from jsonb_array_elements(coalesce(o.applied, '[]'::jsonb)) loop
    select * into m from public.movements where id = (a->>'movement_id')::bigint;
    d := (a->>'deducted')::integer;
    if not found or m.item_id is null then continue; end if;
    update public.items set qty = qty + d where id = m.item_id;
    insert into public.movements (username, type, ref, orig_ref, item_id, sku, model, color, size, qty, price, channel, customer, note)
    values ('سلة', 'return', 'SALLA-X-' || coalesce(o.reference_id, o.order_id::text), m.ref, m.item_id, m.sku, m.model, m.color, m.size, m.qty, m.price, 'salla', m.customer, 'إلغاء طلب سلة')
    returning id into mid;
    insert into public.movement_costs (movement_id, cost) select mid, mc.cost from public.movement_costs mc where mc.movement_id = m.id;
    n := n + 1;
  end loop;
  perform set_config('app.stock_op', '', true);
  update public.salla_orders set cancelled = true, cancelled_at = now() where order_id = p_order_id;
  return jsonb_build_object('status', 'cancelled', 'lines', n);
end $$;

-- ---------- الأمان ----------
alter table public.salla_products enable row level security;
alter table public.salla_variants enable row level security;
alter table public.salla_tokens   enable row level security;   -- بدون سياسات: لا يصل لها إلا service_role
alter table public.salla_orders   enable row level security;
alter table public.salla_log      enable row level security;

drop policy if exists salla_products_admin on public.salla_products;
create policy salla_products_admin on public.salla_products for select to authenticated using (public.is_admin());
drop policy if exists salla_variants_admin on public.salla_variants;
create policy salla_variants_admin on public.salla_variants for select to authenticated using (public.is_admin());
drop policy if exists salla_orders_admin on public.salla_orders;
create policy salla_orders_admin on public.salla_orders for select to authenticated using (public.is_admin());
drop policy if exists salla_log_admin on public.salla_log;
create policy salla_log_admin on public.salla_log for select to authenticated using (public.is_admin());

grant select on public.salla_products, public.salla_variants, public.salla_orders, public.salla_log to authenticated;
revoke all on public.salla_tokens from authenticated, anon;
revoke all on public.salla_products, public.salla_variants, public.salla_orders, public.salla_log from anon;

revoke execute on function public.apply_salla_order(bigint, text, jsonb, text), public.cancel_salla_order(bigint) from public, anon, authenticated;
grant execute on function public.apply_salla_order(bigint, text, jsonb, text), public.cancel_salla_order(bigint) to service_role;
