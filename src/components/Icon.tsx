import type { IconName } from '@/lib/nav';

const PATHS: Record<IconName, string> = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z', list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  monitor: 'M3 4h18v12H3zM8 20h8M12 16v4', scale: 'M12 3v18M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0z',
  inbox: 'M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5', claim: 'M9 14l-4-4 4-4M5 10h11a4 4 0 0 1 0 8h-1', play: 'M6 4l14 8-14 8z',
  doc: 'M6 2h9l5 5v15H6zM14 2v6h6', export: 'M12 3v12M7 8l5-5 5 5M4 15v5h16v-5', users: 'M16 21v-2a4 4 0 0 0-8 0v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  user: 'M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  fuel: 'M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h12M14 9h2a2 2 0 0 1 2 2v6a1.5 1.5 0 0 0 3 0V8l-3-3M4 10h10',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  chevL: 'M15 18l-6-6 6-6', chevD: 'M6 9l6 6 6-6', menu: 'M4 6h16M4 12h16M4 18h16', x: 'M6 6l12 12M18 6L6 18',
  box: 'M21 8l-9-5-9 5 9 5zM3 8v8l9 5 9-5V8M12 13v8', chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2', spark: 'M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z',
  plus: 'M12 5v14M5 12h14', pin: 'M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11zM12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  truck: 'M1 7h13v10H1zM14 10h4l3 3v4h-7M5.5 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM17.5 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  dollar: 'M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6', chat: 'M21 12a8 8 0 0 1-12 7l-6 2 2-6A8 8 0 1 1 21 12z',
  check: 'M4 12l5 5L20 6', mail: 'M3 5h18v14H3zM3 6l9 7 9-7', book: 'M4 4h12a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3zM4 17a3 3 0 0 1 3-3h12',
  pulse: 'M3 12h4l3-8 4 16 3-8h4', plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12h2M3 12h2M12 3v2M12 19v2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4',
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
