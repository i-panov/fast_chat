# coturn in Docker

1. Copy `.env.example` to `.env` and set a long random `TURN_SECRET`.
2. Put TLS certificates into `certs/` and uncomment `cert`/`pkey` in
   `turnserver.conf`; for a public host also set `external-ip`.
3. Start it:

```sh
docker compose up -d
```

Open in the firewall/NAT:

- `3478/tcp` and `3478/udp` — STUN/TURN;
- `5349/tcp` and `5349/udp` — TURN over TLS;
- `49160-49200/udp` — relay range.

In Fast Chat, configure the same secret and the public URLs:

```yaml
ice:
    stun:
        - "stun:turn.example.com:3478"
    turn:
        - urls:
              - "turn:turn.example.com:3478?transport=udp"
              - "turn:turn.example.com:3478?transport=tcp"
              - "turns:turn.example.com:5349?transport=tcp"
          secret: "<same TURN_SECRET>"
```

`GET /api/ice` issues short-lived credentials; do not put the secret into the
public `/api/config`.
