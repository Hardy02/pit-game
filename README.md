# PIT — Multiplayer PvP Arena

A fast, momentum-driven browser deathmatch. Free-for-all combat with chainable
movement (slide / wall-run / double-jump), melee + ranged attacks, and a
lightsaber power-up you earn from a quick kill streak. Players battle across 5
rotating maps. Built with HTML5 Canvas and a zero-dependency Node WebSocket
server.

## Run locally

Requires [Node.js](https://nodejs.org) 18+.

```bash
node server.js
```

Then open <http://localhost:3000>. Open multiple tabs (or have others on your
LAN visit `http://<your-ip>:3000`) to play together.

On Windows you can just double-click **`Play PIT.bat`**, which starts the server
and opens your browser automatically.

## Controls

| Action | Key |
| --- | --- |
| Move | `A` / `D` |
| Jump / double-jump | `W` (or `Space`) |
| Slide | `S` or `Shift` |
| Wall-run | hold toward a wall while airborne |
| Melee | left click (aim with cursor) |
| Shoot | right click |

String together **5 quick kills** to earn a lightsaber that one-shots anyone it
touches.

## Deploy online

The server reads `process.env.PORT` and the client auto-upgrades to `wss://`
over HTTPS, so it deploys as-is to any host that runs a persistent Node process
with WebSocket support — e.g. **Railway**, **Render**, or **Fly.io**.

Keep it to a **single instance**: rooms are held in memory, so all players must
connect to the same process.

## Files

- `server.js` — game server: matchmaking/rooms, map rotation, kill adjudication.
- `index.html` — the client (movement, combat, rendering, networking).
- `pit.html` — the original single-player prototype (kept for reference).
- `Play PIT.bat` / `Allow PIT on LAN.bat` — Windows helpers for local/LAN play.
