# CAT Database Edition User Guide

This branch contains the source for the database-backed CAT user guide published with GitHub Pages. Application code and deployment configuration live on the `main` branch.

## Contents

- `docs/` - SOP pages and sanitized screenshots
- `mkdocs.yml` - MkDocs Material configuration and navigation
- `docs/requirements.txt` - documentation-only Python dependencies
- `.github/workflows/deploy-docs.yml` - validation and GitHub Pages deployment

## Local preview

```bash
conda create -n cat-docs python=3.11 -y
conda activate cat-docs
python -m pip install -r docs/requirements.txt
python -m mkdocs serve
```

Open `http://127.0.0.1:8000/cat/`.

## Validation

```bash
python -m mkdocs build --strict
```

The generated `site/` directory is local build output and is not committed.

## Deployment

Pushes to `gh_pages` trigger the Pages workflow. Pull requests targeting `gh_pages` run the strict build without deploying.

In repository settings, configure **Pages** > **Build and deployment** > **Source** as **GitHub Actions**.
