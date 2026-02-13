# Fly ZK Verification: 5 Exact Steps

Use this after generating `vk` in WSL at:

- `D:\Veilstar Brawl\zk_circuits\veilstar_round_plan\target\vk`

## 1) Redeploy ZK service (includes bb in image)

Run from repo root:

```powershell
Set-Location "D:\Veilstar Brawl"
fly deploy --config fly.zk.toml --app veilstar-brawl-zk
```

## 2) Upload verification key to Fly

```powershell
$vk = [Convert]::ToBase64String([IO.File]::ReadAllBytes("D:\Veilstar Brawl\zk_circuits\veilstar_round_plan\target\vk"))
fly secrets set ZK_VK_BASE64=$vk --app veilstar-brawl-zk
```

## 3) Enable verification

```powershell
fly secrets set ZK_VERIFY_ENABLED=true --app veilstar-brawl-zk
```

## 4) Set explicit verify command (optional but recommended)

```powershell
fly secrets set ZK_VERIFY_CMD="bb verify -k {VK_PATH} -p {PROOF_PATH} -i {PUBLIC_INPUTS_PATH}" --app veilstar-brawl-zk
```

## 5) Verify runtime health and bb availability

```powershell
fly machine list --app veilstar-brawl-zk
fly logs --app veilstar-brawl-zk
fly ssh console --app veilstar-brawl-zk --command "bb --version"
```

## Notes

- Keep `CORS_ORIGIN` set to your frontend origin (local: `http://localhost:3000` or `http://localhost:5173`).
- If local frontend is used with local main backend + Fly ZK, ensure in `.env`:
  - `VITE_API_BASE_URL=http://localhost:3001`
  - `VITE_ZK_API_BASE_URL=https://veilstar-brawl-zk.fly.dev`
