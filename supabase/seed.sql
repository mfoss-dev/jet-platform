-- Demo data for local and Test (staging) only. Never run against Production.
-- Matches the prototype and wireframes (Harbour Optics, Kestrel Medical, week 44 of FY27).
-- Reference data from Wayne's JetStream database (carriers, services, tariffs) replaces the carrier rows later.

insert into public.carriers (code, name) values
  ('DHL', 'DHL Express'), ('TNT', 'TNT'), ('FEDEX', 'FedEx'), ('STARTRACK', 'StarTrack'), ('ARAMEX', 'Aramex')
on conflict (code) do nothing;

insert into public.services (id, carrier_code, code, name) values
  ('5e000000-0000-4000-8000-000000000001', 'DHL', 'WPX', 'DHL Express WW'),
  ('5e000000-0000-4000-8000-000000000002', 'DHL', 'ESU', 'DHL Economy Select'),
  ('5e000000-0000-4000-8000-000000000003', 'DHL', 'TDK', 'DHL Express 9:00'),
  ('5e000000-0000-4000-8000-000000000004', 'DHL', 'TDT', 'DHL Express 12:00'),
  ('5e000000-0000-4000-8000-000000000005', 'TNT', 'RD', 'TNT Road'),
  ('5e000000-0000-4000-8000-000000000006', 'FEDEX', 'IP', 'FedEx International Priority'),
  ('5e000000-0000-4000-8000-000000000007', 'STARTRACK', 'EXP', 'StarTrack Express'),
  ('5e000000-0000-4000-8000-000000000008', 'ARAMEX', 'STD', 'Aramex Standard')
on conflict do nothing;

-- Demo add-on rules, shaped like JetStream's SalesAddOn: the freight line, weekly fuel, security, GST and a few surcharges.
insert into public.addon_rules (id, branch_code, service_code, code, description, valid_from, valid_to, apply_when, percentage_of, percentage, fixed_fee, minimum, range_from, range_to, add_fuel, add_security, add_gst)
values
  ('7e000000-0000-4000-8000-000000000001', 'AU', null, '.FREIGHT', 'Freight', '2026-01-01', '9999-12-31', 'ALWAYS', 'F', 100, 0, 0, null, null, true, true, true),
  ('7e000000-0000-4000-8000-000000000002', 'AU', 'INTOUTEXP', '#FUEL', 'Fuel surcharge', '2026-10-26', '2026-11-01', 'ADD=Y', null, 41.0, 0, 0, null, null, false, false, true),
  ('7e000000-0000-4000-8000-000000000003', 'AU', 'INTOUTEXP', '#FUEL', 'Fuel surcharge', '2026-11-02', '9999-12-31', 'ADD=Y', null, 42.5, 0, 0, null, null, false, false, true),
  ('7e000000-0000-4000-8000-000000000004', 'AU', null, '#SEC', 'Security surcharge', '2026-01-01', '9999-12-31', 'ADD=Y', null, 2, 0, 0, null, null, false, false, true),
  ('7e000000-0000-4000-8000-000000000005', 'AU', null, '#GST', 'GST', '2026-01-01', '9999-12-31', 'ADD=Y', null, 10, 0, 0, null, null, false, false, false),
  ('7e000000-0000-4000-8000-000000000006', 'AU', 'INTOUTEXP', 'PSS', 'Peak season surcharge', '2026-10-01', '2027-01-31', 'DESTCC/KG', 'W', 0.5, 0.75, 0, 'GB', 'GB', true, true, true),
  ('7e000000-0000-4000-8000-000000000007', 'AU', null, 'RAPD', 'Remote area pickup', '2026-01-01', '9999-12-31', 'ORIGPC', 'F', 0, 37, 0, '2830', '2899', false, false, true),
  ('7e000000-0000-4000-8000-000000000008', 'AU', null, 'INSUR', 'Insurance', '2026-01-01', '9999-12-31', 'INSURED', 'I', 2.5, 0, 25, null, null, false, false, true),
  ('7e000000-0000-4000-8000-000000000009', 'AU', null, 'OSPI1', 'Overweight piece', '2026-01-01', '9999-12-31', 'PCWEIGHT', 'F', 0, 180, 0, '70.001', '99999', true, true, true),
  ('7e000000-0000-4000-8000-000000000010', 'AU', null, 'zADHOC', 'Ad hoc charge', '2026-01-01', '9999-12-31', 'ADHOC', 'F', 0, 0, 0, null, null, false, false, false)
on conflict (id) do nothing;

insert into public.customers (id, account_code, name, branch_code, status, payment_terms_days, billing_email, hold_reason, hold_note) values
  ('c0000000-0000-4000-8000-000000000001', 'SYD1021', 'Harbour Optics', 'AU', 'active', 14, 'accounts@harbouroptics.example', null, null),
  ('c0000000-0000-4000-8000-000000000002', 'SYD1007', 'Kestrel Medical', 'AU', 'active', 30, 'ap@kestrelmedical.example', null, null),
  ('c0000000-0000-4000-8000-000000000003', 'SYD1088', 'Bondi Surf Supply', 'AU', 'active', 14, 'office@bondisurf.example', null, null),
  ('c0000000-0000-4000-8000-000000000004', 'SYD1112', 'Northside Print', 'AU', 'active', 14, 'hello@northsideprint.example', null, null),
  ('c0000000-0000-4000-8000-000000000005', 'SYD1034', 'Coastal Pharma', 'AU', 'active', 30, 'finance@coastalpharma.example', null, null),
  ('c0000000-0000-4000-8000-000000000006', 'SYD1150', 'Redfern Tiles', 'AU', 'on_hold', 14, 'accounts@redferntiles.example', 'overdue', 'Invoice 13080 is 21 days overdue'),
  ('c0000000-0000-4000-8000-000000000007', 'SYD1163', 'Coastal Cycles', 'AU', 'active', 14, 'admin@coastalcycles.example', null, null),
  ('c0000000-0000-4000-8000-000000000008', 'SYD1170', 'Bright Labs', 'AU', 'active', 14, 'ops@brightlabs.example', null, null),
  ('c0000000-0000-4000-8000-000000000009', 'AKL2033', 'Kauri Craft Ltd', 'NZ', 'on_hold', 20, 'accounts@kauricraft.example', 'overdue', 'Promised payment Friday (Maree)'),
  ('c0000000-0000-4000-8000-000000000010', 'AKL2041', 'Tasman Outdoor', 'NZ', 'active', 20, 'ap@tasmanoutdoor.example', null, null)
on conflict (id) do nothing;

update public.customers set held_at = now() where status = 'on_hold' and held_at is null;

-- Demo tariffs in JetStream's shape (local and Test only; Test is replaced by the real import from JetStream).
-- A small zone guide (country -> group, Sydney -> group -> zone), one DHL Express rate card with a published 2026
-- version and a 2027 draft (+3.5%), two sales tariffs with a margin per rate row, and the AU demo customers assigned.
insert into public.zone_sets (id, branch_code, code, name) values
  ('7d000000-0000-4000-8000-000000000001', 'AU', 'DEMO-INTOUT', 'Demo international outbound zone guide')
on conflict (id) do nothing;

insert into public.zone_groups (zone_set_id, country_code, range_from, range_to, group_code)
select '7d000000-0000-4000-8000-000000000001', g.country, g.r_from, g.r_to, g.grp
from (values ('AU', 2000, 2999, 'SYD'), ('AU', 0, 9999, 'AU'), ('NZ', 0, 9999, 'NZ'), ('SG', 0, 999999, 'SG'),
             ('GB', 0, 999999, 'GB'), ('US', 0, 99999, 'US')) as g (country, r_from, r_to, grp)
where not exists (select 1 from public.zone_groups where zone_set_id = '7d000000-0000-4000-8000-000000000001');

insert into public.zone_lanes (zone_set_id, orig_group, dest_group, zone_code)
select '7d000000-0000-4000-8000-000000000001', 'AU', l.dest, l.zone
from (values ('NZ', '1'), ('SG', '2'), ('GB', '6'), ('US', '7')) as l (dest, zone)
on conflict do nothing;

insert into public.base_tariffs (id, code, name, branch_code, carrier_code, service_code, zone_set_id) values
  ('7a000000-0000-4000-8000-000000000001', 'DHL.OUT.EXPR', 'DHL International Outbound Express (demo)', 'AU', 'DHL', 'INTOUTEXP', '7d000000-0000-4000-8000-000000000001')
on conflict (id) do nothing;

insert into public.tariff_versions (id, tariff_id, version, note, volumetric_divisor) values
  ('7b000000-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-000000000001', 1, '2026 DHL rates', 5000)
on conflict (id) do nothing;

-- Per zone: documents to 0.5 kg; parcels 0.5 kg first step, then per 0.5 kg to 2 kg and to 30 kg, then per kg.
insert into public.tariff_rates (version_id, zone_code, kind, from_kg, to_kg, step_kg, method, charge)
select '7b000000-0000-4000-8000-000000000001', z.zone, r.kind, r.f, r.t, r.step, r.method, round(r.base * z.factor, 2)
from (values ('1', 0.80), ('2', 0.90), ('6', 1.00), ('7', 1.10)) as z (zone, factor)
cross join (values ('doc', 0, 0.5, 0.5, 'I', 20.07), ('parcel', 0, 0.5, 0.5, 'I', 24.55), ('parcel', 0.5, 2, 0.5, 'I', 3.23),
                   ('parcel', 2, 30, 0.5, 'I', 3.10), ('parcel', 30, 300, 1, 'M', 6.01)) as r (kind, f, t, step, method, base)
where exists (select 1 from public.tariff_versions where id = '7b000000-0000-4000-8000-000000000001' and status = 'draft')
  and not exists (select 1 from public.tariff_rates where version_id = '7b000000-0000-4000-8000-000000000001');

update public.tariff_versions set status = 'published', valid_from = '2026-01-01', published_at = now()
where id = '7b000000-0000-4000-8000-000000000001' and status = 'draft';

insert into public.tariff_versions (id, tariff_id, version, note, volumetric_divisor)
select '7b000000-0000-4000-8000-000000000002', '7a000000-0000-4000-8000-000000000001', 2, '2027 DHL rates (+3.5%, draft)', 5000
where not exists (select 1 from public.tariff_versions where id = '7b000000-0000-4000-8000-000000000002');

insert into public.tariff_rates (version_id, zone_code, kind, from_kg, to_kg, step_kg, method, charge, basic, minimum)
select '7b000000-0000-4000-8000-000000000002', zone_code, kind, from_kg, to_kg, step_kg, method, round(charge * 1.035, 2), basic, minimum
from public.tariff_rates where version_id = '7b000000-0000-4000-8000-000000000001'
  and exists (select 1 from public.tariff_versions where id = '7b000000-0000-4000-8000-000000000002' and status = 'draft')
  and not exists (select 1 from public.tariff_rates where version_id = '7b000000-0000-4000-8000-000000000002');

insert into public.sales_tariffs (id, code, name, base_tariff_id, branch_code, service_code) values
  ('7c000000-0000-4000-8000-000000000001', 'STANDARD', 'Standard (demo)', '7a000000-0000-4000-8000-000000000001', 'AU', 'INTOUTEXP'),
  ('7c000000-0000-4000-8000-000000000002', 'KEY', 'Key accounts (demo)', '7a000000-0000-4000-8000-000000000001', 'AU', 'INTOUTEXP')
on conflict (id) do nothing;

-- A margin for every rate row: Key accounts 30 / 29 / 28 / 25 % by break, Standard 8 points higher.
insert into public.sales_margins (sales_tariff_id, zone_code, kind, to_kg, margin_pct)
select s.id, r.zone_code, r.kind, r.to_kg,
       (case when r.kind = 'doc' or r.to_kg = 0.5 then 30 when r.to_kg = 2 then 29 when r.to_kg = 30 then 28 else 25 end)
       + case s.code when 'STANDARD' then 8 else 0 end
from public.sales_tariffs s
join public.tariff_rates r on r.version_id = '7b000000-0000-4000-8000-000000000001'
where s.id in ('7c000000-0000-4000-8000-000000000001', '7c000000-0000-4000-8000-000000000002')
on conflict do nothing;

insert into public.customer_tariffs (customer_id, service_code, effective_from, sales_tariff_id)
select c.id, 'INTOUTEXP', '2026-01-01',
       case when c.account_code in ('SYD1021', 'SYD1007') then '7c000000-0000-4000-8000-000000000002'::uuid else '7c000000-0000-4000-8000-000000000001'::uuid end
from public.customers c
where c.branch_code = 'AU'
on conflict do nothing;

update public.sales_tariffs set is_standard = true where id = '7c000000-0000-4000-8000-000000000001' and not is_standard;

-- Demo shipment history for the pricing review: 40 jobs per Sydney customer through 2026, billed on their tariff.
insert into public.billed_shipments (connote, customer_id, branch_code, service_code, shipped_on, kind, orig_country, orig_postcode,
  dest_country, dest_postcode, weight, freight, source)
select 'DEMO' || c.account_code || lpad(n::text, 2, '0'), c.id, 'AU', 'INTOUTEXP', date '2026-01-05' + n * 7,
       case when n % 5 = 0 then 'doc' else 'parcel' end, 'AU', '2000', d.country, '',
       w.kg, public.freight_charge('7b000000-0000-4000-8000-000000000001', ct.sales_tariff_id, d.zone, case when n % 5 = 0 then 'doc' else 'parcel' end, w.kg), 'demo'
from public.customers c
join public.customer_tariffs ct on ct.customer_id = c.id and ct.service_code = 'INTOUTEXP'
cross join generate_series(0, 39) n
join (values (0, 'NZ', '1'), (1, 'SG', '2'), (2, 'GB', '6'), (3, 'US', '7')) as d (i, country, zone) on d.i = (n + length(c.name)) % 4
join (values (0, 0.5), (1, 1.2), (2, 3.2), (3, 7.5), (4, 18.0), (5, 42.0)) as w (i, kg) on w.i = (n * 7 + length(c.name)) % 6
where c.branch_code = 'AU'
on conflict (connote) do nothing;

-- Week 44 exceptions: the seven rows on the billing feed's "Needs attention" view.
insert into public.jobs (connote, customer_id, branch_code, carrier_code, service_id, booked_at, origin_city, origin_country, dest_city, dest_country,
                         declared_weight_kg, carrier_weight_kg, sell_ex_gst, cost_ex_gst, status, billing_status, issue, issue_note) values
  ('JWW1048802', 'c0000000-0000-4000-8000-000000000002', 'AU', 'DHL', '5e000000-0000-4000-8000-000000000002', '2026-10-27 10:12+11', 'Sydney', 'AU', 'Los Angeles', 'US',
   12.0, 14.4, 171.60, 96.10, 'delivered', 'needs_attention', 'reweigh', 'Declared 12.0 kg, DHL measured 14.4 kg (31.7 lb, converted)'),
  ('JWW1048611', 'c0000000-0000-4000-8000-000000000003', 'AU', 'DHL', '5e000000-0000-4000-8000-000000000001', '2026-10-26 14:40+11', 'Sydney', 'AU', 'Honolulu', 'US',
   2.0, 3.5, 64.20, 41.00, 'delivered', 'needs_attention', 'reweigh', 'Declared 2.0 kg, DHL measured 3.5 kg'),
  ('JWW1048790', 'c0000000-0000-4000-8000-000000000004', 'AU', 'TNT', '5e000000-0000-4000-8000-000000000005', '2026-10-27 09:05+11', 'Sydney', 'AU', 'Melbourne', 'AU',
   22.0, 22.0, 38.50, 41.00, 'delivered', 'needs_attention', 'below_cost', 'TNT charged a 22 kg rate; customer tariff only goes to 20 kg'),
  ('JWW1048770', 'c0000000-0000-4000-8000-000000000005', 'AU', 'DHL', '5e000000-0000-4000-8000-000000000003', '2026-10-26 08:30+11', 'Sydney', 'AU', 'Auckland', 'NZ',
   4.0, 4.0, null, 55.00, 'delivered', 'needs_attention', 'no_rate', 'Coastal Pharma has no tariff for DHL Express 9:00'),
  ('JWW1047920', 'c0000000-0000-4000-8000-000000000003', 'AU', 'DHL', '5e000000-0000-4000-8000-000000000001', '2026-10-22 11:20+11', 'Sydney', 'AU', 'Suva', 'FJ',
   6.5, 6.5, 96.00, 98.60, 'delivered', 'needs_attention', 'remote_area', 'Remote area surcharge on DHL invoice 88123, not on the booking'),
  ('JWW1047766', 'c0000000-0000-4000-8000-000000000005', 'AU', 'DHL', '5e000000-0000-4000-8000-000000000001', '2026-10-21 16:02+11', 'Sydney', 'AU', 'London', 'GB',
   1.5, 1.5, 0.00, 22.00, 'delivered', 'needs_attention', 'address_fee', 'Address correction fee on DHL invoice 88123'),
  ('TNT-778120', 'c0000000-0000-4000-8000-000000000006', 'AU', 'TNT', '5e000000-0000-4000-8000-000000000005', '2026-10-25 13:00+11', 'Sydney', 'AU', 'Newcastle', 'AU',
   48.0, 48.0, 228.00, 162.00, 'delivered', 'needs_attention', 'manual_job', 'Keyed by hand; check before invoicing')
on conflict (connote) do nothing;

-- Ready-to-invoice jobs for week 44 (deterministic, so every reset gives the same totals).
insert into public.jobs (connote, customer_id, branch_code, carrier_code, service_id, booked_at, origin_city, origin_country, dest_city, dest_country,
                         declared_weight_kg, carrier_weight_kg, sell_ex_gst, cost_ex_gst, status, billing_status)
select
  'JWW10490' || lpad(n::text, 2, '0'),
  ('c0000000-0000-4000-8000-0000000000' || lpad((1 + n % 8)::text, 2, '0'))::uuid,
  'AU',
  case when n % 5 = 0 then 'TNT' else 'DHL' end,
  case when n % 5 = 0 then '5e000000-0000-4000-8000-000000000005' when n % 3 = 0 then '5e000000-0000-4000-8000-000000000002'
       else '5e000000-0000-4000-8000-000000000001' end::uuid,
  timestamptz '2026-10-26 08:00+11' + (n * interval '97 minutes'),
  'Sydney', 'AU',
  (array['London', 'Auckland', 'Los Angeles', 'Singapore', 'Tokyo', 'Melbourne', 'Brisbane', 'Hong Kong'])[1 + n % 8],
  (array['GB', 'NZ', 'US', 'SG', 'JP', 'AU', 'AU', 'HK'])[1 + n % 8],
  round((1 + (n * 7) % 23)::numeric, 1),
  round((1 + (n * 7) % 23)::numeric, 1),
  round((38 + (n * 37) % 190)::numeric * 1.00, 2),
  round((38 + (n * 37) % 190)::numeric * (0.58 + (n % 7) * 0.02), 2),
  case when n % 6 = 0 then 'in_transit' else 'delivered' end::public.job_status,
  'ready'
from generate_series(1, 60) as n
on conflict (connote) do nothing;

-- One NZ job on hold (account overdue).
insert into public.jobs (connote, customer_id, branch_code, carrier_code, service_id, booked_at, origin_city, origin_country, dest_city, dest_country,
                         declared_weight_kg, carrier_weight_kg, sell_ex_gst, cost_ex_gst, status, billing_status, issue_note) values
  ('JWW2050117', 'c0000000-0000-4000-8000-000000000009', 'NZ', 'DHL', '5e000000-0000-4000-8000-000000000001', '2026-10-27 12:00+13', 'Auckland', 'NZ', 'Sydney', 'AU',
   3.0, 3.0, 88.00, 51.20, 'delivered', 'on_hold', 'Account on hold: 45 days overdue')
on conflict (connote) do nothing;

-- Today's reweighs waiting for a decision (the two DHL reweigh exceptions above, plus three within tolerance).
insert into public.reweighs (job_id, source_file, declared_kg, carrier_kg, extra_charge)
select id, 'DHL_REWEIGH_20261028.csv', declared_weight_kg, carrier_weight_kg,
       case connote when 'JWW1048802' then 22.70 when 'JWW1048611' then 16.00 end
from public.jobs where connote in ('JWW1048802', 'JWW1048611')
  and not exists (select 1 from public.reweighs r where r.job_id = jobs.id);

insert into public.reweighs (job_id, source_file, declared_kg, carrier_kg, extra_charge)
select id, 'DHL_REWEIGH_20261028.csv', declared_weight_kg, declared_weight_kg + 0.4, 4.10
from public.jobs where connote in ('JWW1049001', 'JWW1049002', 'JWW1049004')
  and not exists (select 1 from public.reweighs r where r.job_id = jobs.id);

-- Staff invitations. Replace these example addresses with real ones in the Test project
-- (or add your own row) and the profile is created with this role on first sign-in.
insert into public.user_invites (email, full_name, role, branch_code) values
  ('kym@jetworldwide.example', 'Kym', 'owner', 'AU'),
  ('chris@jetworldwide.example', 'Chris Jones', 'management', 'AU'),
  ('nigel@jetworldwide.example', 'Nigel Munt', 'management', 'NZ'),
  ('monica@jetworldwide.example', 'Monica', 'finance', 'AU'),
  ('maree@jetworldwide.example', 'Maree', 'finance', 'NZ'),
  ('sam@jetworldwide.example', 'Sam Patel', 'sales_rep', 'AU')
on conflict (email) do nothing;

-- Enabla admins (support and development). Test only: Production admins are added deliberately at go-live.
insert into public.user_invites (email, full_name, role, branch_code) values
  ('mitch@enablatechnology.com', 'Mitch', 'admin', 'AU'),
  ('evan@enablatechnology.com', 'Evan', 'admin', 'AU')
on conflict (email) do nothing;

insert into public.user_invites (email, full_name, role, customer_id) values
  ('priya@harbouroptics.example', 'Priya Shah', 'customer_admin', 'c0000000-0000-4000-8000-000000000001')
on conflict (email) do nothing;

-- ---------------------------------------------------------------- invoicing demo
insert into public.invoice_sequences (branch_code, next_number) values ('AU', 356500), ('NZ', 21500) on conflict (branch_code) do nothing;
update public.customers set invoice_recipients = billing_email where invoice_recipients is null and billing_email is not null;
-- Coastal Cycles' invoices go to Coastal Pharma (a bill-to account, as JetStream's BillTo).
update public.customers set bill_to_id = 'c0000000-0000-4000-8000-000000000005' where account_code = 'SYD1163' and bill_to_id is null;

-- Last week's shipments, unbilled: freight with fuel 42.5% and security 2% (exports carry no GST).
insert into public.charges (id, branch_code, customer_id, connote, shipped_on, service_code, code, description, charge, fuel, security, gst,
  pieces, weight, orig_country, dest_country, source)
select ('7f000000-0000-4000-8000-' || lpad(row_number() over (order by b.connote)::text, 12, '0'))::uuid, 'AU', b.customer_id,
       'DEMOW' || b.connote, date '2026-10-26' + (row_number() over (order by b.connote))::integer % 6, b.service_code, '.FREIGHT', 'Freight',
       b.freight, round(b.freight * 0.425, 2), round(b.freight * 0.02, 2), 0, 1, b.weight, 'AU', b.dest_country, 'demo'
from public.billed_shipments b
where b.source = 'demo' and b.shipped_on >= '2026-09-25'
on conflict (id) do nothing;
insert into public.charges (id, branch_code, customer_id, connote, shipped_on, service_code, code, description, charge, gst, source) values
  ('7f000000-0000-4000-8000-100000000001', 'AU', 'c0000000-0000-4000-8000-000000000005', 'DEMOW-ADHOC', '2026-10-29', 'INTOUTEXP', 'zADHOC', 'Storage, 3 pallets', 120, 12, 'demo'),
  ('7f000000-0000-4000-8000-100000000002', 'NZ', 'c0000000-0000-4000-8000-000000000009', 'DEMOW-NZ1', '2026-10-28', 'INTOUTEXP', '.FREIGHT', 'Freight', 86.40, 0, 'demo')
on conflict (id) do nothing;
insert into public.charges (id, branch_code, customer_id, connote, shipped_on, service_code, kind, code, description, charge, gst, source) values
  ('7f000000-0000-4000-8000-200000000001', 'AU', 'c0000000-0000-4000-8000-000000000002', 'DEMOW-C1', '2026-10-30', 'CUSTOMS', 'duties', 'z#DTY', 'Customs: Total Duty', 64.20, 0, 'demo'),
  ('7f000000-0000-4000-8000-200000000002', 'AU', 'c0000000-0000-4000-8000-000000000002', 'DEMOW-C1', '2026-10-30', 'CUSTOMS', 'duties', 'z#CST', 'Customs: Broker Fee', 22, 2.20, 'demo')
on conflict (id) do nothing;


-- JetSales demo: rep codes and who looks after each demo account (the real ones come from JetStream's SalesRep).
insert into public.sales_reps (code, name, branch_code, is_house, source) values
  ('HOUSE', 'House accounts', null, true, 'demo'),
  ('SAM', 'Sam (demo rep)', 'AU', false, 'demo'),
  ('DEMO2', 'Second demo rep', 'AU', false, 'demo'),
  ('NZREP', 'Auckland demo rep', 'NZ', false, 'demo')
on conflict (code) do nothing;
update public.customers set sales_rep_code = case account_code
    when 'SYD1021' then 'SAM' when 'SYD1088' then 'SAM' when 'SYD1007' then 'DEMO2' when 'SYD1112' then 'DEMO2'
    when 'AKL2033' then 'NZREP' when 'AKL2041' then 'NZREP' else 'HOUSE' end
 where sales_rep_code is null and id::text like 'c0000000-%';
update public.customers set first_trade_date = date '2026-09-01' where account_code = 'SYD1170' and first_trade_date is null;
