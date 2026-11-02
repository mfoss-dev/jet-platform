import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BILLING_EDITORS } from '@/lib/format';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { AddOns } from './AddOns';
import { FuelTab } from './FuelTab';
import { PriceCheck } from './PriceCheck';
import { RateCards } from './RateCards';
import { SalesTariffs } from './SalesTariffs';
import { Standardise } from './Standardise';

const TABS = [['fuel', 'Fuel surcharge'], ['addons', 'Add-ons'], ['rates', 'Rate cards'], ['sales', 'Sales tariffs'], ['standardise', 'Standardise pricing'], ['price', 'Price check']] as const;

const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

export default async function Tariffs({ searchParams }: PageProps<'/stream/tariffs'>) {
  const me = await getMe();
  if (!me.apps.includes('stream')) notFound();
  const sp = await searchParams;
  const tab = (TABS.some(([t]) => t === sp.tab) ? sp.tab : 'fuel') as (typeof TABS)[number][0];
  const msg = pick(sp.msg);
  const canEdit = BILLING_EDITORS.includes(me.role);
  const canPublish = ['owner', 'management', 'admin'].includes(me.role);
  const supabase = await createClient();

  return (
    <>
      <div className="top">
        <div><h1>Tariffs &amp; fuel</h1><div className="sub">Rates managed in-house · every change has a start date and goes to the audit log</div></div>
      </div>
      <div className="tabs">
        {TABS.map(([t, label]) => (
          <Link key={t} href={{ pathname: '/stream/tariffs', query: { tab: t } }} scroll={false}><span className={t === tab ? 'on' : ''}>{label}</span></Link>
        ))}
      </div>
      {msg && <div className={`banner ${/^(Not |No |Choose|Give)|must/.test(msg) ? 'warn' : ''}`} role="status">{msg}</div>}
      {tab === 'fuel' && <FuelTab supabase={supabase} canEdit={canEdit} />}
      {tab === 'addons' && <AddOns supabase={supabase} canEdit={canEdit} addonId={pick(sp.addon)} q={pick(sp.q)} branch={pick(sp.branch)} service={pick(sp.service)} who={pick(sp.who)} when={pick(sp.when)} />}
      {tab === 'rates' && <RateCards supabase={supabase} canEdit={canEdit} canPublish={canPublish} tariffId={pick(sp.tariff)} versionId={pick(sp.version)} zq={pick(sp.zq)} page={Number(pick(sp.page)) || 0} />}
      {tab === 'sales' && <SalesTariffs supabase={supabase} canEdit={canEdit} salesId={pick(sp.sales)} q={pick(sp.q)} branch={pick(sp.branch)} service={pick(sp.service)} zq={pick(sp.zq)} page={Number(pick(sp.page)) || 0} />}
      {tab === 'standardise' && <Standardise supabase={supabase} canEdit={canEdit} branch={pick(sp.branch)} service={pick(sp.service)} show={pick(sp.show)} from={pick(sp.from)} to={pick(sp.to)} />}
      {tab === 'price' && <PriceCheck supabase={supabase} params={{
        customer: pick(sp.customer), service: pick(sp.service), ocountry: pick(sp.ocountry), opost: pick(sp.opost), dcountry: pick(sp.dcountry), dpost: pick(sp.dpost),
        kind: pick(sp.kind), weight: pick(sp.weight), l: pick(sp.l), w: pick(sp.w), h: pick(sp.h), date: pick(sp.date), zone: pick(sp.zone),
        insured: pick(sp.insured), declared: pick(sp.declared), priority: pick(sp.priority), dtp: pick(sp.dtp),
      }} />}
    </>
  );
}
