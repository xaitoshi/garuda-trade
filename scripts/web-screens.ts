/// <reference lib="dom" />
/**
 * Screenshots of every web page, driven through the REAL UI against the stub server (scripts/web-stub-server.ts) and
 * the Vite dev server with the dev wallet. Nothing is mocked in the browser: connect, sign in, buy, trade, revive.
 *
 *   pnpm web:screens        writes docs/screens/*.png
 *
 * Env: SCREENS_API_PORT (3111), SCREENS_WEB_PORT (5188), SCREENS_OUT (docs/screens), CHROME_PATH (system Chrome fallback).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = resolve(process.env.SCREENS_OUT ?? `${root}/docs/screens`);
const apiPort = Number(process.env.SCREENS_API_PORT ?? 3111);
const webPort = Number(process.env.SCREENS_WEB_PORT ?? 5188);
const base = `http://localhost:${webPort}`;
const api = `http://localhost:${apiPort}`;
mkdirSync(out, { recursive: true });

// playwright lives in packages/web (pnpm does not hoist it to the root)
const { chromium } = createRequire(`${root}/packages/web/package.json`)("playwright") as { chromium: any };

const procs: ChildProcess[] = [];
const run = (cmd: string, args: string[], env: Record<string, string>, cwd = root) => {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  p.stdout?.on("data", (d: Buffer) => process.env.SCREENS_VERBOSE && process.stdout.write(d));
  p.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
  procs.push(p);
  return p;
};
// detached = own process group, so the npx wrapper AND the server it started are both killed
const stop = () => procs.forEach((p) => { try { process.kill(-p.pid!, "SIGTERM"); } catch {} });
process.on("exit", stop);

async function waitFor(url: string, ms = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timed out waiting for ${url}`);
}

const post = (path: string, body: unknown) =>
  fetch(api + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => {
    const j = (await r.json()) as Record<string, unknown>;
    if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`);
    return j;
  });

run("npx", ["tsx", "scripts/web-stub-server.ts"], { PORT: String(apiPort) });
run("npx", ["vite", "--port", String(webPort), "--strictPort"], { VITE_DEV_WALLET: "1", VITE_PRIVY_PREVIEW: "1", GARUDA_API_PROXY: api, WEB_PORT: String(webPort) }, `${root}/packages/web`);
await waitFor(`${api}/health`);
await waitFor(`${base}/api/health`);

let browser;
try {
  browser = await chromium.launch();
} catch {
  const exe = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
  if (!existsSync(exe)) throw new Error("Playwright chromium is missing (npx playwright install chromium) and no system Chrome found");
  browser = await chromium.launch({ executablePath: exe });
}

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.setDefaultTimeout(15_000);
page.on("pageerror", (e: Error) => console.error("[page error]", e.message));
page.on("console", (m: { type(): string; text(): string }) => m.type() === "error" && !/favicon|Failed to load resource/.test(m.text()) && console.error("[console]", m.text()));

async function shot(name: string, o: { full?: boolean; settle?: number } = {}) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(o.settle ?? 700);
  const path = `${out}/${name}.png`;
  await page.screenshot({ path, fullPage: o.full ?? false });
  console.log(`saved ${path}`);
}
const ok = (t: string, cond: unknown) => {
  if (!cond) throw new Error(`check failed: ${t}`);
  console.log(`ok  ${t}`);
};
const go = async (path: string) => {
  await page.goto(base + path, { waitUntil: "networkidle" });
};

try {
  // ---- 00 landing (no wallet needed)
  await go("/");
  await page.getByTestId("landing").waitFor();
  await shot("00-landing", { full: true, settle: 1200 });

  // ---- sign-in screen: Privy (email or wallet) first, the wallet signature as the fallback. VITE_PRIVY_PREVIEW=1 renders
  // the Privy UI without an app id (inert buttons), so the screenshots need no keys.
  await go("/terminal");
  await page.getByTestId("privy-login").waitFor();
  ok("sign-in offers email or wallet through Privy", (await page.getByTestId("privy-login").innerText()).includes("email or wallet"));
  await shot("08-signin", { full: true });
  await page.getByTestId("connect").first().click();
  await page.getByTestId("privy-login-menu").waitFor();
  await shot("08b-signin-menu");

  // ---- connect the dev wallet and sign in through the fallback (real nonce + signMessage + verify)
  await go("/challenges");
  await page.getByTestId("connect").first().click();
  await page.locator('[data-testid^="wallet-"]').first().click();
  await page.getByTestId("wallet-pill").waitFor();
  await page.waitForFunction(() => sessionStorage.getItem("garuda.session") !== null, undefined, { timeout: 15_000 });
  const session = JSON.parse(await page.evaluate(() => sessionStorage.getItem("garuda.session")!)) as { token: string; wallet: string };
  ok("signed in with wallet signature", session.token && session.wallet);
  ok("session records the wallet-signature path", (JSON.parse(await page.evaluate(() => sessionStorage.getItem("garuda.session")!)) as { via?: string }).via === "wallet");
  const wallet = session.wallet;

  // ---- 02 challenges: Demo + 4 tiers, every tier open
  await go("/challenges");
  await page.getByTestId("tier-squire").waitFor();
  ok("ascended is open to a fresh wallet", await page.getByTestId("pick-ascended").isEnabled());
  await shot("02-challenges", { full: true });
  await page.getByTestId("challenges-menu").click();
  await page.getByTestId("challenges-dropdown").waitFor();
  await shot("09-challenges-dropdown");
  for (const [name, path] of [["09b-rules", "/challenges/rules"], ["09c-markets", "/challenges/markets"], ["09d-faq", "/challenges/faq"]] as const) {
    await go(path);
    await shot(name, { full: true, settle: 800 });
  }
  await go("/challenges");
  await page.getByTestId("tier-squire").waitFor();

  // ---- USDC checkout of a Squire through quote -> (stub) pay -> confirm -> reveal
  await page.getByTestId("pick-squire").click();
  await page.getByTestId("pay-panel").waitFor();
  await page.getByTestId("knight-name").fill("Sir Pudding");
  await page.getByTestId("agree").check({ force: true });
  await shot("02b-checkout", { full: true });
  await page.getByTestId("pay-btn").click();
  await page.getByTestId("enter-battle").waitFor({ timeout: 30_000 });
  ok("reveal shows the chosen name", (await page.getByTestId("reveal-name").innerText()).includes("Sir Pudding"));
  await shot("02c-reveal", { full: true });

  // ---- 01 terminal: enter battle, place orders through the ticket
  await page.getByTestId("enter-battle").click();
  await page.getByTestId("terminal").waitFor();
  const squireId = page.url().split("/").pop()!;
  await post("/dev/seed", { challengeId: squireId, scenario: "history" }); // closed trades for a fuller combat log
  await page.getByTestId("size").fill("12");
  await page.getByTestId("submit-order").click();
  await page.getByTestId("order-msg").waitFor();
  console.log("order:", await page.getByTestId("order-msg").innerText());
  await page.waitForTimeout(2500);
  await shot("01-terminal", { full: true, settle: 1500 });
  ok("simulated badge visible", await page.getByText("Simulated account").first().isVisible());

  // ---- 05 wounded + revive, 04 ascension (seeded for this wallet: market crash / rally through the real engine)
  const wounded = await post("/dev/seed", { wallet, scenario: "wounded" });
  const passed = await post("/dev/seed", { wallet, scenario: "passed" });
  const progress = await post("/dev/seed", { wallet, scenario: "progress" });
  ok(`seeded wounded, passed and in-progress accounts (${wounded.status}, ${passed.status}, ${progress.status})`, wounded.status === "wounded" && passed.status === "passed" && progress.status === "active");

  // ---- Path to Funded progress on the challenge dashboard
  await go(`/terminal/${progress.id}`);
  await page.getByTestId("path-to-funded").waitFor();
  ok("path to funded shows 2 of 3 trading days", (await page.getByTestId("ptf-days").innerText()).includes("2 / 3"));
  await shot("01b-path-to-funded", { full: true, settle: 1500 });

  await go("/barracks");
  await page.getByTestId("knight-card").first().waitFor();
  await shot("03-barracks", { full: true });

  await go(`/terminal/${passed.id}`);
  await page.getByTestId("ascension").waitFor();
  await shot("04-ascension", { full: true });

  await go(`/revive/${wounded.id}`);
  await page.getByTestId("revive").waitFor();
  await page.getByTestId("breach-chart").waitFor();
  await shot("05-wounded", { full: true });
  await page.getByTestId("revive-btn").click();
  await page.waitForURL(/\/terminal\//, { timeout: 30_000 });
  await page.getByTestId("terminal").waitFor();
  ok("revive via checkout lands back in the terminal", true);
  await shot("05b-revived", { full: true });

  // ---- funded account for payouts: claim on the passed knight, add a winning trade
  await go(`/terminal/${passed.id}`);
  await page.getByTestId("claim-funded").click();
  await page.getByTestId("open-funded").click(); // auto KYC and review on the stub (STUB_CLAIM=manual shows the steps)
  await page.waitForURL((u: URL) => !u.pathname.endsWith(String(passed.id)), { timeout: 15_000 });
  await page.getByTestId("terminal").waitFor();
  const fundedId = page.url().split("/").pop()!;
  await post("/dev/seed", { challengeId: fundedId, scenario: "history" });
  await page.waitForTimeout(1500);
  await shot("04b-funded-terminal", { full: true });

  await go("/leaderboard");
  await page.getByTestId("leaderboard").waitFor();
  await shot("06-leaderboard", { full: true });

  await go("/payouts");
  await page.getByTestId("payouts").waitFor();
  await page.getByTestId("owed").waitFor();
  await shot("07-payouts", { full: true });
  ok("payouts go to the signed-in wallet", (await page.getByTestId("payout-destination").getAttribute("title")) === wallet);
  ok("payout request is enabled for a funded account with profit", await page.getByTestId("request-payout").isEnabled());
  await page.getByTestId("request-payout").click();
  await page.getByTestId("payout-row").first().waitFor({ timeout: 15_000 });
  await page.getByText("Paid", { exact: true }).first().waitFor({ timeout: 15_000 });
  ok("payout request lands in the history as Paid", (await page.getByTestId("payout-row").count()) === 1);
  ok("a second request is not possible while profit is zero", await page.getByTestId("request-payout").isDisabled());
  await shot("07b-payout-paid", { full: true });

  // ---- mobile
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [name, path] of [["m-landing", "/"], ["m-challenges", "/challenges"], ["m-terminal", `/terminal/${squireId}`]] as const) {
    await go(path);
    await shot(name, { full: true, settle: 1000 });
  }
  console.log(`\nDone: ${out}`);
} catch (e) {
  await page.screenshot({ path: `${out}/_failure.png`, fullPage: true }).catch(() => {});
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
  stop();
}
