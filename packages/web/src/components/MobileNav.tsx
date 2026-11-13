import { NavLink } from "react-router-dom";

/** Phone navigation: an app-style tab bar fixed to the bottom of the screen. Hidden above 820px (the top nav is used). */
const I = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const ITEMS = [
  ["/terminal", "Terminal", <svg {...I} key="t"><path d="M6 3v18M12 3v18M18 3v18" strokeOpacity=".35" /><rect x="4" y="7" width="4" height="8" rx="1" /><rect x="10" y="10" width="4" height="7" rx="1" /><rect x="16" y="5" width="4" height="9" rx="1" /></svg>],
  ["/challenges", "Challenges", <svg {...I} key="c"><path d="M5 21V4" /><path d="M5 4h12l-2.5 4L17 12H5" /></svg>],
  ["/barracks", "Barracks", <svg {...I} key="b"><path d="M12 3 4.5 6v6c0 4.4 3.2 7.8 7.5 9 4.3-1.2 7.5-4.6 7.5-9V6Z" /><path d="M9 11h6M12 8v7" /></svg>],
  ["/leaderboard", "Ranks", <svg {...I} key="l"><path d="M9 21V9h6v12M3 21v-7h6M15 21v-9h6v9M2 21h20" /></svg>],
  ["/payouts", "Payouts", <svg {...I} key="p"><circle cx="12" cy="12" r="8.5" /><path d="M14.8 9.2c-.6-.8-1.6-1.2-2.8-1.2-1.6 0-2.8.8-2.8 2s1.2 1.7 2.8 2 2.8.8 2.8 2-1.2 2-2.8 2c-1.2 0-2.3-.4-2.9-1.3M12 6.5V8M12 16v1.5" /></svg>],
] as const;

export function MobileNav() {
  return (
    <nav className="mnav" aria-label="Main">
      {ITEMS.map(([to, label, icon]) => (
        <NavLink key={to} to={to} className={({ isActive }) => (isActive ? "on" : "")}>
          {icon}
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
