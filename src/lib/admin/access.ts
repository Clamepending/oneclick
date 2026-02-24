export function isAdminEmail(email: string) {
  const raw = process.env.ADMIN_EMAILS?.trim();
  if (!raw) {
    // Bare-bones default for single-user prototypes.
    return true;
  }

  const allow = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  return allow.includes(email.trim().toLowerCase());
}
