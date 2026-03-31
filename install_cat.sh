#!/bin/bash
# =============================================================================
# CAT: Coral Annotation Tool - Installation Script for Google Cloud Workstations
# Version: 2.0.0 (2026-03-30)
# =============================================================================
# Installs and configures CAT with Docker and Oracle database
# Handles auto-start on reboot and management commands
# Auto-bootstrap: Creates CAT schema and ingests reference data on startup
# =============================================================================
SCRIPT_VERSION="2.0.0"
CAT_BRANCH="cat_db"

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
echo "Recent logs:"
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

echo "  ✓ Management scripts created:"
echo "    - cat-start.sh: Start CAT services"
echo "    - cat-stop.sh: Stop CAT services"
echo "    - cat-restart.sh: Restart CAT services"
echo "    - cat-status.sh: Check service status"
echo "    - cat-logs.sh: View logs"

# =============================================================================
# Step 8: Create systemd service for auto-start
# =============================================================================
echo "[Step 8/10] Creating systemd service for auto-start..."
[ -d /run/systemd/system ] && HAS_SYSTEMD=true || HAS_SYSTEMD=false

if [ "$HAS_SYSTEMD" = true ] && command -v systemctl >/dev/null 2>&1; then
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

# Start command
ExecStart=/usr/bin/docker compose -f docker-compose.cat.yml up -d

# Stop command
ExecStop=/usr/bin/docker compose -f docker-compose.cat.yml down

# Restart behavior
Restart=on-failure
RestartSec=10s

[Install]
WantedBy=multi-user.target
SERVICEEOF

    sudo systemctl daemon-reload
    sudo systemctl enable cat.service
    AUTO_START_STATUS="ENABLED"
    echo "  ✓ Systemd service created and enabled"
    echo "    Service will start automatically on boot"
else
    AUTO_START_STATUS="DISABLED (systemd not available in this environment)"
    echo "  ⚠️  systemd is not available (common in cloud/container workstations)."
    echo "     Skipping auto-start service setup. Use cat-start.sh manually."
fi

# =============================================================================
# Step 9: Start CAT services
# =============================================================================
echo "[Step 9/10] Starting CAT services for the first time..."
cd "$CAT_INSTALL_DIR"
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

echo "  Waiting for services to be healthy..."
sleep 10

# Check service status
if [ "$APP_READY" = true ]; then
    echo "  ✓ CAT services started successfully"
else
    echo "  ⚠️  CAT health endpoint not reachable yet. Check with: $CAT_INSTALL_DIR/cat-status.sh"
fi

# =============================================================================
# Step 10: Display summary
# =============================================================================
echo "[Step 10/10] Installation complete!"
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
echo "   (Or use Cloud Workstation proxy URL)"
echo ""
echo "🚀 Auto-Bootstrap: ENABLED"
echo "   - CAT tables created automatically"
echo "   - Reference data ingested on startup"
echo ""
echo "🛠️  Management Commands:"
echo "   Start:   $CAT_INSTALL_DIR/cat-start.sh"
echo "   Stop:    $CAT_INSTALL_DIR/cat-stop.sh"
echo "   Restart: $CAT_INSTALL_DIR/cat-restart.sh"
echo "   Status:  $CAT_INSTALL_DIR/cat-status.sh"
echo "   Logs:    $CAT_INSTALL_DIR/cat-logs.sh"
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
