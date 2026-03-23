# Core NFT Viewer (coredrop)

Read-only gallery for **curated** NFT collections on Core Blockchain.  
Designed to run on the **same VPS** as [dex.coredrop.fun](https://dex.coredrop.fun): static UI + JSON-RPC proxy (browsers cannot call the chain RPC directly due to CORS).

## Features (MVP)

- Home page lists collections from `public/collections.json`
- Collection page loads `name` / `symbol` / `totalSupply` (if present) and `tokenURI` per token, then resolves **IPFS** `ipfs://` → `https://ipfs.io/ipfs/...`
- No wallet required; no transactions

## Setup

```bash
cd nft-viewer
cp .env.example .env
# Edit .env: CORE_RPC_URL must point at gocore JSON-RPC (HTTP), not IPC
npm start
```

Open http://127.0.0.1:3470

### `CORE_RPC_URL` vs DEX (gocore)

| App | Connection |
|-----|------------|
| **dOckie DEX GUI** (`my-memecoin`) | Usually **IPC** to gocore on the VPS — `CORE_RPC_URL` can be **empty** there. |
| **This NFT viewer** | **HTTP JSON-RPC only** (`eth_call`). Browsers cannot use IPC; `/api/rpc` proxies to `CORE_RPC_URL`. |

So you do **not** copy “empty `CORE_RPC_URL`” from the DEX. You must expose JSON-RPC, typically:

- **Same VPS as DEX:** start gocore with **`--http --http.addr 127.0.0.1 --http.port 9545`** (localhost only), then set `CORE_RPC_URL=http://127.0.0.1:9545` for this service. See **`my-memecoin/docs/DEPLOY_VPS.md`** (section *NFT Viewer*).
- **Tunnel:** ngrok/cloudflared to your gocore HTTP port (same idea as Railway in `gui/README.md`).

## Configure collections

Edit `public/collections.json`:

- `contractAddress` — full Core **cb…** address (replace placeholder for [Core Cats](https://core-cats-mint.vercel.app/mint) when you have it)
- `tokenIdStart` — usually `1`
- `tokenIdEnd` — fallback last id if `totalSupply()` is missing or fails
- `tryTotalSupply` — if `true`, uses `totalSupply()` to compute the id range (`start` … `start + totalSupply - 1`)
- `maxTokens` — safety cap for how many NFTs to load (default **2000**). Raise for large collections (e.g. Core Cats 1000).
- `loadParallel` — concurrent metadata loads (default **8**) to avoid overloading the RPC

## Same VPS as DEX (Nginx + PM2)

1. **DNS** — A record: `nftviewer` → same IP as `dex.coredrop.fun`

2. **Environment** — reuse the same `CORE_RPC_URL` as the DEX `.env` (gocore HTTP on the VPS or tunnel).

3. **PM2** (example port `3470`):

   ```bash
   cd /path/to/nft-viewer
   NFT_VIEWER_PORT=3470 CORE_RPC_URL='http://127.0.0.1:9545' pm2 start server.js --name nft-viewer
   pm2 save
   ```

4. **Nginx** — new `server_name` (TLS with certbot):

   ```nginx
   server {
     listen 443 ssl;
     server_name nftviewer.coredrop.fun;
     # ssl_certificate ... (certbot)

     location / {
       proxy_pass http://127.0.0.1:3470;
       proxy_http_version 1.1;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
     }
   }
   ```

   ```bash
   sudo certbot --nginx -d nftviewer.coredrop.fun
   ```

## Security

- `/api/rpc` only allows `eth_call`, `eth_chainId`, `eth_blockNumber` (no sends)
- Serve behind HTTPS in production

## Limits

- Very large collections: raise `maxTokens` in `collections.json` or narrow the id range; default cap is 2000
- Non-standard contracts (no `totalSupply`, weird `tokenURI`) may need per-collection tweaks
