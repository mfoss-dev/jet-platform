-- JetStream uses steps of 10,000 kg and more on some flat rows (one step covering the whole break), and 999,999 kg
-- for "and over". Widen the weight columns so every imported row fits.
alter table public.tariff_rates
  alter column step_kg type numeric(12, 3),
  alter column from_kg type numeric(12, 3),
  alter column to_kg type numeric(12, 3);
alter table public.sales_margins alter column to_kg type numeric(12, 3);
