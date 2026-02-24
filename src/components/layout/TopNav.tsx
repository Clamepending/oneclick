import Link from "next/link";

export function TopNav() {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link href="/" className="topbar-brand">
          OneClick
        </Link>
        <Link href="/" className="button secondary">
          Home
        </Link>
      </div>
    </header>
  );
}
