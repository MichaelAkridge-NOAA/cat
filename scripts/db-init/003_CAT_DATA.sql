-- =============================================================================
-- CAT Reference Data
-- Run as SYS on first container startup
-- =============================================================================
-- This script inserts sample/default reference data
-- The actual data will be loaded from CSV files by the CAT application
-- =============================================================================

ALTER SESSION SET CONTAINER=FREEPDB1;
ALTER SESSION SET CURRENT_SCHEMA = cat_user;

PROMPT CAT reference data initialization complete.
PROMPT Note: Full reference data (sites, visits) will be loaded by CAT application on startup.

COMMIT;
