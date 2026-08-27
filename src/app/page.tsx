import { ArrowRight, LockKeyhole, ScanSearch } from "lucide-react";
import { cookies } from "next/headers";
import Link from "next/link";
import { DemoRoleBar } from "@/components/demo-role-bar";
import { DEMO_SESSION_COOKIE } from "@/features/auth/demo-session";
import { readHomeSession } from "@/server/http/home-session";

const principles = [
  {
    index: "01",
    title: "Agent-assisted search",
    detail: "Structured help turns a loss description into a focused desk search.",
    icon: ScanSearch,
  },
  {
    index: "02",
    title: "Human verification",
    detail: "Sensitive evidence and final release remain deliberate human actions.",
    icon: LockKeyhole,
  },
];

export const dynamic = "force-dynamic";

export default async function Home() {
  const cookieStore = await cookies();
  const authenticated = readHomeSession(cookieStore.get(DEMO_SESSION_COOKIE)?.value);
  return (
    <main>
      {authenticated ? (
        <>
          <DemoRoleBar
            role={authenticated.session.role}
            expiresAt={authenticated.session.expiresAt}
            csrfToken={authenticated.csrfToken}
          />
          {authenticated.session.role === "CLAIMANT" && (
            <p><Link className="primary-link" href="/claimant">Open Claimant report desk</Link></p>
          )}
          {authenticated.session.role === "STAFF" && (
            <p><Link className="primary-link" href="/staff">Open Staff review desk</Link></p>
          )}
        </>
      ) : (
        <section className="start-demo" aria-labelledby="start-demo-title">
          <p className="eyebrow">Two-hour isolated public demo</p>
          <h2 id="start-demo-title">Start with a fresh Claimant workspace.</h2>
          <p>Each session receives a separate demo inventory and expires automatically.</p>
          <form className="start-demo-form" action="/api/demo/start" method="post">
            <button type="submit">Start public demo</button>
          </form>
        </section>
      )}
      <section className="hero" aria-labelledby="home-title">
        <p className="eyebrow">Lost property · privacy-first claims</p>
        <h1 id="home-title">Find the match without giving away the answer.</h1>
        <p className="hero-copy">
          ClaimGate gives campus property desks a careful handoff between people,
          deterministic checks, and browser Agents.
        </p>
        <div className="hero-action">
          <Link className="primary-link" href="/webmcp-probe">
            Open compatibility desk
            <ArrowRight aria-hidden="true" size={17} strokeWidth={1.8} />
          </Link>
          <span className="ticket-note">Baseline ticket · CG-0826</span>
        </div>
      </section>

      <section className="principles" aria-label="ClaimGate operating principles">
        {principles.map(({ index, title, detail, icon: Icon }) => (
          <article className="principle" key={index}>
            <span className="principle-index">{index}</span>
            <Icon aria-hidden="true" size={24} strokeWidth={1.45} />
            <div>
              <h2>{title}</h2>
              <p>{detail}</p>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
