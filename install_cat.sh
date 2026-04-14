#!/bin/bash
# =============================================================================
# CAT: Coral Annotation Tool - Installation Script for Google Cloud Workstations
# Version: 5.0.0 (2026-04-10)
# =============================================================================
# Installs and configures CAT with Docker and Oracle database
# Handles auto-start on reboot and management commands
# Auto-bootstrap: Creates CAT schema and ingests reference data on startup
# =============================================================================
SCRIPT_VERSION="7.0.0"
CAT_BRANCH="cat_db_v7"

echo "=============================================="
echo "CAT Installer v${SCRIPT_VERSION}"
echo "Coral Annotation Tool with Oracle DB"
echo "Branch: ${CAT_BRANCH}"
echo "=============================================="
echo ""

# Detect the actual user (not root even when using sudo)
ACTUAL_USER="${SUDO_USER:-$USER}"
ACTUAL_HOME=$(eval echo ~$ACTUAL_USER)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Detected user: $ACTUAL_USER"
echo "Home directory: $ACTUAL_HOME"

# =============================================================================
# Configuration
# =============================================================================
CAT_INSTALL_DIR="$ACTUAL_HOME/cat_deployment"
CAT_DATA_DIR="$ACTUAL_HOME/cat_data"
CAT_EXPORTS_DIR="$CAT_DATA_DIR/exports"
CAT_REPO_URL="https://github.com/MichaelAkridge-NOAA/cat.git"

copy_cat_source() {
    local src_dir="$1"
    local dst_dir="$2"

    sudo -u "$ACTUAL_USER" mkdir -p "$dst_dir"

    if command -v rsync >/dev/null 2>&1; then
        sudo -u "$ACTUAL_USER" rsync -a --delete \
            --exclude='.git' \
            --exclude='__pycache__' \
            --exclude='*.pyc' \
            --exclude='venv' \
            "$src_dir/" "$dst_dir/"
    else
        sudo -u "$ACTUAL_USER" bash -c "cd \"$src_dir\" && tar --exclude='.git' --exclude='__pycache__' --exclude='*.pyc' -cf - . | (cd \"$dst_dir\" && tar -xf -)"
    fi
}

detect_workstation_url() {
    # Returns the Cloud Workstation external URL for the given port (e.g. 8000)
    local port="${1:-8000}"
    local ws_name hostname cluster_domain
    hostname=$(hostname 2>/dev/null | tr -d '\n' || echo "")

    # Method 1: DNS search domains in /etc/resolv.conf
    cluster_domain=$(grep -E '^search|^domain' /etc/resolv.conf 2>/dev/null \
        | grep -oE '[a-z0-9-]+\.cloudworkstations\.dev' \
        | head -1 || echo "")

    # Method 2: GCP metadata server attributes
    if [ -z "$cluster_domain" ]; then
        for attr in cluster-hostname workstation-cluster-domain workstation-cluster; do
            local val
            val=$(curl -sf -m 2 -H 'Metadata-Flavor: Google' \
                "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$attr" \
                2>/dev/null || echo "")
            if echo "$val" | grep -q 'cloudworkstations\.dev'; then
                cluster_domain=$(echo "$val" | grep -oE '[a-z0-9.-]+\.cloudworkstations\.dev' | head -1)
                break
            fi
        done
    fi

    # Method 3: proxy-url metadata attribute
    if [ -z "$cluster_domain" ]; then
        local proxy_url
        proxy_url=$(curl -sf -m 2 -H 'Metadata-Flavor: Google' \
            "http://metadata.google.internal/computeMetadata/v1/instance/attributes/proxy-url" \
            2>/dev/null || echo "")
        if echo "$proxy_url" | grep -q 'cloudworkstations\.dev'; then
            cluster_domain=$(echo "$proxy_url" | grep -oE '[a-z0-9.-]+\.cloudworkstations\.dev' | head -1)
        fi
    fi

    if [ -n "$cluster_domain" ] && [ -n "$hostname" ]; then
        echo "https://${port}-${hostname}.${cluster_domain}"
    else
        echo ""
    fi
}

wait_for_container_health() {
    local container_name="$1"
    local retries="${2:-60}"
    local interval="${3:-5}"

    local i status
    for ((i=1; i<=retries; i++)); do
        status=$(docker inspect -f '{{if .State.Running}}{{if .State.Health}}{{.State.Health.Status}}{{else}}running{{end}}{{else}}stopped{{end}}' "$container_name" 2>/dev/null || echo "missing")

        case "$status" in
            healthy|running)
                echo "  ✓ $container_name is $status"
                return 0
                ;;
            unhealthy)
                echo "  Attempt $i/$retries - $container_name is unhealthy, waiting ${interval}s..."
                ;;
            *)
                echo "  Attempt $i/$retries - $container_name status: $status, waiting ${interval}s..."
                ;;
        esac

        sleep "$interval"
    done

    return 1
}

# =============================================================================
# Step 1: Update system and install prerequisites
# =============================================================================
echo "[Step 1/10] Updating system and installing prerequisites..."
if ! sudo apt-get update; then
    echo "  ⚠️  apt-get update failed (often due to third-party repositories)."
    echo "     Continuing with package installation using current package indexes..."
fi
sudo apt-get install -y \
    apt-transport-https \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
    git \
    || {
    echo "  ERROR: Failed to install prerequisites"
    exit 1
}
echo "  ✓ Prerequisites installed"

# =============================================================================
# Step 2: Install Docker if not present
# =============================================================================
if ! command -v docker &> /dev/null; then
    echo "[Step 2/10] Installing Docker..."
    
    # Add Docker's official GPG key
    sudo mkdir -p /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    
    # Set up Docker repository
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
      $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
    
    # Install Docker Engine
    sudo apt-get update
    sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    
    # Add user to docker group
    sudo usermod -aG docker $ACTUAL_USER
    echo "  ✓ Docker installed. You may need to log out and back in for group changes to take effect."
else
    echo "[Step 2/10] Docker already installed"
    docker --version
fi

# =============================================================================
# Step 3: Create directory structure
# =============================================================================
echo "[Step 3/10] Creating directory structure..."
sudo -u "$ACTUAL_USER" mkdir -p "$CAT_INSTALL_DIR"
sudo -u "$ACTUAL_USER" mkdir -p "$CAT_EXPORTS_DIR"
sudo -u "$ACTUAL_USER" mkdir -p "$CAT_DATA_DIR/reference"
echo "  ✓ Directories created:"
echo "    - Install: $CAT_INSTALL_DIR"
echo "    - Data: $CAT_DATA_DIR"
echo "    - Exports: $CAT_EXPORTS_DIR"

# =============================================================================
# Step 4: Clone CAT repository from cat_db branch
# =============================================================================
echo "[Step 4/10] Cloning CAT application from $CAT_BRANCH branch..."

if [ "$SCRIPT_DIR" = "$CAT_INSTALL_DIR" ] && [ -f "$CAT_INSTALL_DIR/docker-compose.cat.yml" ]; then
    echo "  Install directory is already the CAT source directory"
elif [ -f "$SCRIPT_DIR/docker-compose.cat.yml" ]; then
    echo "  Using local CAT source from: $SCRIPT_DIR"
    copy_cat_source "$SCRIPT_DIR" "$CAT_INSTALL_DIR" || {
        echo "  ERROR: Failed to copy CAT files from local source"
        exit 1
    }
elif [ -d "$CAT_INSTALL_DIR/.git" ]; then
    echo "  Repository already exists, pulling latest from $CAT_BRANCH..."
    cd "$CAT_INSTALL_DIR"
    sudo -u "$ACTUAL_USER" git fetch origin
    sudo -u "$ACTUAL_USER" git checkout "$CAT_BRANCH"
    sudo -u "$ACTUAL_USER" git pull origin "$CAT_BRANCH"
elif [ -d "$CAT_INSTALL_DIR" ] && [ -n "$(ls -A "$CAT_INSTALL_DIR" 2>/dev/null)" ]; then
    echo "  Install directory is not empty; cloning to a temporary directory first..."
    TMP_CLONE_DIR="$(mktemp -d)"
    sudo -u "$ACTUAL_USER" git clone -b "$CAT_BRANCH" "$CAT_REPO_URL" "$TMP_CLONE_DIR/cat" || {
        echo "  ERROR: Failed to clone repository"
        rm -rf "$TMP_CLONE_DIR"
        exit 1
    }
    copy_cat_source "$TMP_CLONE_DIR/cat" "$CAT_INSTALL_DIR" || {
        echo "  ERROR: Failed to copy cloned CAT files"
        rm -rf "$TMP_CLONE_DIR"
        exit 1
    }
    rm -rf "$TMP_CLONE_DIR"
else
    echo "  Cloning CAT repository (branch: $CAT_BRANCH)..."
    sudo -u "$ACTUAL_USER" git clone -b "$CAT_BRANCH" "$CAT_REPO_URL" "$CAT_INSTALL_DIR" || {
        echo "  ERROR: Failed to clone repository"
        exit 1
    }
fi

sudo -u "$ACTUAL_USER" mkdir -p "$CAT_INSTALL_DIR/oracle-data"
# Oracle container runs as UID 54321 (oracle user) - bind mount must be writable by that UID
sudo chown 54321:54321 "$CAT_INSTALL_DIR/oracle-data"
sudo chmod 750 "$CAT_INSTALL_DIR/oracle-data"
echo "    - Oracle: $CAT_INSTALL_DIR/oracle-data (owned by UID 54321)"

if [ ! -f "$CAT_INSTALL_DIR/docker-compose.cat.yml" ]; then
    echo "  ERROR: docker-compose.cat.yml not found in $CAT_INSTALL_DIR"
    echo "         Verify the source branch and rerun the installer."
    exit 1
fi

echo "  ✓ CAT files ready"

# =============================================================================
# Step 5: Create .env file from template
# =============================================================================
echo "[Step 5/10] Configuring environment variables..."
cd "$CAT_INSTALL_DIR"

if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        sudo -u "$ACTUAL_USER" cp .env.example .env
        echo "  ✓ Created .env from template"
        echo "  ⚠️  IMPORTANT: Edit .env file and set your passwords!"
        echo "      Location: $CAT_INSTALL_DIR/.env"
    else
        echo "  Creating .env file..."
        sudo -u "$ACTUAL_USER" tee .env > /dev/null << 'ENVFILE'
# Oracle Database (root password)
ORACLE_PASSWORD=ChangeMe123

# CAT Application User (auto-created by Oracle container)
# docker-compose maps: APP_SCHEMA_NAME -> CAT_DB_USER, APP_SCHEMA_PASSWORD -> CAT_DB_PASSWORD
APP_SCHEMA_NAME=cat_user
APP_SCHEMA_PASSWORD=ChangeMe123

# Database Service Name
DB_SERVICE_NAME=FREEPDB1

# CAT Settings
CAT_STORAGE_BACKEND=oracle
CAT_HOST=0.0.0.0
CAT_PORT=8000
CAT_HOST_PORT=8000
ORACLE_HOST_PORT=1521

# Auto-bootstrap on startup (creates tables and loads reference data)
CAT_DB_AUTO_BOOTSTRAP=true
ENVFILE
        echo "  ✓ Created .env file"
        echo "  ⚠️  IMPORTANT: Edit .env and change default passwords!"
    fi
else
    echo "  ✓ .env file already exists"
fi

# =============================================================================
# Step 6: Build Docker images
# =============================================================================
echo "[Step 6/10] Building Docker images..."
cd "$CAT_INSTALL_DIR"
docker compose -f docker-compose.cat.yml build || {
    echo "  ERROR: Failed to build Docker images"
    exit 1
}
echo "  ✓ Docker images built"

# =============================================================================
# Step 7: Create management scripts
# =============================================================================
echo "[Step 7/10] Creating management scripts..."

# Start script
sudo -u "$ACTUAL_USER" cat > "$CAT_INSTALL_DIR/cat-start.sh" << 'STARTSCRIPT'
#!/bin/bash
cd "$(dirname "$0")"
echo "Starting CAT services..."
docker compose -f docker-compose.cat.yml up -d
echo "✓ CAT services started"
echo "Access CAT at: http://localhost:8000"
docker compose -f docker-compose.cat.yml ps
STARTSCRIPT
chmod +x "$CAT_INSTALL_DIR/cat-start.sh"

# Stop script
sudo -u "$ACTUAL_USER" cat > "$CAT_INSTALL_DIR/cat-stop.sh" << 'STOPSCRIPT'
#!/bin/bash
cd "$(dirname "$0")"
echo "Stopping CAT services..."
docker compose -f docker-compose.cat.yml down
echo "✓ CAT services stopped"
STOPSCRIPT
chmod +x "$CAT_INSTALL_DIR/cat-stop.sh"

# Restart script
sudo -u "$ACTUAL_USER" cat > "$CAT_INSTALL_DIR/cat-restart.sh" << 'RESTARTSCRIPT'
#!/bin/bash
cd "$(dirname "$0")"
echo "Restarting CAT services..."
docker compose -f docker-compose.cat.yml restart
echo "✓ CAT services restarted"
docker compose -f docker-compose.cat.yml ps
RESTARTSCRIPT
chmod +x "$CAT_INSTALL_DIR/cat-restart.sh"

# Status script
sudo -u "$ACTUAL_USER" cat > "$CAT_INSTALL_DIR/cat-status.sh" << 'STATUSSCRIPT'
#!/bin/bash
cd "$(dirname "$0")"
echo "CAT Service Status:"
docker compose -f docker-compose.cat.yml ps
echo ""
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health 2>/dev/null || echo "000")
if echo "$HTTP_CODE" | grep -q '^2'; then
    echo "  ✓ CAT app responding (HTTP $HTTP_CODE)"
    echo "  Access: http://localhost:8000"
else
    echo "  ✗ CAT app not responding (HTTP $HTTP_CODE)"
fi
echo ""
echo "Recent logs (last 20 lines):"
docker compose -f docker-compose.cat.yml logs --tail=20
STATUSSCRIPT
chmod +x "$CAT_INSTALL_DIR/cat-status.sh"

# Logs script
sudo -u "$ACTUAL_USER" cat > "$CAT_INSTALL_DIR/cat-logs.sh" << 'LOGSSCRIPT'
#!/bin/bash
cd "$(dirname "$0")"
echo "Following CAT logs (Ctrl+C to exit)..."
docker compose -f docker-compose.cat.yml logs -f
LOGSSCRIPT
chmod +x "$CAT_INSTALL_DIR/cat-logs.sh"

# Diagnostics script (mirrors label studio pattern)
sudo -u "$ACTUAL_USER" bash -c "cat > '$CAT_INSTALL_DIR/cat-diagnostics.sh'" << 'DIAGSCRIPT'
#!/bin/bash
CAT_DIR="$(dirname "$0")"
echo "=== CAT Diagnostics ==="
echo ""
echo "--- Container Status ---"
docker compose -f "$CAT_DIR/docker-compose.cat.yml" ps 2>/dev/null
echo ""
echo "--- Health Checks ---"
ORACLE_HEALTH=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}no healthcheck{{end}}' database-oracle-free 2>/dev/null || echo "not running")
echo "  Oracle: $ORACLE_HEALTH"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health 2>/dev/null || echo "000")
if echo "$HTTP_CODE" | grep -qE '^2'; then
    echo "  CAT app: OK (HTTP $HTTP_CODE) → http://localhost:8000"
else
    echo "  CAT app: NOT reachable (HTTP $HTTP_CODE)"
fi
echo ""
echo "--- Cloud Workstation URL Detection ---"
HOSTNAME=$(hostname 2>/dev/null)
CLUSTER=$(grep -E '^search|^domain' /etc/resolv.conf 2>/dev/null \
    | grep -oE '[a-z0-9-]+\.cloudworkstations\.dev' | head -1 || echo "")
echo "  hostname:       $HOSTNAME"
echo "  DNS domain:     ${CLUSTER:-(not detected)}"
if [ -n "$CLUSTER" ]; then
    echo "  Expected URL:   https://8000-${HOSTNAME}.${CLUSTER}"
    echo "  ✓ Use that URL in your Cloud Workstation browser tab"
else
    echo "  ✗ Could not auto-detect Cloud Workstation domain"
    echo "    Run: cat-set-url.sh https://8000-HOSTNAME.CLUSTER.cloudworkstations.dev"
fi
echo ""
echo "--- Oracle Data Directory ---"
ORACLE_DATA="$CAT_DIR/oracle-data"
echo "  Path:  $ORACLE_DATA"
ls -la "$ORACLE_DATA" 2>/dev/null | head -5 || echo "  (empty or not found)"
OWNER=$(stat -c '%U (%u)' "$ORACLE_DATA" 2>/dev/null || echo "unknown")
echo "  Owner: $OWNER (should be 54321 for Oracle container)"
echo ""
echo "--- Recent CAT App Logs ---"
docker compose -f "$CAT_DIR/docker-compose.cat.yml" logs --tail=15 cat-app 2>/dev/null
echo ""
echo "--- Recent Oracle Logs ---"
docker compose -f "$CAT_DIR/docker-compose.cat.yml" logs --tail=10 database-oracle-free 2>/dev/null
DIAGSCRIPT
chmod +x "$CAT_INSTALL_DIR/cat-diagnostics.sh"

# Set-URL script (for Cloud Workstation URL override)
sudo -u "$ACTUAL_USER" bash -c "cat > '$CAT_INSTALL_DIR/cat-set-url.sh'" << 'SETURLSCRIPT'
#!/bin/bash
# Usage: cat-set-url.sh https://8000-HOSTNAME.CLUSTER.cloudworkstations.dev
CAT_DIR="$(dirname "$0")"
if [ -z "$1" ]; then
    echo "Usage: $0 https://8000-HOSTNAME.CLUSTER.cloudworkstations.dev"
    echo ""
    echo "Sets the Cloud Workstation external URL for CAT."
    echo "Find your URL in the Cloud Workstations web console → port 8000 forwarding link."
    [ -f "$CAT_DIR/.env.custom" ] && echo "Current: $(cat $CAT_DIR/.env.custom)" || echo "(not set)"
    exit 1
fi
WS_URL="${1%/}"
if ! echo "$WS_URL" | grep -q '^https\?://'; then
    echo "Error: URL must start with http:// or https://"
    exit 1
fi
echo "CAT_EXTERNAL_URL=${WS_URL}" > "$CAT_DIR/.env.custom"
echo "✓ URL saved. Restart with: $CAT_DIR/cat-restart.sh"
SETURLSCRIPT
chmod +x "$CAT_INSTALL_DIR/cat-set-url.sh"

echo "  ✓ Management scripts created:"
echo "    - cat-start.sh:       Start CAT services"
echo "    - cat-stop.sh:        Stop CAT services"
echo "    - cat-restart.sh:     Restart CAT services"
echo "    - cat-status.sh:      Check service status"
echo "    - cat-logs.sh:        View logs"
echo "    - cat-diagnostics.sh: Diagnose Cloud Workstation connectivity"
echo "    - cat-set-url.sh:     Set Cloud Workstation external URL"

# =============================================================================
# Step 8: Configure auto-start (workstation-startup.d → systemd → .bashrc)
# =============================================================================
echo "[Step 8/10] Configuring auto-start on boot..."
AUTO_START_STATUS="DISABLED"

# --- Method 1: Google Cloud Workstation hook directory (preferred) ----------
if [ -d "/etc/workstation-startup.d" ]; then
    STARTUP_HOOK="/etc/workstation-startup.d/50-start-cat"
    sudo bash -c "cat > '$STARTUP_HOOK'" << HOOKEOF
#!/bin/bash
set -euo pipefail
LOG_FILE="/var/log/cat-bootstrap.log"
echo "=== CAT bootstrap \$(date '+%Y-%m-%d %H:%M:%S %Z') ===" >> "\$LOG_FILE"

ACTUAL_USER=\$(awk -F: '\$3>=1000 && \$3<60000 && \$1!="nobody" {print \$1; exit}' /etc/passwd)
[ -z "\${ACTUAL_USER:-}" ] && { echo "No non-root user; skipping" >> "\$LOG_FILE"; exit 0; }

CAT_DIR="$CAT_INSTALL_DIR"
# Wait up to 2 min for home mount and docker socket
for i in \$(seq 1 24); do
    [ -f "\$CAT_DIR/docker-compose.cat.yml" ] && [ -S /var/run/docker.sock ] && break
    sleep 5
done

[ ! -f "\$CAT_DIR/docker-compose.cat.yml" ] && { echo "docker-compose.cat.yml not found" >> "\$LOG_FILE"; exit 0; }

if docker compose -f "\$CAT_DIR/docker-compose.cat.yml" ps | grep -q 'Up'; then
    echo "CAT already running" >> "\$LOG_FILE"
    exit 0
fi

echo "Starting CAT services..." >> "\$LOG_FILE"
cd "\$CAT_DIR"
docker compose -f docker-compose.cat.yml up -d >> "\$LOG_FILE" 2>&1 || true
echo "CAT start complete" >> "\$LOG_FILE"
HOOKEOF
    sudo chmod +x "$STARTUP_HOOK"
    AUTO_START_STATUS="ENABLED via /etc/workstation-startup.d/"
    echo "  ✓ Cloud Workstation startup hook installed: $STARTUP_HOOK"
    echo "    CAT will start automatically on workstation boot."

# --- Method 2: systemd (non-Cloud-Workstation Linux) -----------------------
elif [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
    sudo bash -c "cat > /etc/systemd/system/cat.service" << SERVICEEOF
[Unit]
Description=CAT: Coral Annotation Tool
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$CAT_INSTALL_DIR
User=$ACTUAL_USER
Group=$ACTUAL_USER
ExecStart=/usr/bin/docker compose -f docker-compose.cat.yml up -d
ExecStop=/usr/bin/docker compose -f docker-compose.cat.yml down
Restart=on-failure
RestartSec=10s

[Install]
WantedBy=multi-user.target
SERVICEEOF
    sudo systemctl daemon-reload
    sudo systemctl enable cat.service
    AUTO_START_STATUS="ENABLED via systemd"
    echo "  ✓ Systemd service installed and enabled"

# --- Method 3: .bashrc auto-start (fallback) --------------------------------
else
    BASHRC="$ACTUAL_HOME/.bashrc"
    # Remove any old CAT autostart blocks first
    sudo -u "$ACTUAL_USER" sed -i '/# CAT auto-start/,/# cat-autostart-end/d' "$BASHRC" 2>/dev/null || true
    sudo -u "$ACTUAL_USER" bash -c "cat >> '$BASHRC'" << 'BASHRCEOF'

# CAT auto-start (only for interactive shells)
if [[ $- == *i* ]] && [ -t 0 ]; then
    if [ -f "\$HOME/cat_deployment/cat-start.sh" ]; then
        ORACLE_UP=$(docker inspect -f '{{.State.Health.Status}}' database-oracle-free 2>/dev/null || echo "")
        CAT_UP=$(docker inspect -f '{{.State.Running}}' cat-app 2>/dev/null || echo "")
        if [ "$CAT_UP" != "true" ]; then
            (nohup bash "\$HOME/cat_deployment/cat-start.sh" >> "\$HOME/cat_deployment/autostart.log" 2>&1 &) &>/dev/null
        fi
    fi
fi
# cat-autostart-end
BASHRCEOF
    AUTO_START_STATUS="ENABLED via .bashrc (opens on first login)"
    echo "  ✓ .bashrc auto-start configured (fallback mode)"
fi

# =============================================================================
# Step 9: Start CAT services
# =============================================================================
echo "[Step 9/10] Starting CAT services for the first time..."
cd "$CAT_INSTALL_DIR"

# Check for stale partial Oracle data from a previous failed install
ORACLE_DATA_DIR="$CAT_INSTALL_DIR/oracle-data"
if [ -n "$(ls -A "$ORACLE_DATA_DIR" 2>/dev/null)" ]; then
    # Directory has content but Oracle container is not currently running or healthy
    ORACLE_RUNNING=$(docker inspect -f '{{.State.Running}}' database-oracle-free 2>/dev/null || echo "false")
    if [ "$ORACLE_RUNNING" != "true" ]; then
        echo "  ⚠️  oracle-data directory is non-empty from a previous install attempt."
        echo "     Cleaning stale data to allow fresh Oracle initialization..."
        docker compose -f docker-compose.cat.yml down -v 2>/dev/null || true
        sudo rm -rf "${ORACLE_DATA_DIR:?}"/*
        # Re-apply correct ownership after wipe
        sudo chown 54321:54321 "$ORACLE_DATA_DIR"
        sudo chmod 750 "$ORACLE_DATA_DIR"
        echo "  ✓ Stale Oracle data cleared"
    fi
fi

docker compose -f docker-compose.cat.yml up -d database-oracle-free || {
    echo "  ERROR: Failed to start Oracle container"
    exit 1
}

echo "  Waiting for Oracle to become healthy (this can take several minutes on first run)..."
if ! wait_for_container_health "database-oracle-free" 90 5; then
    echo "  ERROR: Oracle did not become healthy in time"
    echo "  Last Oracle logs:"
    docker compose -f docker-compose.cat.yml logs --tail=100 database-oracle-free || true
    exit 1
fi

docker compose -f docker-compose.cat.yml up -d cat-app || {
    echo "  ERROR: Failed to start CAT app container"
    exit 1
}

echo "  Waiting for CAT app health..."
if ! wait_for_container_health "cat-app" 60 3; then
    echo "  ERROR: CAT app did not become healthy in time"
    echo "  Last CAT app logs:"
    docker compose -f docker-compose.cat.yml logs --tail=100 cat-app || true
    exit 1
fi

APP_READY=false
for i in {1..30}; do
    if curl -sf "http://localhost:8000/health" >/dev/null 2>&1; then
        APP_READY=true
        break
    fi
    sleep 2
done

# Check service status
if [ "$APP_READY" = true ]; then
    echo "  ✓ CAT services started successfully"
    echo "  Triggering site reference data seed..."
    curl -sf -X POST "http://localhost:${CAT_HOST_PORT:-8000}/api/sites/seed" \
        -o /dev/null && echo "  ✓ Site data seeded" || echo "  ⚠️  Seed endpoint not reachable yet (will auto-seed on next restart)"
else
    echo "  ⚠️  CAT health endpoint not reachable yet. Check with: $CAT_INSTALL_DIR/cat-status.sh"
fi

# =============================================================================
# Step 10: Display summary
# =============================================================================
echo "[Step 10/10] Installation complete!"

# Auto-detect Cloud Workstation URL
DETECTED_URL=$(detect_workstation_url "${CAT_HOST_PORT:-8000}" 2>/dev/null || echo "")

echo ""
echo "=============================================="
echo "CAT Installation Summary"
echo "=============================================="
echo ""
echo "📁 Installation Directory: $CAT_INSTALL_DIR"
echo "📁 Data Directory: $CAT_DATA_DIR"
echo "🌿 Branch: $CAT_BRANCH"
echo ""
echo "🌐 Access CAT at: http://localhost:8000"
if [ -n "$DETECTED_URL" ]; then
    echo "   Cloud Workstation URL: $DETECTED_URL"
else
    echo "   Cloud Workstation URL: (run cat-diagnostics.sh to detect)"
fi
echo ""
echo "🚀 Auto-Bootstrap: ENABLED"
echo "   - CAT tables created automatically"
echo "   - Reference data ingested on startup"
echo ""
echo "🛠️  Management Commands:"
echo "   Start:       $CAT_INSTALL_DIR/cat-start.sh"
echo "   Stop:        $CAT_INSTALL_DIR/cat-stop.sh"
echo "   Restart:     $CAT_INSTALL_DIR/cat-restart.sh"
echo "   Status:      $CAT_INSTALL_DIR/cat-status.sh"
echo "   Logs:        $CAT_INSTALL_DIR/cat-logs.sh"
echo "   Diagnostics: $CAT_INSTALL_DIR/cat-diagnostics.sh"
echo "   Set URL:     $CAT_INSTALL_DIR/cat-set-url.sh <URL>"
echo ""
echo "⚙️  Configuration:"
echo "   Environment: $CAT_INSTALL_DIR/.env"
echo "   Compose:     $CAT_INSTALL_DIR/docker-compose.cat.yml"
echo ""
echo "🔄 Auto-start on boot: $AUTO_START_STATUS"
if [ "$HAS_SYSTEMD" = true ] && command -v systemctl >/dev/null 2>&1; then
    echo "   Manage: sudo systemctl [start|stop|status] cat.service"
fi
echo ""
echo "⚠️  IMPORTANT NEXT STEPS:"
echo "   1. Edit $CAT_INSTALL_DIR/.env"
echo "   2. Change ORACLE_PASSWORD and APP_SCHEMA_PASSWORD"
echo "   3. Run: $CAT_INSTALL_DIR/cat-restart.sh"
echo ""
echo "=============================================="
