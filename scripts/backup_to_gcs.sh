#!/usr/bin/env bash
# =============================================================================
# CAT Database & Config Backup to Google Cloud Storage
# =============================================================================
#
# Creates a timestamped backup containing:
#   1. Oracle Data Pump export (.dmp) of the app schema
#   2. Oracle raw data files (./oracle-data)
#   3. Configuration & init scripts
#   4. Reference CSV data
#
# Then uploads to a GCS bucket:
#   gs://<BUCKET>/cat-backups/<yyyy-mm-dd_HHMMSS>/
#
# Prerequisites:
#   - Docker running with Oracle container healthy
#   - Google Cloud SDK (gsutil / gcloud) installed & authenticated
#     (pre-installed on GCP Workstations)
#
# Usage:
#   # Full backup + upload to GCS
#   ./scripts/backup_to_gcs.sh -b gs://my-bucket
#
#   # Local-only backup (no GCS upload)
#   ./scripts/backup_to_gcs.sh --local-only
#
#   # Skip copying raw oracle-data (just schema export + configs)
#   ./scripts/backup_to_gcs.sh -b gs://my-bucket --skip-oracle-data
#
#   # Skip Oracle Data Pump schema export (raw oracle-data + configs only)
#   ./scripts/backup_to_gcs.sh -b gs://my-bucket --skip-schema-export
#
#   # Keep local backup after GCS upload (default: remove after upload)
#   ./scripts/backup_to_gcs.sh -b gs://my-bucket --keep-local
#
#   # Custom local backup root
#   ./scripts/backup_to_gcs.sh -b gs://my-bucket --backup-root /tmp/backups
#
#   # Dry run (show plan, do nothing)
#   ./scripts/backup_to_gcs.sh -b gs://my-bucket --dry-run
#
# Restore:
#   # 1. Download from GCS
#   gsutil -m cp -r gs://my-bucket/cat-backups/2026-03-30_143000 ./restore
#
#   # 2. Import schema dump into Oracle container
#   docker cp ./restore/oracle-export/cat_export.dmp database-oracle-free:/tmp/cat_backup/
#   docker exec database-oracle-free bash -c \
#     "impdp system/\$ORACLE_PWD@FREEPDB1 \
#        schemas=GISDAT directory=CAT_BACKUP_DIR \
#        dumpfile=cat_export.dmp logfile=cat_import.log \
#        table_exists_action=replace"
#
# =============================================================================
set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────
ORACLE_CONTAINER="database-oracle-free"
CAT_CONTAINER="cat-app"
SCHEMA_NAME=""                   # resolved from .env APP_SCHEMA_NAME or default CAT_USER
DB_SERVICE="FREEPDB1"

# ─── Defaults ────────────────────────────────────────────────────────────────
GCS_BUCKET="gs://nmfs-dev-uc1-pifsc"
GCS_PREFIX="_backup/cat"
BACKUP_ROOT=""
SKIP_GCS=false
SKIP_ORA_DATA=false
SKIP_SCHEMA_EXPORT=false
KEEP_LOCAL=false
DRY_RUN=false

# ─── Colors / helpers ────────────────────────────────────────────────────────
C_CYAN="\033[36m"; C_GREEN="\033[32m"; C_YELLOW="\033[33m"; C_RED="\033[31m"; C_GRAY="\033[90m"; C_RESET="\033[0m"
step()  { echo -e "\n${C_CYAN}━━━ $* ━━━${C_RESET}"; }
ok()    { echo -e "  ${C_GREEN}✅ $*${C_RESET}"; }
warn()  { echo -e "  ${C_YELLOW}⚠️  $*${C_RESET}"; }
err()   { echo -e "  ${C_RED}❌ $*${C_RESET}"; }
info()  { echo -e "  ${C_GRAY}ℹ️  $*${C_RESET}"; }

run_gsutil() {
    if [[ -n "${SUDO_USER:-}" ]]; then
        local sudo_home
        sudo_home=$(eval echo "~${SUDO_USER}")

        if [[ -d "$sudo_home/.config/gcloud" ]]; then
            HOME="$sudo_home" CLOUDSDK_CONFIG="$sudo_home/.config/gcloud" gsutil "$@"
            return $?
        fi

        warn "Running under sudo without a detected user Cloud SDK config; gsutil may use root or metadata credentials."
    fi

    gsutil "$@"
}

# ─── Parse arguments ─────────────────────────────────────────────────────────
show_help() {
    echo "Usage: $0 [options]"
    echo ""
    echo "Options:"
    echo "  -b, --bucket BUCKET       GCS bucket (e.g. gs://my-bucket)"
    echo "  -p, --prefix PREFIX       GCS prefix (default: cat-backups)"
    echo "  --backup-root DIR         Local backup root (default: ./backups)"
    echo "  --local-only              Skip GCS upload, keep backup locally"
    echo "  --skip-oracle-data        Skip copying raw oracle-data folder"
    echo "  --skip-schema-export      Skip Oracle Data Pump schema export"
    echo "  --keep-local              Keep local backup after GCS upload"
    echo "  --dry-run                 Show plan without executing"
    echo "  -h, --help                Show this help"
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -b|--bucket)        GCS_BUCKET="$2"; shift 2 ;;
        -p|--prefix)        GCS_PREFIX="$2"; shift 2 ;;
        --backup-root)      BACKUP_ROOT="$2"; shift 2 ;;
        --local-only)       SKIP_GCS=true; shift ;;
        --skip-oracle-data) SKIP_ORA_DATA=true; shift ;;
        --skip-schema-export) SKIP_SCHEMA_EXPORT=true; shift ;;
        --keep-local)       KEEP_LOCAL=true; shift ;;
        --dry-run)          DRY_RUN=true; shift ;;
        -h|--help)          show_help ;;
        *) err "Unknown option: $1"; echo "Use -h for help"; exit 1 ;;
    esac
done

# ─── Resolve project root ───────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ ! -f "$PROJECT_DIR/docker-compose.cat.yml" ]]; then
    PROJECT_DIR="$(pwd)"
fi

if [[ -z "$BACKUP_ROOT" ]]; then
    BACKUP_ROOT="$PROJECT_DIR/backups"
fi

# ─── Pre-flight checks ──────────────────────────────────────────────────────
step "Pre-flight checks"

# Docker
if ! command -v docker &>/dev/null; then
    err "Docker not found in PATH"; exit 1
fi

# Oracle container running?
ORA_STATUS=$(docker inspect -f '{{.State.Health.Status}}' "$ORACLE_CONTAINER" 2>/dev/null || true)
if [[ -z "$ORA_STATUS" ]]; then
    err "Oracle container '$ORACLE_CONTAINER' not found or not running"; exit 1
fi
if [[ "$ORA_STATUS" != "healthy" ]]; then
    warn "Oracle container status: $ORA_STATUS (proceeding anyway)"
else
    ok "Oracle container healthy"
fi

# gsutil (only needed when uploading)
if [[ "$SKIP_GCS" == false ]]; then
    if [[ -z "$GCS_BUCKET" ]]; then
        err "GCS bucket required. Use -b gs://... or --local-only"
        exit 1
    fi
    if ! command -v gsutil &>/dev/null; then
        err "gsutil not found. Install Google Cloud SDK or run on a GCP Workstation."
        exit 1
    fi
    ok "gsutil available"

    if [[ -n "${SUDO_USER:-}" ]]; then
        SUDO_HOME=$(eval echo "~${SUDO_USER}")
        if [[ -d "$SUDO_HOME/.config/gcloud" ]]; then
            info "Using Cloud SDK credentials from $SUDO_HOME/.config/gcloud"
        else
            warn "No Cloud SDK config found for $SUDO_USER at $SUDO_HOME/.config/gcloud"
        fi
    fi

    if ! run_gsutil ls "$GCS_BUCKET" >/dev/null 2>&1; then
        err "Cannot access $GCS_BUCKET with current credentials."
        err "Run: gcloud auth login ; gcloud auth application-default login"
        exit 1
    fi
    ok "GCS bucket access verified"
fi

# Read Oracle password from .env
ORACLE_PASSWORD=""
ENV_FILE="$PROJECT_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
    info "Reading .env file"
    # Source only ORACLE_PASSWORD (strip quotes)
    ORACLE_PASSWORD=$(grep -E '^\s*ORACLE_PASSWORD\s*=' "$ENV_FILE" | head -1 | sed "s/.*=\s*//" | tr -d "\"'")
fi
if [[ -z "$ORACLE_PASSWORD" ]]; then
    echo -n "  Enter ORACLE_PASSWORD (SYSTEM user): "
    read -rs ORACLE_PASSWORD
    echo ""
    if [[ -z "$ORACLE_PASSWORD" ]]; then
        err "Password cannot be empty"; exit 1
    fi
fi
ok "Oracle password loaded"

# Resolve schema name from .env APP_SCHEMA_NAME (fallback: CAT_USER)
if [[ -z "$SCHEMA_NAME" ]]; then
    if [[ -f "$ENV_FILE" ]]; then
        SCHEMA_NAME=$(grep -E '^\s*APP_SCHEMA_NAME\s*=' "$ENV_FILE" | head -1 | sed "s/.*=\s*//" | tr -d "\"'" | tr '[:lower:]' '[:upper:]')
    fi
    if [[ -z "$SCHEMA_NAME" ]]; then
        SCHEMA_NAME="CAT_USER"
    fi
fi
info "Schema name  : $SCHEMA_NAME"

# ─── Timestamp & paths ──────────────────────────────────────────────────────
TIMESTAMP=$(date +"%Y-%m-%d_%H%M%S")
BACKUP_DIR="$BACKUP_ROOT/$TIMESTAMP"

step "Backup plan"
info "Timestamp  : $TIMESTAMP"
info "Local path : $BACKUP_DIR"
if [[ "$SKIP_GCS" == false ]]; then
    GCS_DEST="$GCS_BUCKET/$GCS_PREFIX/$TIMESTAMP"
    info "GCS dest   : $GCS_DEST/"
fi

if [[ "$DRY_RUN" == true ]]; then
    warn "DRY RUN — exiting without making changes"
    exit 0
fi

# ─── Create local backup folder structure ────────────────────────────────────
step "Creating backup directory"
mkdir -p "$BACKUP_DIR/oracle-export"
mkdir -p "$BACKUP_DIR/config/db-init"
mkdir -p "$BACKUP_DIR/reference"
ok "Created $BACKUP_DIR"

# ─── 1. Oracle Data Pump Export ──────────────────────────────────────────────
if [[ "$SKIP_SCHEMA_EXPORT" == false ]]; then
    step "1/4  Oracle schema export (Data Pump)"

    info "Creating export directory in Oracle container..."
    docker exec "$ORACLE_CONTAINER" bash -c "mkdir -p /tmp/cat_backup" 2>/dev/null || true

    # Create directory object + grant to target schema
    docker exec -i "$ORACLE_CONTAINER" bash -c "sqlplus -s system/${ORACLE_PASSWORD}@${DB_SERVICE}" <<EOSQL >/dev/null 2>&1 || true
WHENEVER SQLERROR CONTINUE
CREATE OR REPLACE DIRECTORY cat_backup_dir AS '/tmp/cat_backup';
GRANT READ, WRITE ON DIRECTORY cat_backup_dir TO ${SCHEMA_NAME};
EXIT;
EOSQL

    info "Running expdp for schema $SCHEMA_NAME ..."
    EXPDP_CMD="expdp system/${ORACLE_PASSWORD}@${DB_SERVICE} schemas=${SCHEMA_NAME} directory=CAT_BACKUP_DIR dumpfile=cat_export.dmp logfile=cat_export.log REUSE_DUMPFILES=YES"

    set +e
    EXPDP_OUTPUT=$(docker exec "$ORACLE_CONTAINER" bash -c "$EXPDP_CMD" 2>&1)
    EXPDP_RC=$?
    set -e

    # Copy dump + log out of container
    docker cp "$ORACLE_CONTAINER:/tmp/cat_backup/cat_export.dmp" "$BACKUP_DIR/oracle-export/" 2>/dev/null || true
    docker cp "$ORACLE_CONTAINER:/tmp/cat_backup/cat_export.log" "$BACKUP_DIR/oracle-export/" 2>/dev/null || true

    # Save raw output for troubleshooting
    echo "$EXPDP_OUTPUT" > "$BACKUP_DIR/oracle-export/expdp_output.txt"

    if [[ $EXPDP_RC -eq 0 ]] && [[ -f "$BACKUP_DIR/oracle-export/cat_export.dmp" ]]; then
        DMP_SIZE=$(du -h "$BACKUP_DIR/oracle-export/cat_export.dmp" | cut -f1)
        ok "Schema export complete ($DMP_SIZE)"
    elif [[ -f "$BACKUP_DIR/oracle-export/cat_export.dmp" ]]; then
        DMP_SIZE=$(du -h "$BACKUP_DIR/oracle-export/cat_export.dmp" | cut -f1)
        warn "expdp returned code $EXPDP_RC but dump exists ($DMP_SIZE) — check log"
    else
        warn "expdp failed (code $EXPDP_RC) — check oracle-export/expdp_output.txt"
        warn "Continuing because raw oracle-data backup may still be sufficient for full-instance restore."
    fi
else
    step "1/4  Skipping schema export (--skip-schema-export)"
fi

# ─── 2. Raw Oracle data files ───────────────────────────────────────────────
if [[ "$SKIP_ORA_DATA" == false ]]; then
    step "2/4  Copying oracle-data (raw datafiles)"
    ORA_DATA_SRC="$PROJECT_DIR/oracle-data"

    # Fallback: check sibling of project dir (common on GCP Workstations)
    if [[ ! -d "$ORA_DATA_SRC" && -d "$(dirname "$PROJECT_DIR")/oracle-data" ]]; then
        ORA_DATA_SRC="$(dirname "$PROJECT_DIR")/oracle-data"
        info "Using fallback oracle-data path: $ORA_DATA_SRC"
    fi

    if [[ -d "$ORA_DATA_SRC" ]]; then
        info "Source: $ORA_DATA_SRC"
        info "This may take a while for large databases..."

        rsync -a --info=progress2 "$ORA_DATA_SRC/" "$BACKUP_DIR/oracle-data/" 2>/dev/null \
            || cp -a "$ORA_DATA_SRC" "$BACKUP_DIR/oracle-data"

        FOLDER_SIZE=$(du -sh "$BACKUP_DIR/oracle-data" | cut -f1)
        ok "oracle-data copied ($FOLDER_SIZE)"
    else
        warn "oracle-data folder not found at $ORA_DATA_SRC — skipping"
    fi
else
    step "2/4  Skipping oracle-data (--skip-oracle-data)"
fi

# ─── 3. Configuration & init scripts ────────────────────────────────────────
step "3/4  Backing up configuration files"

CONFIG_FILES=(
    "docker-compose.cat.yml"
    "Dockerfile"
    "requirements.txt"
    ".env"
    "cat/config.yaml"
    "cat/db/schema.py"
)

for f in "${CONFIG_FILES[@]}"; do
    src="$PROJECT_DIR/$f"
    if [[ -f "$src" ]]; then
        cp "$src" "$BACKUP_DIR/config/$(basename "$f")"
        ok "  $f"
    fi
done

# DB init scripts
INIT_SRC="$PROJECT_DIR/scripts/db-init"
if [[ -d "$INIT_SRC" ]]; then
    cp -a "$INIT_SRC/"* "$BACKUP_DIR/config/db-init/" 2>/dev/null || true
    ok "  scripts/db-init/"
fi

# Reference CSVs
REF_SRC="$PROJECT_DIR/cat/data/reference"
if [[ -d "$REF_SRC" ]]; then
    cp "$REF_SRC"/*.csv "$BACKUP_DIR/reference/" 2>/dev/null || true
    CSV_COUNT=$(find "$BACKUP_DIR/reference" -name "*.csv" | wc -l | tr -d ' ')
    ok "  $CSV_COUNT reference CSV files"
fi

# ─── Write backup manifest ──────────────────────────────────────────────────
ORA_IMAGE=$(docker inspect -f '{{.Config.Image}}' "$ORACLE_CONTAINER" 2>/dev/null || echo "unknown")
CAT_IMAGE=$(docker inspect -f '{{.Config.Image}}' "$CAT_CONTAINER" 2>/dev/null || echo "unknown")

cat > "$BACKUP_DIR/backup_manifest.json" <<EOF
{
  "timestamp": "$TIMESTAMP",
  "created": "$(date -Iseconds)",
  "hostname": "$(hostname)",
  "schema": "$SCHEMA_NAME",
  "oracle_image": "$ORA_IMAGE",
  "cat_image": "$CAT_IMAGE",
  "skip_oracle_data": $SKIP_ORA_DATA
}
EOF
ok "Manifest written"

# ─── 4. Upload to GCS ───────────────────────────────────────────────────────
if [[ "$SKIP_GCS" == false ]]; then
    step "4/4  Uploading to Google Cloud Storage"
    info "Destination: $GCS_DEST/"

    if run_gsutil -m cp -r "$BACKUP_DIR" "$GCS_BUCKET/$GCS_PREFIX/"; then
        ok "Upload complete → $GCS_DEST/"

        if [[ "$KEEP_LOCAL" == false ]]; then
            info "Removing local backup (use --keep-local to keep)"
            rm -rf "$BACKUP_DIR"
            ok "Local backup removed"
        fi
    else
        err "gsutil upload failed — local backup preserved at $BACKUP_DIR"
    fi
else
    step "4/4  Skipping GCS upload (--local-only)"
    info "Backup saved locally: $BACKUP_DIR"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${C_CYAN}═══════════════════════════════════════════${C_RESET}"
echo -e "${C_CYAN}  Backup complete: $TIMESTAMP${C_RESET}"
if [[ -d "$BACKUP_DIR" ]]; then
    TOTAL_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)
    echo -e "${C_CYAN}  Local size: $TOTAL_SIZE${C_RESET}"
    echo -e "${C_CYAN}  Path: $BACKUP_DIR${C_RESET}"
fi
if [[ "$SKIP_GCS" == false ]]; then
    echo -e "${C_CYAN}  GCS:  $GCS_DEST/${C_RESET}"
fi
echo -e "${C_CYAN}═══════════════════════════════════════════${C_RESET}"
echo ""
