import { Link } from "react-router-dom";
import { useSession } from "../lib/session";

export function Footer() {
  const { health, offline } = useSession();
  return (
    <footer className="foot mono">
      <span>
        Garuda runs simulated accounts against the live Phoenix orderbook. Nothing here is financial advice.
      </span>
      <span className="foot-r">
        {offline ? "API offline" : health ? `data: ${health.marketData}${health.marketDataReachable ? "" : " (unreachable)"}` : "connecting..."}
        <Link to="/calledit">Called It</Link>
        <Link to="/leaderboard">Leaderboard</Link>
      </span>
    </footer>
  );
}
