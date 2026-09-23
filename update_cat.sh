#!/bin/bash
# =============================================================================
# CAT: Coral Annotation Tool - Update Script
# =============================================================================
# Pulls the latest code from the configured branch and rebuilds/restarts
# the CAT app container.  Oracle is intentionally left running to avoid
# the multi-minute cold-start penalty.
#
# Usage:
#   ./update_cat.sh                   # Normal update (incremental Docker build)
#   ./update_cat.sh --force-rebuild   # Bust the Docker layer cache
#   ./update_cat.sh --no-backup       # Skip the pre-update database dump (not recommended)
#   ./update_cat.sh --branch=dev      # Override the target git branch
# =============================================================================
SCRIPT_VERSION="17.0.0"
CAT_BRANCH="cat_db_v17"
CAT_REPO_URL="https://github.com/MichaelAkridge-NOAA/cat.git"

# ── Parse flags ──────────────────────────────────────────────────────────────
FORCE_REBUILD=false
SKIP_BACKUP=false
CUSTOM_BRANCH=""

# while/shift (not `for arg in "$@"`): `--branch NAME` must consume NAME
# wherever it appears, not only as the first argument.
while [ $# -gt 0 ]; do
    case "$1" in
        --force-rebuild)  FORCE_REBUILD=true ;;
        --no-backup)      SKIP_BACKUP=true ;;
        --branch)         shift; CUSTOM_BRANCH="${1:-}" ;;
        --branch=*)       CUSTOM_BRANCH="${1#--branch=}" ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
    shift
done

[ -n "$CUSTOM_BRANCH" ] && CAT_BRANCH="$CUSTOM_BRANCH"

# ── Environment ──────────────────────────────────────────────────────────────
ACTUAL_USER="${SUDO_USER:-$USER}"
ACTUAL_HOME=$(eval echo ~"$ACTUAL_USER")
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CAT_INSTALL_DIR="$ACTUAL_HOME/cat_deployment"
CAT_HTTP_PORT=""

echo "=============================================="
echo "CAT Updater v${SCRIPT_VERSION}"
echo "Branch: ${CAT_BRANCH}"
echo "Force rebuild: ${FORCE_REBUILD}"
echo "=============================================="
echo ""

# =============================================================================
# Helper functions
# =============================================================================

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
                return 0 ;;
            unhealthy)
                echo "  Attempt $i/$retries - $container_name is unhealthy, waiting ${interval}s..." ;;
            *)
                echo "  Attempt $i/$retries - $container_name status: $status, waiting ${interval}s..." ;;
        esac
        sleep "$interval"
    done
    return 1
}

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
            --exclude='.env' \
            --exclude='oracle-data' \
            --exclude='exports' \
            --exclude='backups' \
            --exclude='data' \
            "$src_dir/" "$dst_dir/"
    else
        sudo -u "$ACTUAL_USER" bash -c "cd \"$src_dir\" && tar \
            --exclude='.git' --exclude='__pycache__' --exclude='*.pyc' \
            --exclude='.env' --exclude='oracle-data' --exclude='exports' --exclude='backups' --exclude='data' \
            -cf - . | (cd \"$dst_dir\" && tar -xf -)"
    fi
}

# =============================================================================
# Step 1: Pre-flight checks
# =============================================================================
echo "[Step 1/7] Pre-flight checks..."

if ! command -v docker &>/dev/null; then
    echo "  ERROR: docker not found. Is Docker installed?"
    exit 1
fi

if [ ! -f "$CAT_INSTALL_DIR/docker-compose.cat.yml" ]; then
    # Maybe the install dir IS the script dir (running in place)
    if [ -f "$SCRIPT_DIR/docker-compose.cat.yml" ]; then
        CAT_INSTALL_DIR="$SCRIPT_DIR"
        echo "  Using in-place installation: $CAT_INSTALL_DIR"
    else
        echo "  ERROR: CAT installation not found at $CAT_INSTALL_DIR"
        echo "         Run install_cat.sh first, or cd into the install directory."
        exit 1
    fi
fi

if [ ! -f "$CAT_INSTALL_DIR/.env" ]; then
    echo "  WARNING: .env file not found at $CAT_INSTALL_DIR/.env"
    echo "           Continuing, but some env vars may be missing."
fi

if [ -f "$CAT_INSTALL_DIR/.env" ]; then
    CAT_HTTP_PORT=$(grep -E '^CAT_HOST_PORT=' "$CAT_INSTALL_DIR/.env" 2>/dev/null \
        | tail -1 | cut -d= -f2- | tr -d '"[:space:]' || true)
fi
CAT_HTTP_PORT="${CAT_HTTP_PORT:-8000}"

echo "  ✓ Install directory: $CAT_INSTALL_DIR"
echo "  ✓ Docker available"
echo "  ✓ Host HTTP port: $CAT_HTTP_PORT"

# =============================================================================
# Step 2: Pre-update backup — Oracle Data Pump dump of the CAT schema
# =============================================================================
# The app is stopped first so the dump is consistent (no saves mid-export).
# A new version can run schema migrations on first start, so the update
# ABORTS if the dump can't be made — pass --no-backup to override.
# (This used to curl /api/annotations/export, an endpoint that never existed
# in DB mode, so every update silently ran with no backup at all.)
if [ "$SKIP_BACKUP" = false ]; then
    echo ""
    echo "[Step 2/7] Creating pre-update database backup (Data Pump)..."
    cd "$CAT_INSTALL_DIR"
    docker compose -f docker-compose.cat.yml stop cat-app 2>/dev/null || true

    BACKUP_SCRIPT="$CAT_INSTALL_DIR/scripts/backup_to_gcs.sh"
    [ -f "$BACKUP_SCRIPT" ] || BACKUP_SCRIPT="$SCRIPT_DIR/scripts/backup_to_gcs.sh"
    UPDATE_BACKUP_ROOT="$CAT_INSTALL_DIR/backups/pre-update"
    sudo -u "$ACTUAL_USER" mkdir -p "$UPDATE_BACKUP_ROOT"

    if [ ! -f "$BACKUP_SCRIPT" ]; then
        echo "  ERROR: backup script not found (scripts/backup_to_gcs.sh)."
        echo "         Back up the database yourself, then re-run with --no-backup."
        docker compose -f docker-compose.cat.yml start cat-app 2>/dev/null || true
        exit 1
    fi

    bash "$BACKUP_SCRIPT" --local-only --skip-oracle-data --backup-root "$UPDATE_BACKUP_ROOT" || true
    LATEST_DMP=$(ls -t "$UPDATE_BACKUP_ROOT"/*/oracle-export/cat_export.dmp 2>/dev/null | head -1 || true)
    if [ -n "$LATEST_DMP" ] && [ -s "$LATEST_DMP" ]; then
        echo "  ✓ Database dump: $LATEST_DMP ($(du -h "$LATEST_DMP" | cut -f1))"
    else
        echo "  ERROR: no database dump was produced — stopping before any change."
        echo "         The app is restarted on the current version. Fix the backup, or"
        echo "         re-run with --no-backup if you have another backup."
        docker compose -f docker-compose.cat.yml start cat-app 2>/dev/null || true
        exit 1
    fi
else
    echo ""
    echo "[Step 2/7] Backup skipped (--no-backup)"
fi

# =============================================================================
# Step 3: Stop only the CAT app container (leave Oracle running)
# =============================================================================
echo ""
echo "[Step 3/7] Stopping CAT app container (Oracle stays running)..."
cd "$CAT_INSTALL_DIR"

docker compose -f docker-compose.cat.yml stop cat-app 2>/dev/null || true
docker compose -f docker-compose.cat.yml rm -f cat-app 2>/dev/null || true
echo "  ✓ cat-app stopped"

# Confirm Oracle is still up
ORACLE_RUNNING=$(docker inspect -f '{{.State.Running}}' database-oracle-free 2>/dev/null || echo "false")
if [ "$ORACLE_RUNNING" = "true" ]; then
    echo "  ✓ Oracle container still running (data preserved)"
else
    echo "  ⚠️  Oracle is not running. It will be started in Step 6."
fi

# =============================================================================
# Step 4: Pull latest code
# =============================================================================
echo ""
echo "[Step 4/7] Pulling latest code from branch: $CAT_BRANCH..."

if [ "$SCRIPT_DIR" = "$CAT_INSTALL_DIR" ]; then
    # Running from inside the git repo — pull in place
    if [ -d "$CAT_INSTALL_DIR/.git" ]; then
        echo "  In-place git repo detected, pulling..."
        sudo -u "$ACTUAL_USER" git -C "$CAT_INSTALL_DIR" fetch origin
        sudo -u "$ACTUAL_USER" git -C "$CAT_INSTALL_DIR" checkout "$CAT_BRANCH"
        sudo -u "$ACTUAL_USER" git -C "$CAT_INSTALL_DIR" pull origin "$CAT_BRANCH"
        echo "  ✓ Pulled latest from origin/$CAT_BRANCH"
    else
        echo "  In-place deployment has no .git metadata; cloning current source..."
        TMP_CLONE_DIR=$(mktemp -d)
        trap 'rm -rf "$TMP_CLONE_DIR"' EXIT
        sudo -u "$ACTUAL_USER" git clone --depth 1 -b "$CAT_BRANCH" "$CAT_REPO_URL" "$TMP_CLONE_DIR/cat" || {
            echo "  ERROR: Failed to clone origin/$CAT_BRANCH"
            exit 1
        }
        echo "  Syncing cloned source into $CAT_INSTALL_DIR"
        copy_cat_source "$TMP_CLONE_DIR/cat" "$CAT_INSTALL_DIR" || {
            echo "  ERROR: Failed to sync cloned source"
            exit 1
        }
        rm -rf "$TMP_CLONE_DIR"
        trap - EXIT
        echo "  ✓ Deployed latest origin/$CAT_BRANCH"
    fi
elif [ -f "$SCRIPT_DIR/docker-compose.cat.yml" ]; then
    # Running the updater from a local checkout — rsync to install dir
    echo "  Syncing from local source: $SCRIPT_DIR → $CAT_INSTALL_DIR"
    echo "  (Preserving: .env, oracle-data, exports, backups, data)"
    copy_cat_source "$SCRIPT_DIR" "$CAT_INSTALL_DIR"
    echo "  ✓ Local source synced"
elif [ -d "$CAT_INSTALL_DIR/.git" ]; then
    # Standard install: pull into the deployment dir
    echo "  Fetching latest from origin/$CAT_BRANCH..."
    sudo -u "$ACTUAL_USER" git -C "$CAT_INSTALL_DIR" fetch origin
    sudo -u "$ACTUAL_USER" git -C "$CAT_INSTALL_DIR" checkout "$CAT_BRANCH"
    sudo -u "$ACTUAL_USER" git -C "$CAT_INSTALL_DIR" pull origin "$CAT_BRANCH"
    echo "  ✓ Pulled latest from origin/$CAT_BRANCH"
    # Show what changed
    CHANGES=$(git -C "$CAT_INSTALL_DIR" log --oneline HEAD@{1}..HEAD 2>/dev/null | head -10 || echo "")
    if [ -n "$CHANGES" ]; then
        echo ""
        echo "  📋 Recent commits:"
        echo "$CHANGES" | sed 's/^/      /'
        echo ""
    fi
else
    echo "  ERROR: Cannot determine code source."
    echo "         No .git repo at $CAT_INSTALL_DIR and updater is not inside a CAT source tree."
    echo "         Re-run install_cat.sh to reinstall, or pull manually."
    exit 1
fi

# =============================================================================
# Step 5: Rebuild the CAT app Docker image
# =============================================================================
echo ""
echo "[Step 5/7] Rebuilding CAT app Docker image..."
cd "$CAT_INSTALL_DIR"

BUILD_FLAGS=""
if [ "$FORCE_REBUILD" = true ]; then
    echo "  --force-rebuild: busting Docker layer cache..."
    BUILD_FLAGS="--no-cache"
fi

# Only rebuild the cat-app service (Oracle uses a pulled image, no build needed)
docker compose -f docker-compose.cat.yml build $BUILD_FLAGS cat-app || {
    echo "  ERROR: Docker build failed"
    echo "  Tip: check Dockerfile and requirements.txt for errors"
    exit 1
}
echo "  ✓ Docker image rebuilt"

# =============================================================================
# Step 6: Start services
# =============================================================================
echo ""
echo "[Step 6/7] Starting CAT services..."
cd "$CAT_INSTALL_DIR"

# If Oracle somehow stopped, bring it up first and wait for healthy
if [ "$ORACLE_RUNNING" != "true" ]; then
    echo "  Starting Oracle container..."
    docker compose -f docker-compose.cat.yml up -d database-oracle-free || {
        echo "  ERROR: Failed to start Oracle"
        exit 1
    }
    echo "  Waiting for Oracle to become healthy (may take a few minutes)..."
    if ! wait_for_container_health "database-oracle-free" 90 5; then
        echo "  ERROR: Oracle did not become healthy in time"
        docker compose -f docker-compose.cat.yml logs --tail=50 database-oracle-free
        exit 1
    fi
fi

# Start the (rebuilt) CAT app
docker compose -f docker-compose.cat.yml up -d cat-app || {
    echo "  ERROR: Failed to start CAT app"
    exit 1
}

echo "  Waiting for CAT app to become healthy..."
if ! wait_for_container_health "cat-app" 60 3; then
    echo "  ERROR: CAT app did not become healthy in time. Recent logs:"
    docker compose -f docker-compose.cat.yml logs --tail=50 cat-app
    exit 1
fi

# HTTP-level health check
APP_READY=false
for i in {1..30}; do
    if curl -sf "http://localhost:${CAT_HTTP_PORT}/health" >/dev/null 2>&1; then
        APP_READY=true
        break
    fi
    sleep 2
done

if [ "$APP_READY" = true ]; then
    echo "  ✓ CAT app is responding on http://localhost:${CAT_HTTP_PORT}"
    # Fetch and display version info
    VERSION_JSON=$(curl -sf "http://localhost:${CAT_HTTP_PORT}/api/version" 2>/dev/null || echo "")
    if [ -n "$VERSION_JSON" ]; then
        APP_VER=$(echo "$VERSION_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('app_version','?'))" 2>/dev/null || echo "?")
        SCHEMA_VER=$(echo "$VERSION_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('schema_version','?'))" 2>/dev/null || echo "?")
        echo "  ✓ Version: app=v${APP_VER}  schema=${SCHEMA_VER}"
    fi
else
    echo "  ⚠️  CAT health endpoint not reachable yet."
    echo "     Check with: $CAT_INSTALL_DIR/cat-status.sh"
fi

# =============================================================================
# Step 7: Summary
# =============================================================================
echo ""
echo "[Step 7/7] Update complete!"
echo ""
echo "=============================================="
echo " CAT Update Summary"
echo "=============================================="
echo ""
echo "  Branch:        $CAT_BRANCH"
echo "  Install dir:   $CAT_INSTALL_DIR"
echo "  Force rebuild: $FORCE_REBUILD"
echo ""
echo "  Container status:"
docker compose -f docker-compose.cat.yml ps
echo ""
echo "  Access CAT at: http://localhost:${CAT_HTTP_PORT}"
echo ""
echo "  Management scripts:"
echo "    Logs:        $CAT_INSTALL_DIR/cat-logs.sh"
echo "    Status:      $CAT_INSTALL_DIR/cat-status.sh"
echo "    Diagnostics: $CAT_INSTALL_DIR/cat-diagnostics.sh"
echo "=============================================="
