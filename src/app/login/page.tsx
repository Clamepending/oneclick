import { signIn } from "@/lib/auth";

type LoginPageSearchParams = Promise<{ callbackUrl?: string }>;

export default async function LoginPage({ searchParams }: { searchParams: LoginPageSearchParams }) {
  const resolvedSearchParams = await searchParams;
  const callbackUrl =
    typeof resolvedSearchParams.callbackUrl === "string" && resolvedSearchParams.callbackUrl.trim()
      ? resolvedSearchParams.callbackUrl.trim()
      : "/";

  return (
    <main className="container">
      <div className="card">
        <h1>Sign in</h1>
        <p className="muted">Use Google to start your one-click deployment.</p>
        <form
          action={async (formData) => {
            "use server";
            const rawCallbackUrl = formData.get("callbackUrl");
            const redirectTo =
              typeof rawCallbackUrl === "string" && rawCallbackUrl.trim()
                ? rawCallbackUrl.trim()
                : "/";
            await signIn("google", { redirectTo });
          }}
        >
          <input type="hidden" name="callbackUrl" value={callbackUrl} />
          <button className="button" type="submit">
            Continue with Google
          </button>
        </form>
      </div>
    </main>
  );
}
