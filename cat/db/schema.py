"""Oracle schema bootstrap for CAT."""

from typing import List

from .oracle import execute


DDL_BLOCKS: List[str] = [
    """
    BEGIN
        EXECUTE IMMEDIATE q'[
            CREATE TABLE cat_projects (
                project_id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                project_name VARCHAR2(255) NOT NULL,
                site VARCHAR2(120),
                cruise VARCHAR2(120),
                year_num NUMBER,
                region VARCHAR2(120),
                observer_name VARCHAR2(120),
                notes VARCHAR2(2000),
                metadata_json CLOB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT uq_cat_projects_name UNIQUE (project_name)
            )
        ]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN
                RAISE;
            END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE q'[
            CREATE TABLE cat_project_assets (
                asset_id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                project_id NUMBER NOT NULL,
                asset_type VARCHAR2(30) DEFAULT 'COG' NOT NULL,
                asset_name VARCHAR2(255) NOT NULL,
                cog_url VARCHAR2(4000) NOT NULL,
                source_uri VARCHAR2(4000),
                source_epsg NUMBER,
                target_epsg NUMBER,
                bounds_json CLOB,
                is_active NUMBER(1) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT fk_cat_assets_project
                    FOREIGN KEY (project_id)
                    REFERENCES cat_projects(project_id)
                    ON DELETE CASCADE
            )
        ]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN
                RAISE;
            END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE q'[
            CREATE TABLE cat_annotations (
                annotation_id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                project_id NUMBER NOT NULL,
                asset_id NUMBER,
                feature_geojson CLOB NOT NULL,
                properties_json CLOB,
                created_by VARCHAR2(120),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                version NUMBER DEFAULT 1,
                deleted_at TIMESTAMP,
                CONSTRAINT fk_cat_annotations_project
                    FOREIGN KEY (project_id)
                    REFERENCES cat_projects(project_id)
                    ON DELETE CASCADE,
                CONSTRAINT fk_cat_annotations_asset
                    FOREIGN KEY (asset_id)
                    REFERENCES cat_project_assets(asset_id)
                    ON DELETE SET NULL
            )
        ]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN
                RAISE;
            END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE q'[
            CREATE TABLE cat_annotation_sessions (
                session_id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                project_id NUMBER NOT NULL,
                username VARCHAR2(120) NOT NULL,
                start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                end_time TIMESTAMP,
                total_seconds NUMBER DEFAULT 0,
                annotation_count NUMBER DEFAULT 0,
                is_active NUMBER(1) DEFAULT 1,
                last_heartbeat TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT fk_cat_sessions_project
                    FOREIGN KEY (project_id)
                    REFERENCES cat_projects(project_id)
                    ON DELETE CASCADE
            )
        ]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN
                RAISE;
            END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE q'[
            CREATE TABLE cat_overlay_layers (
                layer_id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                project_id NUMBER NOT NULL,
                layer_name VARCHAR2(255) NOT NULL,
                source_uri VARCHAR2(4000),
                source_epsg NUMBER,
                target_epsg NUMBER,
                style_json CLOB,
                is_active NUMBER(1) DEFAULT 1 NOT NULL,
                display_order NUMBER DEFAULT 0 NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT fk_cat_layers_project
                    FOREIGN KEY (project_id)
                    REFERENCES cat_projects(project_id)
                    ON DELETE CASCADE
            )
        ]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN
                RAISE;
            END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE q'[
            CREATE TABLE cat_overlay_features (
                feature_id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                layer_id NUMBER NOT NULL,
                feature_geojson CLOB NOT NULL,
                properties_json CLOB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT fk_cat_features_layer
                    FOREIGN KEY (layer_id)
                    REFERENCES cat_overlay_layers(layer_id)
                    ON DELETE CASCADE
            )
        ]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN
                RAISE;
            END IF;
    END;
    """,
    # -----------------------------------------------------------------
    # Site reference tables
    # -----------------------------------------------------------------
    """
    BEGIN
        EXECUTE IMMEDIATE q'[
            CREATE TABLE cat_sites (
                site_id   NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                site_name VARCHAR2(120) NOT NULL,
                depth_bin VARCHAR2(10),
                region    VARCHAR2(50),
                cog_uri   VARCHAR2(4000),
                CONSTRAINT uq_cat_sites_name UNIQUE (site_name)
            )
        ]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN
                RAISE;
            END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE q'[
            CREATE TABLE cat_site_visits (
                visit_id          NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                site_name         VARCHAR2(120) NOT NULL,
                mission_id        VARCHAR2(120),
                occ_site_id       VARCHAR2(120),
                survey_date       VARCHAR2(50),
                cruise_leg        VARCHAR2(120),
                photographer      VARCHAR2(120),
                team              VARCHAR2(120),
                camera_number     VARCHAR2(50),
                region            VARCHAR2(50),
                island            VARCHAR2(120),
                sector            VARCHAR2(120),
                reef_zone         VARCHAR2(120),
                depth_bin         VARCHAR2(10),
                survey_size       VARCHAR2(255),
                latitude          NUMBER,
                longitude         NUMBER,
                survey_type       VARCHAR2(120),
                total_images      VARCHAR2(255),
                notes             VARCHAR2(2000),
                processing_status VARCHAR2(120),
                color_correct     VARCHAR2(50),
                exposure_correct  VARCHAR2(50),
                mosaic_issues     VARCHAR2(2000),
                modeling_priority VARCHAR2(255),
                annotation_time   VARCHAR2(255),
                piclea_file_path  VARCHAR2(2000)
            )
        ]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN
                RAISE;
            END IF;
    END;
    """,
    # -----------------------------------------------------------------
    # Indexes
    # -----------------------------------------------------------------
    """
    BEGIN
        EXECUTE IMMEDIATE q'[CREATE INDEX idx_cat_assets_project ON cat_project_assets(project_id)]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN
                RAISE;
            END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE q'[CREATE INDEX idx_cat_annotations_project ON cat_annotations(project_id)]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN
                RAISE;
            END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE q'[CREATE INDEX idx_cat_layers_project ON cat_overlay_layers(project_id)]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN
                RAISE;
            END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE q'[CREATE INDEX idx_cat_site_visits_name ON cat_site_visits(site_name)]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN
                RAISE;
            END IF;
    END;
    """,
    # -----------------------------------------------------------------
    # Column migrations — safe to re-run; ORA-01430 = column already exists
    # -----------------------------------------------------------------
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_annotations ADD (version NUMBER DEFAULT 1)';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_annotations ADD (deleted_at TIMESTAMP)';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_annotation_sessions ADD (last_heartbeat TIMESTAMP DEFAULT CURRENT_TIMESTAMP)';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_site_visits ADD (mission_id VARCHAR2(120))';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_site_visits ADD (reef_zone VARCHAR2(120))';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_site_visits ADD (depth_bin VARCHAR2(10))';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_site_visits ADD (piclea_file_path VARCHAR2(2000))';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_site_visits ADD (occ_site_id VARCHAR2(120))';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_site_visits ADD (camera_number VARCHAR2(50))';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_site_visits ADD (processing_status VARCHAR2(120))';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_site_visits ADD (color_correct VARCHAR2(50))';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_site_visits ADD (exposure_correct VARCHAR2(50))';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_site_visits ADD (mosaic_issues VARCHAR2(2000))';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    # -----------------------------------------------------------------
    # User accounts + sessions
    # -----------------------------------------------------------------
    """
    BEGIN
        EXECUTE IMMEDIATE q'[
            CREATE TABLE cat_users (
                user_id       NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                username      VARCHAR2(120) NOT NULL,
                email         VARCHAR2(255) NOT NULL,
                password_hash VARCHAR2(255) NOT NULL,
                display_name  VARCHAR2(120),
                role          VARCHAR2(20) DEFAULT 'annotator' NOT NULL,
                is_active     NUMBER(1) DEFAULT 1 NOT NULL,
                preferences_json CLOB,
                created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login    TIMESTAMP,
                CONSTRAINT uq_cat_users_username UNIQUE (username),
                CONSTRAINT uq_cat_users_email UNIQUE (email),
                CONSTRAINT ck_cat_users_role CHECK (role IN ('admin', 'annotator'))
            )
        ]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE q'[
            CREATE TABLE cat_sessions (
                session_id   NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id      NUMBER NOT NULL,
                token_hash   VARCHAR2(64) NOT NULL,
                created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at   TIMESTAMP NOT NULL,
                last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT uq_cat_sessions_token UNIQUE (token_hash),
                CONSTRAINT fk_cat_sessions_user
                    FOREIGN KEY (user_id)
                    REFERENCES cat_users(user_id)
                    ON DELETE CASCADE
            )
        ]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE q'[CREATE INDEX idx_cat_sessions_expires ON cat_sessions(expires_at)]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN RAISE; END IF;
    END;
    """,
    # -----------------------------------------------------------------
    # Ownership columns on projects/annotations — safe to re-run;
    # ORA-01430 = column already exists
    # -----------------------------------------------------------------
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_projects ADD (owner_user_id NUMBER)';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_annotations ADD (created_by_user_id NUMBER)';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    # ORA-02275 = referential constraint already exists
    """
    BEGIN
        EXECUTE IMMEDIATE q'[
            ALTER TABLE cat_projects ADD CONSTRAINT fk_cat_projects_owner
                FOREIGN KEY (owner_user_id) REFERENCES cat_users(user_id) ON DELETE SET NULL
        ]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -2275 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE q'[
            ALTER TABLE cat_annotations ADD CONSTRAINT fk_cat_annotations_owner
                FOREIGN KEY (created_by_user_id) REFERENCES cat_users(user_id) ON DELETE SET NULL
        ]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -2275 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE q'[CREATE INDEX idx_cat_projects_owner ON cat_projects(owner_user_id)]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE q'[CREATE INDEX idx_cat_annotations_owner ON cat_annotations(created_by_user_id)]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN RAISE; END IF;
    END;
    """,
    # -----------------------------------------------------------------
    # Schema migrations tracking table
    # -----------------------------------------------------------------
    """
    BEGIN
        EXECUTE IMMEDIATE q'[
            CREATE TABLE cat_schema_migrations (
                migration_id  VARCHAR2(20) PRIMARY KEY,
                description   VARCHAR2(500) NOT NULL,
                applied_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN RAISE; END IF;
    END;
    """,
    # Record known migrations (MERGE = upsert, safe to re-run)
    """
    MERGE INTO cat_schema_migrations dst
    USING (SELECT '0001' AS mid, 'Baseline tables: projects, assets, annotations, sessions, overlay layers/features' AS descr FROM DUAL) src
    ON (dst.migration_id = src.mid)
    WHEN NOT MATCHED THEN INSERT (migration_id, description) VALUES (src.mid, src.descr)
    """,
    """
    MERGE INTO cat_schema_migrations dst
    USING (SELECT '0002' AS mid, 'Site reference tables: cat_sites, cat_site_visits, indexes' AS descr FROM DUAL) src
    ON (dst.migration_id = src.mid)
    WHEN NOT MATCHED THEN INSERT (migration_id, description) VALUES (src.mid, src.descr)
    """,
    """
    MERGE INTO cat_schema_migrations dst
    USING (SELECT '0003' AS mid, 'Column migrations: version+deleted_at on annotations, last_heartbeat on sessions' AS descr FROM DUAL) src
    ON (dst.migration_id = src.mid)
    WHEN NOT MATCHED THEN INSERT (migration_id, description) VALUES (src.mid, src.descr)
    """,
    """
    MERGE INTO cat_schema_migrations dst
    USING (SELECT '0004' AS mid, 'Coral species reference table (cat_coral_species)' AS descr FROM DUAL) src
    ON (dst.migration_id = src.mid)
    WHEN NOT MATCHED THEN INSERT (migration_id, description) VALUES (src.mid, src.descr)
    """,
    """
    MERGE INTO cat_schema_migrations dst
    USING (SELECT '0005' AS mid, 'Schema migrations tracking table (cat_schema_migrations)' AS descr FROM DUAL) src
    ON (dst.migration_id = src.mid)
    WHEN NOT MATCHED THEN INSERT (migration_id, description) VALUES (src.mid, src.descr)
    """,
    """
    MERGE INTO cat_schema_migrations dst
    USING (SELECT '0006' AS mid, 'User auth: cat_users, cat_sessions, ownership FKs on projects/annotations' AS descr FROM DUAL) src
    ON (dst.migration_id = src.mid)
    WHEN NOT MATCHED THEN INSERT (migration_id, description) VALUES (src.mid, src.descr)
    """,
    # -----------------------------------------------------------------
    # Scope project-name uniqueness per-owner instead of globally — now
    # that projects belong to users, two different users independently
    # surveying e.g. "AGR-472 2025 Survey" shouldn't collide on name.
    # ORA-02443 = constraint does not exist (guards the DROP for re-runs).
    # ORA-02261 = a unique/PK constraint on these columns already exists.
    # -----------------------------------------------------------------
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_projects DROP CONSTRAINT uq_cat_projects_name';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -2443 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE q'[
            ALTER TABLE cat_projects ADD CONSTRAINT uq_cat_projects_name_owner
                UNIQUE (project_name, owner_user_id)
        ]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -2261 THEN RAISE; END IF;
    END;
    """,
    """
    MERGE INTO cat_schema_migrations dst
    USING (SELECT '0007' AS mid, 'Scope project_name uniqueness to (project_name, owner_user_id) instead of globally' AS descr FROM DUAL) src
    ON (dst.migration_id = src.mid)
    WHEN NOT MATCHED THEN INSERT (migration_id, description) VALUES (src.mid, src.descr)
    """,
    # -----------------------------------------------------------------
    # Audit trail: who last modified a project/annotation, separate from
    # who created it (owner_user_id / created_by_user_id) and separate from
    # the domain fields observer_name (field diver) / created_by (analyst
    # free-text). created_at/updated_at already exist on both tables.
    # -----------------------------------------------------------------
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_projects ADD (last_mod_by_user_id NUMBER)';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_annotations ADD (last_mod_by_user_id NUMBER)';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE q'[
            ALTER TABLE cat_projects ADD CONSTRAINT fk_cat_projects_last_mod_by
                FOREIGN KEY (last_mod_by_user_id) REFERENCES cat_users(user_id) ON DELETE SET NULL
        ]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -2275 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE q'[
            ALTER TABLE cat_annotations ADD CONSTRAINT fk_cat_annotations_last_mod_by
                FOREIGN KEY (last_mod_by_user_id) REFERENCES cat_users(user_id) ON DELETE SET NULL
        ]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -2275 THEN RAISE; END IF;
    END;
    """,
    """
    MERGE INTO cat_schema_migrations dst
    USING (SELECT '0008' AS mid, 'Audit trail: last_mod_by_user_id on projects/annotations' AS descr FROM DUAL) src
    ON (dst.migration_id = src.mid)
    WHEN NOT MATCHED THEN INSERT (migration_id, description) VALUES (src.mid, src.descr)
    """,
    # -----------------------------------------------------------------
    # Fuller user profile fields for admin user management
    # -----------------------------------------------------------------
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_users ADD (first_name VARCHAR2(120))';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_users ADD (last_name VARCHAR2(120))';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_users ADD (initials VARCHAR2(10))';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    """
    MERGE INTO cat_schema_migrations dst
    USING (SELECT '0009' AS mid, 'User profile: first_name, last_name, initials on cat_users' AS descr FROM DUAL) src
    ON (dst.migration_id = src.mid)
    WHEN NOT MATCHED THEN INSERT (migration_id, description) VALUES (src.mid, src.descr)
    """,
    # -----------------------------------------------------------------
    # Coral species reference table
    # -----------------------------------------------------------------
    """
    BEGIN
        EXECUTE IMMEDIATE q'[
            CREATE TABLE cat_coral_species (
                species_id   NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                spcode       VARCHAR2(20)  NOT NULL,
                taxon_name   VARCHAR2(255),
                genus        VARCHAR2(120),
                family       VARCHAR2(120),
                class_name   VARCHAR2(120),
                comp_class   VARCHAR2(120),
                morphology_1 VARCHAR2(120),
                morphology_2 VARCHAR2(120),
                scientific_name VARCHAR2(512),
                gencode      VARCHAR2(20),
                samoa        VARCHAR2(10),
                marianas     VARCHAR2(10),
                hawaii       VARCHAR2(10),
                johnston     VARCHAR2(10),
                line_island  VARCHAR2(10),
                phoenix      VARCHAR2(10),
                wake         VARCHAR2(10),
                inactive_flag NUMBER(1) DEFAULT 0,
                adu_flag      NUMBER(1) DEFAULT 0,
                juv_flag      NUMBER(1) DEFAULT 0,
                CONSTRAINT uq_cat_coral_spcode UNIQUE (spcode)
            )
        ]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE q'[CREATE INDEX idx_cat_coral_species_genus ON cat_coral_species(genus)]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN RAISE; END IF;
    END;
    """,
    # -----------------------------------------------------------------
    # Tag overlay layers as transect/segment (vs generic imported overlays)
    # -----------------------------------------------------------------
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_overlay_layers ADD (layer_type VARCHAR2(30))';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    """
    MERGE INTO cat_schema_migrations dst
    USING (SELECT '0010' AS mid, 'Overlay layers: layer_type column for transect/segment tagging' AS descr FROM DUAL) src
    ON (dst.migration_id = src.mid)
    WHEN NOT MATCHED THEN INSERT (migration_id, description) VALUES (src.mid, src.descr)
    """,
    # -----------------------------------------------------------------
    # Per-project collaborator roles (owner stays cat_projects.owner_user_id;
    # this table adds editor/viewer collaborators) + a per-project activity log.
    # -----------------------------------------------------------------
    """
    BEGIN
        EXECUTE IMMEDIATE q'[
            CREATE TABLE cat_project_collaborators (
                collaborator_id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                project_id NUMBER NOT NULL,
                user_id NUMBER NOT NULL,
                role VARCHAR2(20) DEFAULT 'viewer' NOT NULL,
                added_by_user_id NUMBER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT fk_cat_collab_project
                    FOREIGN KEY (project_id)
                    REFERENCES cat_projects(project_id)
                    ON DELETE CASCADE,
                CONSTRAINT fk_cat_collab_user
                    FOREIGN KEY (user_id)
                    REFERENCES cat_users(user_id)
                    ON DELETE CASCADE,
                CONSTRAINT ck_cat_collab_role CHECK (role IN ('editor', 'viewer')),
                CONSTRAINT uq_cat_collab_project_user UNIQUE (project_id, user_id)
            )
        ]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE q'[CREATE INDEX idx_cat_collab_project ON cat_project_collaborators(project_id)]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE q'[CREATE INDEX idx_cat_collab_user ON cat_project_collaborators(user_id)]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE q'[
            CREATE TABLE cat_project_activity_log (
                log_id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                project_id NUMBER NOT NULL,
                user_id NUMBER,
                action VARCHAR2(50) NOT NULL,
                details_json CLOB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT fk_cat_activity_project
                    FOREIGN KEY (project_id)
                    REFERENCES cat_projects(project_id)
                    ON DELETE CASCADE,
                CONSTRAINT fk_cat_activity_user
                    FOREIGN KEY (user_id)
                    REFERENCES cat_users(user_id)
                    ON DELETE SET NULL
            )
        ]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE q'[CREATE INDEX idx_cat_activity_project ON cat_project_activity_log(project_id, created_at)]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN RAISE; END IF;
    END;
    """,
    """
    MERGE INTO cat_schema_migrations dst
    USING (SELECT '0011' AS mid, 'Per-project collaborator roles (cat_project_collaborators) + activity log (cat_project_activity_log)' AS descr FROM DUAL) src
    ON (dst.migration_id = src.mid)
    WHEN NOT MATCHED THEN INSERT (migration_id, description) VALUES (src.mid, src.descr)
    """,
    # -----------------------------------------------------------------
    # Lock gate for overlay transect/segment geometry editing.
    # Both features AND layers default LOCKED (is_locked=1) so every
    # existing row becomes locked on migration and every existing insert
    # path inherits the locked-by-default behavior with no code changes.
    # A stray Ctrl+drag must not be able to bulk-move an entire layer any
    # more than a plain drag should move one feature — the layer-level
    # lock requires the same deliberate one-click unlock before Ctrl+drag
    # does anything.
    # -----------------------------------------------------------------
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_overlay_features ADD (is_locked NUMBER(1) DEFAULT 1 NOT NULL)';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_overlay_features ADD (locked_by_user_id NUMBER)';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_overlay_features ADD (locked_at TIMESTAMP)';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_overlay_layers ADD (is_locked NUMBER(1) DEFAULT 1 NOT NULL)';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    """
    MERGE INTO cat_schema_migrations dst
    USING (SELECT '0012' AS mid, 'Overlay lock gate: is_locked (+locked_by_user_id/locked_at) on cat_overlay_features, is_locked on cat_overlay_layers (both default locked)' AS descr FROM DUAL) src
    ON (dst.migration_id = src.mid)
    WHEN NOT MATCHED THEN INSERT (migration_id, description) VALUES (src.mid, src.descr)
    """,
    # -----------------------------------------------------------------
    # Add a 'team_lead' global role, alongside the existing 'admin' and
    # 'annotator'. team_lead is a read/export elevated tier (see
    # _visible_project_where / _get_effective_project_role in
    # db_projects.py) — it does NOT gain admin's edit-everything or
    # user-management powers. Widening a CHECK constraint in Oracle means
    # drop + re-add; both sides tolerate "already done" re-runs (ORA-02443
    # = constraint doesn't exist, on the drop; a duplicate-name error on
    # the re-add would only happen if some other migration path already
    # created a constraint by this name with different rules, which none
    # does).
    # -----------------------------------------------------------------
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_users DROP CONSTRAINT ck_cat_users_role';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -2443 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE q'[ALTER TABLE cat_users ADD CONSTRAINT ck_cat_users_role CHECK (role IN ('admin', 'team_lead', 'annotator'))]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE NOT IN (-2264, -2265) THEN RAISE; END IF;
    END;
    """,
    """
    MERGE INTO cat_schema_migrations dst
    USING (SELECT '0013' AS mid, 'Add team_lead global role (widen ck_cat_users_role); open read-access baseline for all authenticated users' AS descr FROM DUAL) src
    ON (dst.migration_id = src.mid)
    WHEN NOT MATCHED THEN INSERT (migration_id, description) VALUES (src.mid, src.descr)
    """,
    # -----------------------------------------------------------------
    # Persist DEM matches independently from orthomosaic matches so a
    # DEM-only site survives reloads and project deletion.
    # -----------------------------------------------------------------
    """
    BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE cat_sites ADD (dem_uri VARCHAR2(4000))';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -1430 THEN RAISE; END IF;
    END;
    """,
    """
    MERGE INTO cat_schema_migrations dst
    USING (SELECT '0014' AS mid, 'Persist DEM COG URIs independently on cat_sites' AS descr FROM DUAL) src
    ON (dst.migration_id = src.mid)
    WHEN NOT MATCHED THEN INSERT (migration_id, description) VALUES (src.mid, src.descr)
    """,
    # -----------------------------------------------------------------
    # Team-lead annotation-form config, Phase 3 (docs/team-lead-config-plan.md):
    # every dropdown option, for every configurable annotation field, in one
    # table instead of duplicated as hardcoded lists in annotation.html, the
    # edit modal (annotation-form.js), and the batch-fill/bulk-update modals
    # (v2-table.js) — four copies of the same values that could already
    # silently drift from each other. Same rule as species (Phase 2): a
    # disabled option only affects what NEW selections offer; it never
    # touches, hides, or revalidates an existing annotation's saved value.
    # -----------------------------------------------------------------
    """
    BEGIN
        EXECUTE IMMEDIATE q'[
            CREATE TABLE cat_annotation_field_options (
                option_id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                field_name VARCHAR2(60) NOT NULL,
                option_value VARCHAR2(120) NOT NULL,
                option_label VARCHAR2(255),
                display_order NUMBER DEFAULT 0 NOT NULL,
                is_enabled NUMBER(1) DEFAULT 1 NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT uq_cat_field_options UNIQUE (field_name, option_value)
            )
        ]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN RAISE; END IF;
    END;
    """,
    """
    BEGIN
        EXECUTE IMMEDIATE q'[CREATE INDEX idx_cat_field_options_field ON cat_annotation_field_options(field_name)]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN RAISE; END IF;
    END;
    """,
    # Seed rows exactly matching today's hardcoded option lists, so importing
    # this migration changes nothing about what annotators see until a team
    # lead actually disables something. MERGE (not INSERT) so re-running is a
    # no-op and a value a team lead already disabled stays disabled across
    # every future deploy (the merge only inserts what's missing; it never
    # overwrites is_enabled on a matched row).
    """
    MERGE INTO cat_annotation_field_options dst
    USING (
        SELECT 'transect' AS field_name, 'A' AS option_value, 'A' AS option_label, 1 AS display_order FROM DUAL UNION ALL
        SELECT 'transect', 'B', 'B', 2 FROM DUAL
    ) src
    ON (dst.field_name = src.field_name AND dst.option_value = src.option_value)
    WHEN NOT MATCHED THEN INSERT (field_name, option_value, option_label, display_order)
        VALUES (src.field_name, src.option_value, src.option_label, src.display_order)
    """,
    """
    MERGE INTO cat_annotation_field_options dst
    USING (
        SELECT 'segment' AS field_name, '0' AS option_value, '0' AS option_label, 1 AS display_order FROM DUAL UNION ALL
        SELECT 'segment', '5', '5', 2 FROM DUAL UNION ALL
        SELECT 'segment', '10', '10', 3 FROM DUAL UNION ALL
        SELECT 'segment', '15', '15', 4 FROM DUAL
    ) src
    ON (dst.field_name = src.field_name AND dst.option_value = src.option_value)
    WHEN NOT MATCHED THEN INSERT (field_name, option_value, option_label, display_order)
        VALUES (src.field_name, src.option_value, src.option_label, src.display_order)
    """,
    """
    MERGE INTO cat_annotation_field_options dst
    USING (
        SELECT 'morph_code' AS field_name, 'BR' AS option_value, 'BR - Branching' AS option_label, 1 AS display_order FROM DUAL UNION ALL
        SELECT 'morph_code', 'CO', 'CO - Columnar', 2 FROM DUAL UNION ALL
        SELECT 'morph_code', 'EN', 'EN - Encrusting', 3 FROM DUAL UNION ALL
        SELECT 'morph_code', 'FO', 'FO - Foliaceous', 4 FROM DUAL UNION ALL
        SELECT 'morph_code', 'FL', 'FL - Free-living', 5 FROM DUAL UNION ALL
        SELECT 'morph_code', 'LA', 'LA - Laminar', 6 FROM DUAL UNION ALL
        SELECT 'morph_code', 'MD', 'MD - Mounding', 7 FROM DUAL UNION ALL
        SELECT 'morph_code', 'MA', 'MA - Massive', 8 FROM DUAL UNION ALL
        SELECT 'morph_code', 'PL', 'PL - Plating', 9 FROM DUAL UNION ALL
        SELECT 'morph_code', 'SM', 'SM - Submassive', 10 FROM DUAL UNION ALL
        SELECT 'morph_code', 'SO', 'SO - Solitary', 11 FROM DUAL UNION ALL
        SELECT 'morph_code', 'TB', 'TB - Tabular', 12 FROM DUAL
    ) src
    ON (dst.field_name = src.field_name AND dst.option_value = src.option_value)
    WHEN NOT MATCHED THEN INSERT (field_name, option_value, option_label, display_order)
        VALUES (src.field_name, src.option_value, src.option_label, src.display_order)
    """,
    # No bind variables here: bootstrap_schema() runs every DDL_BLOCKS entry
    # with execute(ddl) and no params, so each Yes/No field is spelled out
    # literally rather than parameterized.
    """
    MERGE INTO cat_annotation_field_options dst
    USING (
        SELECT 'no_colony' AS field_name, '0' AS option_value, 'No' AS option_label, 1 AS display_order FROM DUAL UNION ALL
        SELECT 'no_colony', '-1', 'Yes', 2 FROM DUAL UNION ALL
        SELECT 'juvenile', '0', 'No', 1 FROM DUAL UNION ALL
        SELECT 'juvenile', '-1', 'Yes', 2 FROM DUAL UNION ALL
        SELECT 'remnant', '0', 'No', 1 FROM DUAL UNION ALL
        SELECT 'remnant', '-1', 'Yes', 2 FROM DUAL UNION ALL
        SELECT 'ex_bound', '0', 'No', 1 FROM DUAL UNION ALL
        SELECT 'ex_bound', '-1', 'Yes', 2 FROM DUAL
    ) src
    ON (dst.field_name = src.field_name AND dst.option_value = src.option_value)
    WHEN NOT MATCHED THEN INSERT (field_name, option_value, option_label, display_order)
        VALUES (src.field_name, src.option_value, src.option_label, src.display_order)
    """,
    # JUV_SUBSTRATE_OPTIONS (annotation-form.js) — a free-typed autocomplete
    # today, not a <select>, but the same "team lead curates the suggestion
    # list" idea applies. No display label distinct from the code.
    """
    MERGE INTO cat_annotation_field_options dst
    USING (
        SELECT 'juv_substrate' AS field_name, 'CCAH' AS option_value, 'CCAH' AS option_label, 1 AS display_order FROM DUAL UNION ALL
        SELECT 'juv_substrate', 'CCAR', 'CCAR', 2 FROM DUAL UNION ALL
        SELECT 'juv_substrate', 'TURFH', 'TURFH', 3 FROM DUAL UNION ALL
        SELECT 'juv_substrate', 'TURFR', 'TURFR', 4 FROM DUAL UNION ALL
        SELECT 'juv_substrate', 'EMA', 'EMA', 5 FROM DUAL UNION ALL
        SELECT 'juv_substrate', 'PESP', 'PESP', 6 FROM DUAL UNION ALL
        SELECT 'juv_substrate', 'LOBO', 'LOBO', 7 FROM DUAL UNION ALL
        SELECT 'juv_substrate', 'HARD', 'HARD', 8 FROM DUAL UNION ALL
        SELECT 'juv_substrate', 'CORAL', 'CORAL', 9 FROM DUAL UNION ALL
        SELECT 'juv_substrate', 'RUB', 'RUB', 10 FROM DUAL UNION ALL
        SELECT 'juv_substrate', 'HALI', 'HALI', 11 FROM DUAL
    ) src
    ON (dst.field_name = src.field_name AND dst.option_value = src.option_value)
    WHEN NOT MATCHED THEN INSERT (field_name, option_value, option_label, display_order)
        VALUES (src.field_name, src.option_value, src.option_label, src.display_order)
    """,
    """
    MERGE INTO cat_schema_migrations dst
    USING (SELECT '0015' AS mid, 'Team-lead annotation-form config: cat_annotation_field_options table, seeded from the previously-hardcoded option lists' AS descr FROM DUAL) src
    ON (dst.migration_id = src.mid)
    WHEN NOT MATCHED THEN INSERT (migration_id, description) VALUES (src.mid, src.descr)
    """,
    # -----------------------------------------------------------------
    # Team-lead annotation-form config, Phase 4 candidate (docs/team-lead-
    # config-plan.md): a deployment-wide default VALUE per field, sitting
    # beneath the existing session (localStorage "Set Defaults") and account
    # (Preferences -> Default annotation settings) tiers in v2-defaults.js —
    # applied only when neither of those has already set a value. Empty
    # table = no behavior change from today.
    # -----------------------------------------------------------------
    """
    BEGIN
        EXECUTE IMMEDIATE q'[
            CREATE TABLE cat_annotation_field_defaults (
                field_name VARCHAR2(60) NOT NULL PRIMARY KEY,
                default_value VARCHAR2(255) NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_by_user_id NUMBER
            )
        ]';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE != -955 THEN RAISE; END IF;
    END;
    """,
    """
    MERGE INTO cat_schema_migrations dst
    USING (SELECT '0016' AS mid, 'Team-lead annotation-form config: cat_annotation_field_defaults table (deployment-wide default values)' AS descr FROM DUAL) src
    ON (dst.migration_id = src.mid)
    WHEN NOT MATCHED THEN INSERT (migration_id, description) VALUES (src.mid, src.descr)
    """,
]


def _seed_bootstrap_admin() -> None:
    """Idempotently create a first admin user from CAT_AUTH_BOOTSTRAP_ADMIN_* env vars, if set."""
    try:
        from .config import get_auth_settings
        from .auth import hash_password

        auth_settings = get_auth_settings()
        if not (
            auth_settings.bootstrap_admin_username
            and auth_settings.bootstrap_admin_email
            and auth_settings.bootstrap_admin_password
        ):
            return

        password_hash = hash_password(auth_settings.bootstrap_admin_password)
        execute(
            """
            MERGE INTO cat_users dst
            USING (
                SELECT :username AS u, :email AS e, :password_hash AS p, :display_name AS d FROM DUAL
            ) src
            ON (dst.username = src.u)
            WHEN NOT MATCHED THEN INSERT (username, email, password_hash, display_name, role)
                VALUES (src.u, src.e, src.p, src.d, 'admin')
            """,
            {
                "username": auth_settings.bootstrap_admin_username,
                "email": auth_settings.bootstrap_admin_email,
                "password_hash": password_hash,
                "display_name": auth_settings.bootstrap_admin_username,
            },
        )
    except Exception:
        # Bootstrap admin seeding is optional — never fail startup because of it.
        pass


def bootstrap_schema() -> dict:
    for ddl in DDL_BLOCKS:
        execute(ddl)

    _seed_bootstrap_admin()

    # Read back the applied migrations for the summary
    try:
        from .oracle import get_connection
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT migration_id, description FROM cat_schema_migrations ORDER BY migration_id"
                )
                migrations = [
                    {"id": row[0], "description": row[1]} for row in cur.fetchall()
                ]
                schema_version = migrations[-1]["id"] if migrations else "unknown"
    except Exception:
        migrations = []
        schema_version = "unknown"

    return {
        "success": True,
        "schema_version": schema_version,
        "migrations": migrations,
        "tables": [
            "cat_projects",
            "cat_project_assets",
            "cat_annotations",
            "cat_annotation_sessions",
            "cat_overlay_layers",
            "cat_overlay_features",
            "cat_sites",
            "cat_site_visits",
            "cat_coral_species",
            "cat_schema_migrations",
            "cat_users",
            "cat_sessions",
        ],
    }