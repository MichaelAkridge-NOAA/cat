#!/usr/bin/env bash
# =============================================================================
# Install/remove a cron schedule for scripts/backup_to_gcs.sh
# =============================================================================
#
# scripts/backup_to_gcs.sh already does the actual backup (Oracle Data Pump
# export + gsutil upload to GCS) but has to be run by hand. This script
# registers (or removes) a crontab entry for the CURRENT user that runs it
# unattended on a schedule, with output logged to a file.
#
# Requirements for UNATTENDED runs (cron has no TTY to prompt you):
#   - .env must have ORACLE_PASSWORD set (backup_to_gcs.sh reads it from
#     there; if it's missing, the script would normally prompt interactively
#     — under cron that prompt just reads EOF and the run fails cleanly with
#     "Password cannot be empty", which will show up in the log file and,
#     if your system mails cron job stderr, in your inbox).
#   - gsutil must be authenticated for the user whose crontab this installs
#     into (run `gcloud auth login` / `gcloud auth application-default
#     login` as that user first — see backup_to_gcs.sh's own pre-flight
#     check, which this inherits).
#   - Docker (and the CAT stack) must be running at the scheduled time —
#     backup_to_gcs.sh checks for the Oracle container and exits with an
#     error (logged, not fatal to the host) if it isn't.
#
# Usage:
#   # Install a daily 02:00 backup to the given bucket (edit as needed)
#   ./scripts/schedule_backup_cron.sh install -b gs://my-bucket
#
#   # Install with a custom cron schedule (5-field cron syntax)
#   ./scripts/schedule_backup_cron.sh install -b gs://my-bucket --cron "0 3 * * 0"
#
#   # Show the crontab line this would install, without installing it
#   ./scripts/schedule_backup_cron.sh install -b gs://my-bucket --dry-run
#
#   # Remove the scheduled backup
#   ./scripts/schedule_backup_cron.sh uninstall
#
#   # Show current status (installed? what schedule? last log lines?)
#   ./scripts/schedule_backup_cron.sh status
#
# This script only ever touches ONE crontab line, tagged with a unique
# marker comment (# cat-backup-cron), so re-running install replaces just
# that line and uninstall only removes that line — nothing else in your
# crontab is touched.
# =============================================================================
set -euo pipefail

MARKER="# cat-backup-cron"
DEFAULT_CRON_SCHEDULE="0 2 * * *"   # daily at 02:00
GCS_BUCKET=""
CRON_SCHEDULE="$DEFAULT_CRON_SCHEDULE"
DRY_RUN=false
EXTRA_ARGS=()

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_SCRIPT="$SCRIPT_DIR/backup_to_gcs.sh"
LOG_FILE="$PROJECT_DIR/backups/cron_backup.log"

C_CYAN="\033[36m"; C_GREEN="\033[32m"; C_YELLOW="\033[33m"; C_RED="\033[31m"; C_RESET="\033[0m"
step() { echo -e "\n${C_CYAN}━━━ $* ━━━${C_RESET}"; }
ok()   { echo -e "  ${C_GREEN}✅ $*${C_RESET}"; }
warn() { echo -e "  ${C_YELLOW}⚠️  $*${C_RESET}"; }
err()  { echo -e "  ${C_RED}❌ $*${C_RESET}"; }

show_help() {
    echo "Usage: $0 {install|uninstall|status} [options]"
    echo ""
    echo "Options (install only):"
    echo "  -b, --bucket BUCKET   GCS bucket to pass through to backup_to_gcs.sh"
    echo "  --cron \"SCHEDULE\"     5-field cron schedule (default: \"$DEFAULT_CRON_SCHEDULE\" — daily 02:00)"
    echo "  --dry-run             Print the crontab line instead of installing it"
    echo "  -- ARGS...            Anything after -- is passed through to backup_to_gcs.sh as-is"
    echo "                        (e.g. --skip-oracle-data, --keep-local)"
    exit 0
}

CMD="${1:-}"; shift || true
case "$CMD" in
    install|uninstall|status) ;;
    -h|--help|"") show_help ;;
    *) err "Unknown command: $CMD"; echo "Use -h for help"; exit 1 ;;
esac

while [[ $# -gt 0 ]]; do
    case "$1" in
        -b|--bucket) GCS_BUCKET="$2"; shift 2 ;;
        --cron)      CRON_SCHEDULE="$2"; shift 2 ;;
        --dry-run)   DRY_RUN=true; shift ;;
        --)          shift; EXTRA_ARGS=("$@"); break ;;
        -h|--help)   show_help ;;
        *) err "Unknown option: $1"; echo "Use -h for help"; exit 1 ;;
    esac
done

build_command() {
    local cmd="$BACKUP_SCRIPT"
    if [[ -n "$GCS_BUCKET" ]]; then
        cmd="$cmd -b $GCS_BUCKET"
    fi
    for a in "${EXTRA_ARGS[@]:-}"; do
        [[ -n "$a" ]] && cmd="$cmd $a"
    done
    echo "$cmd"
}

case "$CMD" in
    install)
        if [[ ! -x "$BACKUP_SCRIPT" ]]; then
            err "$BACKUP_SCRIPT not found or not executable"
            exit 1
        fi

        BACKUP_CMD="$(build_command)"
        CRON_LINE="$CRON_SCHEDULE cd $PROJECT_DIR && $BACKUP_CMD >> $LOG_FILE 2>&1 $MARKER"

        step "Planned crontab entry"
        echo "  $CRON_LINE"

        if [[ "$DRY_RUN" == true ]]; then
            warn "DRY RUN — not installed"
            exit 0
        fi

        mkdir -p "$(dirname "$LOG_FILE")"

        # Replace any existing line carrying our marker, keep everything else.
        ( crontab -l 2>/dev/null | grep -vF "$MARKER" ; echo "$CRON_LINE" ) | crontab -
        ok "Installed. Backups will run on schedule \"$CRON_SCHEDULE\" and log to $LOG_FILE"
        echo "  Verify Oracle password + gsutil auth are set up for unattended runs (see script header)."
        ;;

    uninstall)
        if ! crontab -l 2>/dev/null | grep -qF "$MARKER"; then
            warn "No cat-backup-cron entry found — nothing to remove"
            exit 0
        fi
        ( crontab -l 2>/dev/null | grep -vF "$MARKER" ) | crontab -
        ok "Removed the scheduled backup cron entry"
        ;;

    status)
        step "Cron entry"
        if crontab -l 2>/dev/null | grep -F "$MARKER"; then
            :
        else
            warn "Not installed"
        fi
        step "Recent log output"
        if [[ -f "$LOG_FILE" ]]; then
            tail -n 30 "$LOG_FILE"
        else
            warn "No log file yet at $LOG_FILE (backup hasn't run)"
        fi
        ;;
esac
