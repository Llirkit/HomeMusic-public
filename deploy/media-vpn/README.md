# Media VPN for HomeMusic

This overlay replaces `deploy/youtube-zapret/compose.yaml`. Hub's YouTube and SoundCloud providers and the
YouTube PO-token service use a private HTTP proxy backed by Xray/Hysteria. The VPN parameters are copied from
the operator's existing Telegram VPN configuration; Telegram retains its separate client and configuration.
The app, Navidrome, Ollama, embedder and unrelated providers keep their normal routes.

On the LXC, install the operator's verified Xray binary at `/etc/homemusic-vpn/xray` (root, mode 0700), and the
generated private configuration at `/etc/homemusic-vpn/config.json` (root, mode 0600). Keep the directory 0700.
Do not commit the source VPN configuration, generated configuration or subscription URL.
The currently deployed binary is the same verified Xray 26.11.9 binary used by the Telegram monitor.

The configuration can be generated on the machine holding the existing VPN credentials:

```sh
python3 deploy/media-vpn/make_config.py --source /private/telegram-vpn.json --output /private/media-vpn.json
```

The proxy publishes no ports and needs no network capabilities or host networking. It accepts only the media
domains and Google challenge endpoints listed in `make_config.py`; other destinations are blocked. There is
no direct fallback through this proxy. The list is also enforced when a YouTube redirect changes domains.

Before switching, start `media-vpn` and check an actual YouTube download. Then stop/remove the two zapret
services using the old compose invocation so their namespace firewall rules are cleaned up. Change the
deployment wrapper and systemd unit to combine your server file, this overlay and any embedder overlay.
Recreate Hub and the PO-token service so both adopt the VPN, and validate a full download from each source.
Update monitoring to expect `media-vpn` instead of the zapret services.

```sh
docker compose -f compose.server.yaml -f deploy/media-vpn/compose.yaml \
  -f deploy/embedder-cpu/compose.yaml up -d media-vpn youtube-pot hub
```

Proxy health checks verify its listener; test real media transfer to verify the VPN path. VPN availability,
YouTube account checks and DRM restrictions can still prevent individual downloads.
