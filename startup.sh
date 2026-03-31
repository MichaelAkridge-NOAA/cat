#!/bin/bash
# =============================================================================
# CAT Startup Script
# =============================================================================
# This script runs as the Docker container entrypoint:
# 1. Waits for Oracle database to be ready
# 2. Verifies CAT schema exists (created by Oracle init scripts)
# 3. Ingests reference data from CSV files (if not already loaded)
# 4. Starts the FastAPI application
# =============================================================================

set -e

echo "=============================================="
echo "CAT: Coral Annotation Tool - Startup"
echo "=============================================="

# =============================================================================
# Configuration
# =============================================================================
DB_HOST="${DB_HOST:-database-oracle-free}"
DB_PORT="${DB_PORT:-1521}"
MAX_RETRIES=60
RETRY_INTERVAL=5

# =============================================================================
# Wait for Oracle Database
# =============================================================================
wait_for_oracle() {
    echo "[1/3] Waiting for Oracle database at ${DB_HOST}:${DB_PORT}..."
    
    retries=0
    while [ $retries -lt $MAX_RETRIES ]; do
        # Try to connect using Python
        if python -c "
from cat.db.oracle import test_connection
try:
    result = test_connection()
    if result.get('ok'):
        exit(0)
except Exception:
    pass
exit(1)
" 2>/dev/null; then
            echo "  ✓ Oracle database is ready!"
            return 0
        fi
        
        retries=$((retries + 1))
        echo "  Attempt $retries/$MAX_RETRIES - Database not ready, waiting ${RETRY_INTERVAL}s..."
        sleep $RETRY_INTERVAL
    done
    
    echo "  ✗ Failed to connect to database after $MAX_RETRIES attempts"
    return 1
}

# =============================================================================
# Verify Schema (created by Oracle init scripts)
# =============================================================================
verify_schema() {
    echo "[2/3] Verifying CAT schema..."
    
    python -c "
from cat.db.oracle import fetch_all

try:
    # Check if tables exist
    result = fetch_all('''
        SELECT table_name FROM user_tables 
        WHERE table_name LIKE 'CAT_%' 
        ORDER BY table_name
    ''')
    tables = [r['table_name'] for r in result]
    
    expected = ['CAT_ANNOTATIONS', 'CAT_ANNOTATION_SESSIONS', 'CAT_OVERLAY_FEATURES', 
                'CAT_OVERLAY_LAYERS', 'CAT_PROJECTS', 'CAT_PROJECT_ASSETS', 
                'CAT_SITES', 'CAT_SITE_VISITS']
    
    if len(tables) >= 6:
        print(f'  ✓ Schema verified: {len(tables)} tables found')
        for t in tables:
            print(f'    - {t}')
    else:
        print(f'  ⚠ Only {len(tables)} tables found, running bootstrap...')
        from cat.db.schema import bootstrap_schema
        bootstrap_schema()
        print('  ✓ Bootstrap complete')
except Exception as e:
    print(f'  ⚠ Schema check warning: {e}')
    print('  Attempting bootstrap...')
    try:
        from cat.db.schema import bootstrap_schema
        bootstrap_schema()
        print('  ✓ Bootstrap complete')
    except Exception as e2:
        print(f'  ⚠ Bootstrap warning: {e2}')
"
}

# =============================================================================
# Ingest Reference Data
# =============================================================================
ingest_reference_data() {
    echo "[3/3] Loading reference data..."

    python -c "
from cat.db.sites import seed_sites_from_csv, count_db_sites
try:
    existing = count_db_sites()
    result = seed_sites_from_csv()
    if existing == 0:
        print(f'  ✓ Reference data seeded: {result[\"sites_seeded\"]} sites, {result[\"visits_seeded\"]} visits')
    else:
        print(f'  ✓ Reference data refreshed (upsert): {result[\"sites_seeded\"]} sites, {result[\"visits_seeded\"]} visits')
except Exception as e:
    print(f'  ⚠ Reference data ingestion warning: {e}')
"
}

# =============================================================================
# Start Application
# =============================================================================
start_app() {
    echo ""
    echo "=============================================="
    echo "CAT is ready at http://0.0.0.0:${CAT_PORT:-8000}"
    echo "=============================================="
    echo ""
    
    # Start uvicorn - use cat.server:app as the entry point
    exec python -m uvicorn cat.server:app \
        --host "${CAT_HOST:-0.0.0.0}" \
        --port "${CAT_PORT:-8000}" \
        --proxy-headers \
        --forwarded-allow-ips='*'
}

# =============================================================================
# Main
# =============================================================================
main() {
    # Check CAT_MODE
    if [ "${CAT_MODE}" = "file" ]; then
        echo "Running in FILE mode - skipping database setup"
        start_app
        exit 0
    fi
    
    # Database mode
    echo "Running in DB mode"
    
    # Wait for database
    if ! wait_for_oracle; then
        echo "ERROR: Could not connect to database"
        exit 1
    fi
    
    # Verify schema (Oracle init scripts should have created tables)
    verify_schema
    
    # Load reference data from CSV files
    ingest_reference_data
    
    # Start application
    start_app
}

main "$@"
