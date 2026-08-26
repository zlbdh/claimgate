import { ArrowRight, LockKeyhole, ScanSearch } from "lucide-react";
import Link from "next/link";

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

export default function Home() {
  return (
    <main>
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
