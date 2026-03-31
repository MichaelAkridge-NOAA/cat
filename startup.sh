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
import os
import csv
from pathlib import Path

from cat.db.oracle import fetch_all, execute_many

REFERENCE_DIR = Path('/app/cat/data/reference')

def count_rows(table_name):
    try:
        result = fetch_all(f'SELECT COUNT(*) as cnt FROM {table_name}')
        return result[0]['cnt'] if result else 0
    except Exception:
        return 0

def ingest_sites():
    '''Ingest site_list.csv into cat_sites'''
    csv_path = REFERENCE_DIR / 'site_list.csv'
    if not csv_path.exists():
        print('  - site_list.csv not found, skipping')
        return
    
    existing = count_rows('cat_sites')
    if existing > 0:
        print(f'  - cat_sites: {existing} rows (already populated)')
        return
    
    with open(csv_path, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        rows = []
        for row in reader:
            rows.append({
                'site_name': row.get('SITE', row.get('site', row.get('site_name', ''))),
                'depth_bin': row.get('DEPTH_BIN', row.get('depth_bin', '')),
                'region': row.get('REGION', row.get('region', '')),
                'cog_uri': row.get('COG_URI', row.get('cog_uri', ''))
            })
        
        if rows:
            sql = '''
                INSERT INTO cat_sites (site_name, depth_bin, region, cog_uri)
                VALUES (:site_name, :depth_bin, :region, :cog_uri)
            '''
            execute_many(sql, rows)
            print(f'  - cat_sites: {len(rows)} rows ingested')

def ingest_site_visits():
    '''Ingest site_visit_info.csv into cat_site_visits'''
    csv_path = REFERENCE_DIR / 'site_visit_info.csv'
    if not csv_path.exists():
        print('  - site_visit_info.csv not found, skipping')
        return
    
    existing = count_rows('cat_site_visits')
    if existing > 0:
        print(f'  - cat_site_visits: {existing} rows (already populated)')
        return
    
    with open(csv_path, 'r', encoding='utf-8-sig') as f:
        # Skip the first row (sub-category headers)
        next(f)
        reader = csv.DictReader(f)
        rows = []
        for row in reader:
            # Get site name - column is 'Site' (capital S)
            site_name = row.get('Site', row.get('site', '')).strip()
            # Skip rows with empty site name
            if not site_name:
                continue
            rows.append({
                'site_name': site_name,
                'survey_date': row.get('Survey Date', row.get('survey_date', '')),
                'cruise_leg': row.get('Cruise Leg', row.get('cruise_leg', '')),
                'photographer': row.get('Photographer', row.get('photographer', '')),
                'team': row.get('Team', row.get('team', '')),
                'region': row.get('Region', row.get('region', '')),
                'island': row.get('Island', row.get('island', '')),
                'sector': row.get('Sector', row.get('sector', '')),
                'latitude': float(row.get('Lat (N)', 0) or 0) if row.get('Lat (N)') else None,
                'longitude': float(row.get('Long (E)', 0) or 0) if row.get('Long (E)') else None,
                'survey_type': row.get('Survey Type', row.get('survey_type', '')),
                'notes': row.get('Notes', row.get('notes', ''))
            })
        
        if rows:
            sql = '''
                INSERT INTO cat_site_visits 
                (site_name, survey_date, cruise_leg, photographer, team, 
                 region, island, sector, latitude, longitude, survey_type, notes)
                VALUES 
                (:site_name, :survey_date, :cruise_leg, :photographer, :team,
                 :region, :island, :sector, :latitude, :longitude, :survey_type, :notes)
            '''
            execute_many(sql, rows)
            print(f'  - cat_site_visits: {len(rows)} rows ingested')

try:
    ingest_sites()
    ingest_site_visits()
    print('  ✓ Reference data ready')
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
