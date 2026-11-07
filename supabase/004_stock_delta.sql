-- =====================================================================
-- Bella Rosita — تحديث 4: فصل "كمية العملية" عن "التغيّر الفعلي في المخزون"
--   qty          = الكمية المباعة/المرتجعة (لتقارير المبيعات)
--   stock_delta  = التغيّر الفعلي في المخزون (+/-) (لمطابقة المخزون)
-- الصق هذا الملف في SQL Editor → Run   (آمن لإعادة التشغيل، لا يحذف بيانات)
-- =====================================================================

alter table public.movements add column if not exists stock_delta integer;

-- تعبئة تلقائية للعمليات العادية (البيع/الاستلام/المرتجع/التالف/التعديل)
create or replace function public.movements_fill_delta() returns trigger
language plpgsql as $$
begin
  if new.stock_delta is null then
    new.stock_delta := case new.type
      when 'sale'    then -new.qty
      when 'damage'  then -new.qty
      when 'receive' then  new.qty
      when 'return'  then  new.qty
      else new.qty                       -- adjust: qty هنا أصلاً هو الفرق
    end;
  end if;
  return new;
end $$;
drop trigger if exists movements_fill_delta on public.movements;
create trigger movements_fill_delta before insert on public.movements
  for each row execute function public.movements_fill_delta();

-- تعبئة الحركات القديمة
update public.movements set stock_delta = case type
  when 'sale' then -qty when 'damage' then -qty when 'receive' then qty when 'return' then qty else qty end
where stock_delta is null;

-- تصحيح حركات سلة القديمة (إن وجدت) حسب الكمية المخصومة فعلاً
update public.movements m set stock_delta = -(a->>'deducted')::integer
from public.salla_orders o, jsonb_array_elements(coalesce(o.applied, '[]'::jsonb)) a
where m.id = (a->>'movement_id')::bigint;
update public.movements r set stock_delta = (a->>'deducted')::integer
from public.salla_orders o, jsonb_array_elements(coalesce(o.applied, '[]'::jsonb)) a, public.movements s
where o.cancelled and s.id = (a->>'movement_id')::bigint
  and r.type = 'return' and r.channel = 'salla' and r.orig_ref = s.ref and r.item_id = s.item_id;

-- ---------- دوال سلة: تسجّل التغيّر الفعلي ----------
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
    insert into public.movements (username, type, ref, item_id, sku, model, color, size, qty, stock_delta, price, channel, customer, note)
    values ('سلة', 'sale', 'SALLA-' || coalesce(p_reference, p_order_id::text), it.id, it.sku, it.model, it.color, it.size, q, -d,
            coalesce((l->>'price')::numeric, it.price), 'salla', p_customer,
            case when d < q then 'تنبيه: المخزون في الموقع كان ' || it.qty || ' فقط — انخصم ' || d end)
    returning id into mid;
    insert into public.movement_costs (movement_id, cost) values (mid, c);
    applied := applied || jsonb_build_array(jsonb_build_object('item_id', it.id, 'deducted', d, 'movement_id', mid));
    n := n + 1;
  end loop;
  perform set_config('app.stock_op', '', true);
  insert into public.salla_orders (order_id, reference_id, lines, missing, applied) values (p_order_id, p_reference, p_lines, missing, applied);
  return jsonb_build_object('status', 'applied', 'lines', n, 'missing', missing);
end $$;

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
    insert into public.movements (username, type, ref, orig_ref, item_id, sku, model, color, size, qty, stock_delta, price, channel, customer, note)
    values ('سلة', 'return', 'SALLA-X-' || coalesce(o.reference_id, o.order_id::text), m.ref, m.item_id, m.sku, m.model, m.color, m.size, m.qty, d, m.price, 'salla', m.customer,
            case when d < m.qty then 'إلغاء طلب سلة — رجع للمخزون ' || d || ' فقط' else 'إلغاء طلب سلة' end)
    returning id into mid;
    insert into public.movement_costs (movement_id, cost) select mid, mc.cost from public.movement_costs mc where mc.movement_id = m.id;
    n := n + 1;
  end loop;
  perform set_config('app.stock_op', '', true);
  update public.salla_orders set cancelled = true, cancelled_at = now() where order_id = p_order_id;
  return jsonb_build_object('status', 'cancelled', 'lines', n);
end $$;

revoke execute on function public.apply_salla_order(bigint, text, jsonb, text), public.cancel_salla_order(bigint) from public, anon, authenticated;
grant execute on function public.apply_salla_order(bigint, text, jsonb, text), public.cancel_salla_order(bigint) to service_role;
