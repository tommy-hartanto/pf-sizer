# PM Sizer

Auto-cancels duplicate orders, cleans up expired/cancelled markets, cancels orders right before expiry (`CANCEL_BEFORE_END_SECONDS`), cancels orders when live Chainlink TWAP breaches percentage delta thresholds (`CANCEL_THRES_<ASSET>`), and dynamically manages order sizing. Runs continuously in the background.

---

## Deployment Guides
- [Deploy on Oracle Cloud (VM.Standard.E2.1.Micro / A1.Flex — Always Free)](#deploy-on-oracle-cloud-always-free)
- [Deploy on AWS EC2 (t2.micro — Free Tier)](#deploy-on-aws-ec2-step-by-step)
- [Deploy on Fly.io (Single Machine)](#deploy-on-flyio-single-machine)

---

## Deploy on Oracle Cloud (Always Free)

> Step-by-step guide for deploying on **Oracle Cloud Infrastructure (OCI) Always Free Tier** using **Oracle Linux 9** or **Ubuntu 22.04 / 24.04 LTS**.

### Recommended Specifications
| Specification | AMD Micro (Always Free) | Ampere ARM (Always Free) |
|---|---|---|
| **Shape** | `VM.Standard.E2.1.Micro` | `VM.Standard.A1.Flex` |
| **OCPU** | `1` (1/8 OCPU AMD) | `1` to `4` OCPUs (ARM Neoverse-N1) |
| **Memory** | `1 GB` *(swap required)* | `6 GB` to `24 GB` |
| **OS** | **Oracle Linux 9** or **Ubuntu 24.04/22.04 LTS** | **Oracle Linux 9** or **Ubuntu 24.04/22.04 LTS** |
| **Default SSH User** | `opc` (Oracle Linux) or `ubuntu` (Ubuntu) | `opc` (Oracle Linux) or `ubuntu` (Ubuntu) |
| **Inbound Ports** | None required (bot makes only outbound HTTPS/WSS calls) | None required |

> [!IMPORTANT]
> **Region Selection (Polymarket Geo-Restriction):**
> Polymarket Cloudflare firewall restricts access from IP addresses located inside the United States. **Select a non-US region for your VM** (e.g. Frankfurt `eu-frankfurt-1`, Amsterdam `eu-amsterdam-1`, London `uk-london-1`, Singapore `ap-singapore-1`, Tokyo `ap-tokyo-1`, Sydney `ap-sydney-1`) to avoid `403 Forbidden` API errors.

---

### 1. Launch a Free Tier VM Instance

1. Log in to the [Oracle Cloud Console](https://cloud.oracle.com/).
2. Open the navigation menu (top-left **☰**) and select **Compute** &rarr; **Instances**.
3. Click **Create instance**.
4. **Name**: Enter a name (e.g. `pm-sizer-bot`).
5. **Placement & Region**: Verify your region is outside the US.
6. **Image and shape**:
   - Click **Edit** (or **Change image / Change shape**).
   - **Image**: Choose **Oracle Linux 9** (or **Ubuntu 24.04/22.04 LTS**).
   - **Shape**: Choose **AMD** &rarr; `VM.Standard.E2.1.Micro` (or **Ampere** &rarr; `VM.Standard.A1.Flex`).
7. **Networking**:
   - Keep the default Virtual Cloud Network (VCN) options.
   - Ensure **Assign a public IPv4 address** is selected.
8. **Add SSH keys**:
   - Select **Generate a key pair for me** and click **Save private key** (saves a `.key` / `.pem` file to your computer). Keep this safe!
9. Click **Create**.
10. Once the instance state turns **Running**, copy the **Public IP address**.

---

### 2. Connect via SSH

Open your terminal (macOS/Linux) or PowerShell (Windows):

```bash
ssh -i /path/to/your-key.key opc@YOUR_SERVER_IP
```

> - If using **Ubuntu**, replace `opc` with `ubuntu`: `ssh -i /path/to/your-key.key ubuntu@YOUR_SERVER_IP`
> - **macOS / Linux users**: If you see a `permissions are too open` error, fix it with:
>   ```bash
>   chmod 400 /path/to/your-key.key
>   ```

Type `yes` when prompted to accept the host fingerprint.

---

### 3. Add Swap Space (Crucial for 1 GB RAM Micro VMs)

> [!TIP]
> The `VM.Standard.E2.1.Micro` comes with 1 GB of physical RAM. Adding a 2 GB swap file prevents Out-Of-Memory (OOM) crashes when running `npm install` and Node.js processes.

Run the following commands:

```bash
sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Verify swap is active:
```bash
free -h
```
*(You should see `Swap: 2.0Gi`)*

---

### 4. Enable System Time Synchronization (NTP)

> [!IMPORTANT]
> The Polymarket CLOB API uses HMAC signature headers with timestamp validation. If server time drifts by more than 5 seconds, API requests will fail with `401 Unauthorized`.

**For Ubuntu (Default):**
```bash
sudo systemctl enable --now systemd-timesyncd
timedatectl status
```

**For Oracle Linux:**
```bash
sudo systemctl enable --now chronyd
timedatectl status
```
*(Verify that `System clock synchronized: yes` and `NTP service: active`)*

---

### 5. Install Node.js 20 LTS & Git

**For Ubuntu (Default):**
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs
```

**For Oracle Linux 9:**
```bash
sudo dnf update -y
sudo dnf install -y git curl
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs
```

Verify the installation:
```bash
node -v
npm -v
```
*(Should output `v20.x.x` and `npm 10.x.x` or higher)*

---

### 6. Clone the Repository & Install Dependencies

```bash
git clone https://github.com/tommy-hartanto/pm-sizer.git
cd pm-sizer
npm install
```

---

### 7. Configure Environment Variables (`.env`)

Create your `.env` file from the example template:

```bash
cp .env.example .env
nano .env
```

Set file permissions so only your user can read your private keys:
```bash
chmod 600 .env
```

#### Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `PRIVATE_KEY` | **Yes** | — | Hex private key of your Polygon signer wallet |
| `FUNDER_ADDRESS` | Conditional | `""` | Polymarket proxy / funder wallet address (required if using Magic / Polymarket email login) |
| `POLY_API_KEY` | No | `""` | CLOB API Key *(if left blank, automatically derived from wallet)* |
| `POLY_API_SECRET` | No | `""` | CLOB API Secret *(if left blank, automatically derived from wallet)* |
| `POLY_API_PASSPHRASE` | No | `""` | CLOB API Passphrase *(if left blank, automatically derived from wallet)* |
| `ASSETS` | No | `eth,btc,sol,xrp,doge,bnb,hype` | Comma-separated list of crypto tickers to inspect |
| `CANCEL_BEFORE_END_SECONDS` | No | `30` | Cancels all open orders on active markets $N$ seconds before market resolution (set `0` to disable) |
| `DELETE_ALL_ORDERS` | No | `false` | Precautionary switch: set `true` to cancel **all** orders in active windows |
| `DELETE_ALL_SLUGS` | No | `doge-updown-15m` | Comma-separated slug substrings where ALL orders will be canceled |
| `DELETE_ALL_PRICES` | No | `""` | Comma-separated prices where orders will be deleted instead of kept (e.g. `0.01,0.03`) |
| `DELETE_ALL_SIZES` | No | `""` | Comma-separated order sizes to purge |
| `CANCEL_OPPOSITE_ON_FILL` | No | `false` | Set `true` to run the fill watcher and cancel opposite sides on fill |
| `CANCEL_THRES_<ASSET>` | No | `""` | Cancels all orders in active markets if live Chainlink TWAP deviates by $\ge N\%$ from open price (e.g. `CANCEL_THRES_BTC=0.3` for 0.3%) |
| `CANCEL_THRES_DEFAULT` | No | `""` | Optional fallback percentage threshold for any asset not explicitly defined |

Save and exit in `nano`: Press **Ctrl+X**, then **Y**, then **Enter**.

---

### 8. Test Run & Order Inspection

1. **Inspect live open orders across your markets:**
   ```bash
   npm run fetch
   ```

2. **Run a test cycle of the cleanup bot:**
   ```bash
   npm start
   ```
   If it initializes and runs cleanly, press **Ctrl+C** to stop the test.

---

### 9. Run 24/7 in Background with PM2

Install **PM2** to manage the process and restart it on failures or server reboots:

1. **Install PM2 globally:**
   ```bash
   sudo npm install -g pm2
   ```

2. **Start the bot with auto-restart on memory threshold:**
   ```bash
   pm2 start src/cleanup.js --name pm-sizer --max-memory-restart 300M
   ```

3. **Configure PM2 to start on system boot:**
   ```bash
   pm2 startup
   ```
   *(If PM2 prints a `sudo env PATH=...` command, copy and run it)*

4. **Save the PM2 process list:**
   ```bash
   pm2 save
   ```

You can now safely disconnect from SSH. The bot runs continuously in its internal 5-minute loop.

---

### 10. Monitoring & Maintenance

- **View live logs:**
  ```bash
  pm2 logs pm-sizer
  ```
  *(Press **Ctrl+C** to exit the log viewer; the bot will keep running)*

- **Add a quick log shortcut (`dl`):**
  ```bash
  echo "alias dl='tail -n 40 -f ~/.pm2/logs/pm-sizer-out.log'" >> ~/.bashrc
  source ~/.bashrc
  ```
  *(Now simply type `dl` anytime to stream live logs)*

- **Restart / Stop / Delete:**
  ```bash
  pm2 restart pm-sizer
  pm2 stop pm-sizer
  pm2 delete pm-sizer
  ```

- **Update to latest version:**
  ```bash
  cd ~/pm-sizer
  git pull
  npm install
  pm2 restart pm-sizer
  ```

---

## Deploy on AWS EC2 (Step-by-Step)

> For **Amazon Linux 2023** or **Ubuntu** on AWS EC2 `t2.micro` / `t3.micro` Free Tier.

### 1. Launch an EC2 instance
1. Go to the [AWS EC2 Console](https://console.aws.amazon.com/ec2/) and click **Launch instance**.
2. **Region**: Choose a non-US AWS region (e.g. `eu-central-1` Frankfurt, `eu-west-1` Ireland, `ap-southeast-1` Singapore) due to Polymarket geo-restrictions.
3. **AMI**: Amazon Linux 2023 or Ubuntu 24.04 LTS.
4. **Instance type**: `t2.micro` or `t3.micro` (free tier eligible).
5. **Key pair**: Create and download your `.pem` key.
6. Click **Launch instance**.

### 2. Connect to your instance
```bash
ssh -i your-key.pem ec2-user@YOUR_SERVER_IP
# (Use ubuntu@YOUR_SERVER_IP for Ubuntu AMIs)
```
*(Run `chmod 400 your-key.pem` if permissions error occurs)*

### 3. Add Swap Space (1 GB instances)
```bash
sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 4. Install Node.js 20 & Git
```bash
sudo dnf update -y && sudo dnf install -y git curl
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs
```

### 5. Clone, Configure & Run
```bash
git clone https://github.com/tommy-hartanto/pm-sizer.git
cd pm-sizer
npm install
cp .env.example .env
chmod 600 .env
nano .env   # Fill in PRIVATE_KEY and configuration
```

### 6. Start with PM2
```bash
sudo npm install -g pm2
pm2 start src/cleanup.js --name pm-sizer --max-memory-restart 300M
pm2 startup
pm2 save
```

---

## Deploy on Fly.io (Single Machine)

Fly.io provides low-latency serverless container instances across global regions.

1. **Install Fly CLI & Login:**
   ```bash
   fly auth login
   ```

2. **Import Secrets from `.env`:**
   ```bash
   fly secrets import < .env
   ```

3. **Deploy with 1 Machine (`--ha=false`):**
   ```bash
   fly deploy --ha=false
   ```

4. **Monitor Status & Logs:**
   ```bash
   fly status
   fly logs
   ```

---

## Troubleshooting Guide

| Issue | Root Cause | Solution |
|---|---|---|
| `403 Forbidden` / Cloudflare Error | VM is deployed in a US cloud region (Polymarket blocks US traffic) | Deploy VM in an EU or APAC region (e.g. Frankfurt, Amsterdam, London, Singapore, Tokyo) or route through a proxy. |
| `401 Unauthorized` / Signature Error | System clock drift causes HMAC signature timestamps to be rejected | Enable NTP sync: `sudo systemctl enable --now chronyd` (Oracle Linux) or `systemd-timesyncd` (Ubuntu). |
| Process killed during `npm install` | Out Of Memory (OOM) on 1 GB RAM Micro instance | Create a 2 GB swap file as described in [Step 3](#3-add-swap-space-crucial-for-1-gb-ram-micro-vms). |
| `Missing PRIVATE_KEY` | `.env` file does not exist or `PRIVATE_KEY` is not set | Copy `.env.example` to `.env` and configure your private key. |
| `Failed to derive API keys` | Invalid private key or Polymarket proxy address mismatch | Verify `PRIVATE_KEY` and ensure `FUNDER_ADDRESS` matches your Polymarket deposit address. |
| Node version incompatibility | Running Node.js < 20 | Upgrade to Node 20 LTS using the official NodeSource script. |
