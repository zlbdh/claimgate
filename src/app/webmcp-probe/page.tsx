import { ArrowLeft, RadioTower } from "lucide-react";
import Link from "next/link";

import { ProbeClient } from "./probe-client";

export default function WebMCPProbePage() {
  return (
    <main className="probe-page">
      <Link className="back-link" href="/">
        <ArrowLeft aria-hidden="true" size={16} />
        Return to ClaimGate desk
      </Link>

      <section className="probe-panel" aria-labelledby="probe-title">
        <div className="probe-heading">
          <span className="probe-icon" aria-hidden="true">
            <RadioTower size={28} strokeWidth={1.45} />
          </span>
          <div>
            <p className="eyebrow">Day 1 stop-loss gate</p>
            <h1 id="probe-title">Compatibility desk</h1>
          </div>
        </div>

        <p className="probe-intro">
          This isolated desk exposes one read-only tool. It reads no claim data and
          changes no product state.
        </p>

        <ProbeClient />

        <dl className="probe-ledger">
          <div>
            <dt>Tool</dt>
            <dd>claimgate_compatibility_probe</dd>
          </div>
          <div>
            <dt>Native API</dt>
            <dd>document.modelContext</dd>
          </div>
          <div>
            <dt>Lifecycle</dt>
            <dd>AbortSignal-owned registration</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
