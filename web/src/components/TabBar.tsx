import { EMBEDDED } from '../lib/embedded';
import { Link } from '../lib/router';
import { useActiveDownloads } from '../lib/notify';
import { Icon, type IconName } from './Icon';
import { cx } from './ui';

export type Tab = 'home' | 'search' | 'downloads' | 'library' | 'assistant' | 'more';

/** Only a plain browser draws it (inside the app the app's tabs open the routes): the whole service, «Главная»
 * first, the assistant under «Ещё». */
const TABS: Array<{ id: Tab; to: string; label: string; icon: IconName }> = [
  { id: 'home', to: '/home', label: 'Главная', icon: 'home' },
  { id: 'search', to: '/search', label: 'Поиск', icon: 'search' },
  { id: 'library', to: '/library', label: 'Библиотека', icon: 'library' },
  { id: 'downloads', to: '/downloads', label: 'Загрузки', icon: 'download' },
  { id: 'more', to: '/more', label: 'Ещё', icon: 'more' },
];

/** The tab a route's own tab shows under: the assistant lives in «Ещё» of a browser. */
const shownTab = (t: Tab | null): Tab | null => (t && !TABS.some((x) => x.id === t) ? 'more' : t);

export function TabBar({ active: routeTab, last }: { active: Tab | null; last: Partial<Record<Tab, string>> }) {
  const activeDownloads = useActiveDownloads();
  if (EMBEDDED) return null; // the Android app shows its own navigation
  const active = shownTab(routeTab);

  return (
    <nav className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-[#0b0b0b]/95 backdrop-blur lg:inset-y-0 lg:right-auto lg:w-60 lg:border-r lg:border-t-0 lg:px-3 lg:py-6" aria-label="Разделы">
      <div className="mb-7 hidden items-center gap-3 px-3 lg:flex">
        <img src="/icons/icon.svg" alt="" width={36} height={36} className="rounded-lg" />
        <span className="text-lg font-bold tracking-tight">HomeMusic</span>
      </div>
      <ul className="mx-auto flex max-w-2xl lg:flex-col lg:gap-1">
        {TABS.map((t) => {
          const on = active === t.id;
          return (
            <li key={t.id} className="flex-1 lg:flex-none">
              <Link
                to={on ? t.to : (last[t.id] ?? t.to)}
                aria-current={on ? 'page' : undefined}
                className={cx(
                  'relative flex h-16 flex-col items-center justify-center gap-1 rounded-lg text-[11px] transition-colors active:bg-hover lg:h-12 lg:flex-row lg:justify-start lg:gap-3 lg:px-3 lg:text-sm',
                  on ? 'text-fg lg:bg-raised' : 'text-dim hover:bg-fg/5 hover:text-fg',
                )}
              >
                <span className="relative">
                  <Icon name={t.icon} size={24} stroke={on ? 2.4 : 2} />
                  {t.id === 'downloads' && activeDownloads > 0 && (
                    <span className="absolute -right-2.5 -top-1.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-bold leading-4 text-on-accent">
                      {activeDownloads > 99 ? '99+' : activeDownloads}
                    </span>
                  )}
                </span>
                <span className={on ? 'font-semibold' : ''}>{t.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
