import Link from "next/link";
import { auth } from "@/lib/auth";

export default async function HomePage() {
  const session = await auth();

  return (
    <main className="container">
      <div className="card">
        <h1>OneClick OpenClaw</h1>
        <p className="muted">
          Sign in, complete three quick steps, and launch your OpenClaw deployment.
        </p>
        {!session?.user ? (
          <Link className="button" href="/login">
            Continue with Google
          </Link>
        ) : (
          <div className="row">
            <Link className="button" href="/onboarding">
              Continue setup
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
