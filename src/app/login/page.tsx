import { signIn } from "@/lib/auth";

export default function LoginPage() {
  return (
    <main className="container">
      <div className="card">
        <h1>Sign in</h1>
        <p className="muted">Use Google to start your one-click deployment.</p>
        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/" });
          }}
        >
          <button className="button" type="submit">
            Continue with Google
          </button>
        </form>
      </div>
    </main>
  );
}
