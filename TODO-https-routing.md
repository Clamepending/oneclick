# TODO: Production HTTPS Routing for User Containers

## Goal

Serve each user runtime at a stable HTTPS URL:

- `https://<user-slug>.oneclickagent.net`

while keeping Vercel as control plane (`oneclickopenclaw.vercel.app`).

## 1) DNS and Network Prerequisites

- [ ] Confirm domain is active: `oneclickagent.net`
- [ ] Add DNS A record: `oneclickagent.net -> <droplet-ip>`
- [ ] Add DNS wildcard A record: `*.oneclickagent.net -> <droplet-ip>`
- [ ] Open droplet firewall inbound ports:
  - [ ] `80/tcp`
  - [ ] `443/tcp`
  - [ ] `22/tcp` (SSH; restrict later)

## 2) Reverse Proxy on Droplet (HTTPS)

- [ ] Install reverse proxy (Caddy or Traefik) on droplet
- [ ] Configure automatic TLS for `*.oneclickagent.net`
- [ ] Configure routing by host header to user containers
- [ ] Ensure proxy restarts on reboot (systemd or docker restart policy)

## 3) Runtime Deployment Changes

- [ ] Generate stable per-user slug (safe DNS format)
- [ ] Assign runtime host:
  - [ ] preferred: private/internal port + proxy routing
  - [ ] avoid exposing random high public ports long-term
- [ ] Update deploy flow to register route:
  - [ ] `slug.oneclickagent.net -> target container`
- [ ] Update replace flow to remove old route when runtime is destroyed

## 4) App and DB Changes

- [ ] Add deployment fields (if needed):
  - [ ] `subdomain`
  - [ ] proxy route metadata
- [ ] Set `readyUrl` to HTTPS domain URL
- [ ] Show domain URL in deployment dashboard and admin page

## 5) Security Hardening

- [ ] Turn off insecure control UI mode after HTTPS is live
  - [ ] `OPENCLAW_ALLOW_INSECURE_CONTROL_UI=false`
- [ ] Restrict SSH firewall rule (`22`) to trusted IP/VPN
- [ ] Keep only `80/443` publicly exposed for runtimes

## 6) Validation Checklist

- [ ] New deployment returns URL like `https://alice.oneclickagent.net`
- [ ] URL loads OpenClaw without secure-context errors
- [ ] Redeploy for same user replaces old runtime and URL remains stable
- [ ] Different users get different subdomains and isolated runtimes
- [ ] No direct `:20xxx` port access required publicly

## 7) Cleanup After Migration

- [ ] Remove old IP:port ready URL assumptions from docs/UI
- [ ] Remove no-longer-needed public high-port firewall rules
- [ ] Update README with final architecture and ops notes

