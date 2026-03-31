-- =============================================================================
-- CAT Schema Initialization Script
-- Run as SYS on first container startup
-- =============================================================================
-- This script creates the CAT application user and grants necessary privileges.
-- The tables are created by 002_CAT_TABLES.sql
-- =============================================================================

ALTER SESSION SET CONTAINER=FREEPDB1;

-- Create CAT user (if not exists via APP_USER env var)
-- Note: If APP_USER is set in docker-compose, user is auto-created
-- This is a fallback in case manual setup is needed
DECLARE
    v_user_exists NUMBER;
BEGIN
    SELECT COUNT(*) INTO v_user_exists FROM dba_users WHERE username = 'CAT_USER';
    IF v_user_exists = 0 THEN
        EXECUTE IMMEDIATE 'CREATE USER cat_user IDENTIFIED BY "ChangeMe123" DEFAULT TABLESPACE USERS QUOTA UNLIMITED ON USERS';
        DBMS_OUTPUT.PUT_LINE('Created user CAT_USER');
    ELSE
        DBMS_OUTPUT.PUT_LINE('User CAT_USER already exists');
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        IF SQLCODE != -1920 THEN -- ORA-01920: user name conflicts
            RAISE;
        END IF;
END;
/

-- Grant privileges to CAT user
GRANT CONNECT, RESOURCE TO cat_user;
ALTER USER cat_user DEFAULT ROLE ALL;
GRANT CREATE TABLE TO cat_user;
GRANT CREATE VIEW TO cat_user;
GRANT CREATE SEQUENCE TO cat_user;
GRANT CREATE PROCEDURE TO cat_user;
GRANT CREATE TRIGGER TO cat_user;
GRANT UNLIMITED TABLESPACE TO cat_user;

COMMIT;

-- Verify
SELECT username, account_status, default_tablespace FROM dba_users WHERE username = 'CAT_USER';

PROMPT CAT user setup complete.
