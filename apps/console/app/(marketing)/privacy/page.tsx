import Image from "next/image";
import Link from "next/link";
import { LIGHT_SURFACE } from "../../../lib/light-surface";

export const metadata = {
  title: "Privacy Policy — Jace",
  description: "How Jace handles account, workspace, connector, and engineering data.",
};

const SUPPORT_EMAIL = "egweybensigo@gmail.com";

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-[var(--paper)]" style={LIGHT_SURFACE}>
      <header className="mx-auto flex max-w-[720px] items-center justify-between px-6 py-8">
        <Link href="/" className="flex items-center gap-2.5">
          <Image
            src="/jace-avatar.png"
            alt="Jace"
            width={32}
            height={32}
            className="rounded-full"
          />
          <span className="font-bold text-[var(--gray-13)]">Jace</span>
        </Link>
        <Link
          href="/"
          className="text-body-sm rounded-sm text-[var(--gray-11)] transition-colors hover:text-[var(--accent-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gray-13)]"
        >
          Back to home
        </Link>
      </header>

      <article className="mx-auto max-w-[720px] px-6 pb-24">
        <p className="text-label text-[var(--gray-10)]">Effective August 3, 2026</p>
        <h1 className="text-heading-2 mt-3">Privacy Policy</h1>
        <p className="mt-6 text-[var(--gray-11)]">
          This policy explains how Jace handles information when you use the
          hosted Jace service, connect a provider, or contact us for support.
          Jace is operated by Bensigo.
        </p>

        <div className="mt-12 flex flex-col gap-10 text-[var(--gray-11)]">
          <section>
            <h2 className="font-bold text-[var(--gray-13)]">Information we receive</h2>
            <ul className="mt-4 list-disc space-y-3 pl-5">
              <li>
                Account information from sign-in providers, such as your name,
                email address, provider account identifier, and avatar.
              </li>
              <li>
                Workspace information that you or your team provide, including
                repositories, tasks, approvals, connector settings, and access
                choices.
              </li>
              <li>
                Engineering evidence produced while Jace works, such as run
                status, review decisions, test results, pull-request links,
                costs, and audit events.
              </li>
              <li>
                Provider data and credentials that you explicitly authorize
                through a connector. The data available depends on the
                provider and the permissions shown during connection.
              </li>
              <li>
                Messages and contact details that you send to our support
                address.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="font-bold text-[var(--gray-13)]">How we use information</h2>
            <ul className="mt-4 list-disc space-y-3 pl-5">
              <li>To provide Jace, the console, connectors, and requested support.</li>
              <li>To execute approved engineering work and show the evidence behind it.</li>
              <li>To secure the service, prevent abuse, troubleshoot failures, and maintain reliability.</li>
              <li>To communicate with you about your account, workspace, or support request.</li>
            </ul>
          </section>

          <section>
            <h2 className="font-bold text-[var(--gray-13)]">Connected providers</h2>
            <p className="mt-4">
              When you connect a provider, Jace uses the authorization you grant
              to perform the connector&apos;s stated job. Each user authorizes
              their own provider account; Jace does not require the integration
              owner&apos;s personal access token for that user connection. You can
              revoke a provider connection through the provider or the Jace
              workspace controls where available.
            </p>
          </section>

          <section>
            <h2 className="font-bold text-[var(--gray-13)]">Sharing</h2>
            <p className="mt-4">
              We share information with connected providers when you ask Jace to
              use those providers, and with service providers that host or help
              secure the service. We do not sell personal information or use
              connected provider data for unrelated advertising.
            </p>
          </section>

          <section>
            <h2 className="font-bold text-[var(--gray-13)]">Retention and deletion</h2>
            <p className="mt-4">
              We keep information for as long as it is needed to provide the
              service, maintain security and auditability, resolve disputes, or
              meet legal obligations. To ask about access, correction, or
              deletion of information associated with your account or workspace,
              contact us at{" "}
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="underline decoration-[var(--gray-07)] underline-offset-4 hover:text-[var(--accent-text)]"
              >
                {SUPPORT_EMAIL}
              </a>
              .
            </p>
          </section>

          <section>
            <h2 className="font-bold text-[var(--gray-13)]">Security</h2>
            <p className="mt-4">
              We use reasonable technical and organizational safeguards for the
              information handled by Jace. No online service can guarantee
              absolute security, so please do not send secrets or sensitive
              information through ordinary support messages.
            </p>
          </section>

          <section>
            <h2 className="font-bold text-[var(--gray-13)]">Changes and contact</h2>
            <p className="mt-4">
              We may update this policy as Jace changes. The effective date at
              the top shows when this version was published. Questions about
              this policy can be sent to{" "}
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="underline decoration-[var(--gray-07)] underline-offset-4 hover:text-[var(--accent-text)]"
              >
                {SUPPORT_EMAIL}
              </a>
              .
            </p>
          </section>
        </div>
      </article>
    </main>
  );
}
