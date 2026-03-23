# Core NFT Viewer (coredrop)

Read-only gallery for **curated** NFT collections on Core Blockchain.  
Designed to run on the **same VPS** as [dex.coredrop.fun](https://dex.coredrop.fun): static UI + RPC proxy via **gocore IPC** (same approach as the DEX — no HTTP port needed on gocore).

## Features (MVP)

- Home page lists collections from `public/collections.json`
- Collection page loads `name` / `symbol` / `totalSupply` (if present) and `tokenURI` per token, then resolves **IPFS** `ipfs://` → `https://ipfs.io/ipfs/...`
- No wallet required; no transactions

## Setup

```bash
cd nft-viewer
cp .env.example .env
# Set GOCORE_DATADIR (same as gocore on this machine) — IPC, no HTTP needed
npm start
```

Open http://127.0.0.1:3470

### Connecting to gocore (IPC — same as the DEX)

The viewer server proxies browser `eth_call` requests to **gocore via IPC** (`gocore attach --exec`), exactly like the DEX GUI. **No HTTP port** on gocore is needed.

Set **`GOCORE_DATADIR`** in `.env` to the same datadir as your gocore service (e.g. `/root/core-mainnet-node`). The server finds the IPC socket automatically.

**Fallback:** If gocore is on a different machine (no local IPC), set `CORE_RPC_URL` to the HTTP JSON-RPC URL instead.

## Configure collections

Edit `public/collections.json`:

- `contractAddress` — full Core **cb…** address
- `tokenIdStart` — usually `1`
- `tokenIdEnd` — fallback last id if `totalSupply()` is missing or fails
- `tryTotalSupply` — if `true`, uses `totalSupply()` to compute the id range (`start` … `start + totalSupply - 1`)
- `maxTokens` — safety cap for how many NFTs to load (default **2000**). Raise for large collections (e.g. Core Cats 1000).
- `loadParallel` — concurrent `eth_call` loads (default **2**) so gocore IPC is not overwhelmed

## Same VPS as DEX (Nginx + PM2)

1. **DNS** — A record: `nftviewer` → same IP as `dex.coredrop.fun`

2. **Environment** — set `GOCORE_DATADIR` (same as DEX/gocore service). `CORE_RPC_URL` not needed when IPC works.

3. **PM2** (example port `3470`):

   ```bash
   cd ~/CoreBlockchain-NFTViewer
   cp .env.example .env
   nano .env   # set GOCORE_DATADIR to your gocore datadir
   pm2 start server.js --name nft-viewer
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

- `/api/rpc` only allows `eth_call`, `eth_chainId`, `eth_blockNumber` + a few read methods (no sends)
- Serve behind HTTPS in production

## Limits

- Very large collections: raise `maxTokens` in `collections.json` or narrow the id range; default cap is 2000
- Non-standard contracts (no `totalSupply`, weird `tokenURI`) may need per-collection tweaks

## Metadata / images not loading

The viewer resolves `tokenURI` (or `uri()` fallback), then JSON metadata. It supports **HTTP(S)**, **`ipfs://`**, **`data:application/json;base64,...`**, and **hex-encoded UTF-8** `tokenURI` returns. IPFS JSON is tried on several **public gateways**. If thumbnails still fail, open the browser **developer console** (F12) — warnings log per token id.

## `/api/rpc` returns 500

- Check `GOCORE_DATADIR` in `.env` — must match the running gocore datadir so the IPC socket is found.
- On the VPS: `curl http://127.0.0.1:3470/api/health` should show `"ipc": true`.
- Lower **`loadParallel`** in `collections.json` if gocore is slow (default **2**).
