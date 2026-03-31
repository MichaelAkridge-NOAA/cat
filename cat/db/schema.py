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
                survey_date       VARCHAR2(50),
                cruise_leg        VARCHAR2(120),
                photographer      VARCHAR2(120),
                team              VARCHAR2(120),
                region            VARCHAR2(50),
                island            VARCHAR2(120),
                sector            VARCHAR2(120),
                survey_size       VARCHAR2(255),
                latitude          NUMBER,
                longitude         NUMBER,
                survey_type       VARCHAR2(120),
                total_images      VARCHAR2(255),
                notes             VARCHAR2(2000),
                modeling_priority VARCHAR2(255),
                annotation_time   VARCHAR2(255)
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
]


def bootstrap_schema() -> dict:
    for ddl in DDL_BLOCKS:
        execute(ddl)

    return {
        "success": True,
        "tables": [
            "cat_projects",
            "cat_project_assets",
            "cat_annotations",
            "cat_annotation_sessions",
            "cat_overlay_layers",
            "cat_overlay_features",
            "cat_sites",
            "cat_site_visits",
        ],
    }