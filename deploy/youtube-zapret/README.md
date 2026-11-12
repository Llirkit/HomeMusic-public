# YouTube and SoundCloud zapret2 for HomeMusic

Optional deployment overlay for Linux Docker inside LXC 108. It builds upstream zapret2 at
`c08c412dd8b39a456ef42b42530b150f6f02f7e2`; it does not run upstream firewall/install scripts.

Two small services share the network namespaces of `hub` and `youtube-pot`, respectively. They have no
published ports, no host networking and no privileged mode. The other services retain their own namespaces.
The LXC remains unprivileged. The Proxmox kernel needs `nfnetlink_queue`, `xt_NFQUEUE` and `xt_connbytes`;
load these modules on the host if unavailable, without installing firewall rules on the host.

Only the beginning of outbound TCP/443 connections is queued. Private/local destinations are excluded.
nfqws2 changes TLS ClientHello packets only for the domains in `hosts.txt`, including their subdomains.
The list covers YouTube/Googlevideo and SoundCloud/Sndcdn; the directory and service names are retained for compatibility.
Other HTTPS traffic passes unchanged. This deployment covers yt-dlp's HTTPS/TCP traffic; it does not
intercept browser QUIC/UDP traffic or change DNS, default routes or public IP addresses.

## Start and update

From the repository root, combine this overlay with your existing deployment file:

```sh
docker compose -f compose.server.yaml -f deploy/youtube-zapret/compose.yaml up -d --build
```

Always use both files when updating/recreating Hub or the PO-token service so their helpers join the new
network namespaces. On the configured server, `homemusic-compose` is a wrapper for this full command prefix,
and the `homemusic` systemd unit reconciles it at boot.

The tested strategies are `ZAPRET_TLS_STRATEGY=disorder` for Hub and
`ZAPRET_POT_TLS_STRATEGY=fake-disorder` for the PO-token service. Set these in `.env` if explicit pinning is desired.
Available profiles are `split`, `disorder`, `fake-split`, `fake-disorder`; success depends on the ISP.
Recreate the affected helper after changing a profile. No external proxy or VPN is used.

## Check and stop

```sh
docker compose -f compose.server.yaml -f deploy/youtube-zapret/compose.yaml ps
docker compose -f compose.server.yaml -f deploy/youtube-zapret/compose.yaml logs --tail 30 youtube-zapret youtube-pot-zapret
docker compose -f compose.server.yaml -f deploy/youtube-zapret/compose.yaml stop youtube-zapret youtube-pot-zapret
```

Stopping removes only `HM_YOUTUBE_ZAPRET` from those two namespaces. Queue bypass preserves direct connectivity
if a helper exits unexpectedly. A later full `up` enables the helpers again. For a permanent rollback, stop
both helpers and use your original compose file alone to recreate Hub and `youtube-pot`.
Back up the deployment files before enabling the overlay. Do not use `iptables-restore` across all tables to
roll back: Docker manages unrelated rules that must be preserved.

Validate with a real yt-dlp audio request, not just the YouTube landing page. PO tokens, sign-in checks,
regional restrictions and removal of individual videos can still cause separate failures.
