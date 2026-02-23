export default async function RuntimePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <main className="container">
      <div className="card">
        <h1>OpenClaw Runtime Endpoint</h1>
        <p className="muted">
          This placeholder route represents the user runtime URL for deployment <code>{id}</code>.
        </p>
      </div>
    </main>
  );
}
