import Link from "next/link";
import Image from "next/image";

export function TopNav() {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link href="/" className="topbar-brand">
          <Image
            src="/oneclicklogo.png"
            alt="OneClick"
            width={32}
            height={32}
            className="topbar-brand-logo"
            priority
          />
          <span>OneClick</span>
        </Link>
        <Link href="/" className="button secondary">
          Home
        </Link>
      </div>
    </header>
  );
}
