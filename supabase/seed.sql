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

insert into public.fuel_surcharges (carrier_code, rate_pct, effective_from) values
  ('DHL', 41.0, '2026-10-26'), ('DHL', 42.5, '2026-11-02'),
  ('TNT', 18.9, '2026-10-26'),
  ('FEDEX', 39.0, '2026-10-26'), ('FEDEX', 39.5, '2026-11-02')
on conflict do nothing;

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

-- Demo tariffs, shaped like JetStream's: a DHL Express rate card (zone x weight break), a published version
-- from 1 Jan 2026 and a 2027 draft at +3.5%, two sales tariffs (margin by zone and weight band) and customer assignments.
insert into public.base_tariffs (id, code, name, branch_code, carrier_code, service_id) values
  ('7a000000-0000-4000-8000-000000000001', 'DHL-WPX-AU', 'DHL Express Worldwide (Sydney)', 'AU', 'DHL', '5e000000-0000-4000-8000-000000000001')
on conflict (id) do nothing;

insert into public.tariff_versions (id, tariff_id, version, note) values
  ('7b000000-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-000000000001', 1, '2026 DHL rates')
on conflict (id) do nothing;

-- Rows are added only while the version is still a draft (published rate cards are locked).
insert into public.tariff_breaks (version_id, kind, to_kg, method, step_kg)
select '7b000000-0000-4000-8000-000000000001', b.kind, b.to_kg, b.method, b.step
from (values ('doc', 0.5, 'E', 0.5), ('doc', 1.0, 'E', 0.5), ('doc', 2.0, 'E', 0.5),
             ('parcel', 0.5, 'E', 0.5), ('parcel', 1.0, 'E', 0.5), ('parcel', 2.0, 'E', 0.5), ('parcel', 5.0, 'I', 0.5),
             ('parcel', 10.0, 'I', 0.5), ('parcel', 20.0, 'I', 0.5), ('parcel', 30.0, 'I', 0.5), ('parcel', 300.0, 'M', 1.0)) as b (kind, to_kg, method, step)
where exists (select 1 from public.tariff_versions where id = '7b000000-0000-4000-8000-000000000001' and status = 'draft')
  and not exists (select 1 from public.tariff_breaks where version_id = '7b000000-0000-4000-8000-000000000001');

insert into public.tariff_cells (version_id, kind, to_kg, zone_code, charge)
select b.version_id, b.kind, b.to_kg, z.code,
       round(case
         when b.to_kg = 0.5 then 28 + z.sort * 4
         when b.to_kg = 1.0 then 34 + z.sort * 5
         when b.to_kg = 2.0 then 42 + z.sort * 6
         when b.method = 'I' then 3 + z.sort * 0.6 - (b.to_kg / 30)
         else 6 + z.sort * 0.8
       end - case when b.kind = 'doc' then 3 else 0 end, 2)
from public.tariff_breaks b cross join public.zones z
where b.version_id = '7b000000-0000-4000-8000-000000000001'
  and exists (select 1 from public.tariff_versions where id = b.version_id and status = 'draft')
  and not exists (select 1 from public.tariff_cells c where c.version_id = b.version_id);

update public.tariff_versions set status = 'published', valid_from = '2026-01-01', published_at = now()
where id = '7b000000-0000-4000-8000-000000000001' and status = 'draft';

insert into public.tariff_versions (id, tariff_id, version, note)
select '7b000000-0000-4000-8000-000000000002', '7a000000-0000-4000-8000-000000000001', 2, '2027 DHL rates (+3.5%, draft)'
where not exists (select 1 from public.tariff_versions where id = '7b000000-0000-4000-8000-000000000002');

insert into public.tariff_breaks (version_id, kind, to_kg, method, step_kg)
select '7b000000-0000-4000-8000-000000000002', kind, to_kg, method, step_kg from public.tariff_breaks
where version_id = '7b000000-0000-4000-8000-000000000001'
  and exists (select 1 from public.tariff_versions where id = '7b000000-0000-4000-8000-000000000002' and status = 'draft')
  and not exists (select 1 from public.tariff_breaks where version_id = '7b000000-0000-4000-8000-000000000002');

insert into public.tariff_cells (version_id, kind, to_kg, zone_code, charge)
select '7b000000-0000-4000-8000-000000000002', kind, to_kg, zone_code, round(charge * 1.035, 2) from public.tariff_cells
where version_id = '7b000000-0000-4000-8000-000000000001'
  and exists (select 1 from public.tariff_versions where id = '7b000000-0000-4000-8000-000000000002' and status = 'draft')
  and not exists (select 1 from public.tariff_cells where version_id = '7b000000-0000-4000-8000-000000000002');

insert into public.sales_tariffs (id, code, name, base_tariff_id) values
  ('7c000000-0000-4000-8000-000000000001', 'STANDARD', 'Standard', '7a000000-0000-4000-8000-000000000001'),
  ('7c000000-0000-4000-8000-000000000002', 'KEY', 'Key accounts', '7a000000-0000-4000-8000-000000000001')
on conflict (id) do nothing;

insert into public.sales_margins (sales_tariff_id, zone_code, up_to_kg, margin_pct)
select s.id, z.code, b.up_to,
       (case s.code when 'KEY' then 22 else 30 end) + z.sort * 0.5
       + case when b.up_to = 0.5 then 7 when b.up_to = 5 then 4 when b.up_to = 20 then 0 else -3 end
from public.sales_tariffs s cross join public.zones z
cross join (values (0.5), (5.0), (20.0), (null::numeric)) as b (up_to)
where s.id in ('7c000000-0000-4000-8000-000000000001', '7c000000-0000-4000-8000-000000000002')
on conflict do nothing;

insert into public.customer_tariffs (customer_id, effective_from, sales_tariff_id)
select c.id, '2026-01-01',
       case when c.account_code in ('SYD1021', 'SYD1007') then '7c000000-0000-4000-8000-000000000002'::uuid else '7c000000-0000-4000-8000-000000000001'::uuid end
from public.customers c
where c.branch_code = 'AU'
on conflict do nothing;

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
