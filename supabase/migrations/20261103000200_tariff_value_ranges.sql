-- Jet's real tariffs (JetStream import) use values the first model ruled out, and pricing must match JetStream:
--   * TNT domestic express has a few negative basic charges (per kg, less a fixed amount)
--   * 72 sales tariffs (mostly domestic express tariffs on JetTrack's low base rates) have margins from -160% to +3,515%
alter table public.tariff_rates drop constraint tariff_rates_basic_check;
alter table public.sales_margins drop constraint sales_margins_margin_pct_check;
alter table public.sales_margins add constraint sales_margins_margin_pct_check check (margin_pct between -1000 and 100000);
