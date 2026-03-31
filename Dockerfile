# =============================================================================
# Dockerfile for CAT: Coral Annotation Tool
# =============================================================================
# Multi-stage build for smaller final image
# Supports both file-mode (JSON) and database mode (Oracle)
# =============================================================================

FROM python:3.11-slim AS builder

# Set working directory
WORKDIR /build

# Install system dependencies needed for compilation
RUN apt-get update && apt-get install -y \
    gdal-bin \
    libgdal-dev \
    gcc \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set GDAL environment variables for rasterio compilation
ENV GDAL_CONFIG=/usr/bin/gdal-config
ENV CPLUS_INCLUDE_PATH=/usr/include/gdal
ENV C_INCLUDE_PATH=/usr/include/gdal

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

# =============================================================================
# Final stage - slim runtime image
# =============================================================================
FROM python:3.11-slim

# Install runtime GDAL dependencies only
RUN apt-get update && apt-get install -y \
    gdal-bin \
    libgdal-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Set GDAL environment variables
ENV GDAL_CONFIG=/usr/bin/gdal-config
ENV CPLUS_INCLUDE_PATH=/usr/include/gdal
ENV C_INCLUDE_PATH=/usr/include/gdal

# Set environment for GCS access (public buckets, no auth)
ENV GS_NO_SIGN_REQUEST=YES
ENV GDAL_HTTP_MERGE_CONSECUTIVE_RANGES=YES
ENV GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR
ENV CPL_VSIL_CURL_ALLOWED_EXTENSIONS=.tif,.tiff

# Create app user for security (non-root)
RUN useradd -m -u 1000 -s /bin/bash catuser

# Set working directory
WORKDIR /app

# Copy Python packages from builder
COPY --from=builder /root/.local /home/catuser/.local

# Copy application source
COPY --chown=catuser:catuser cat/ ./cat/
COPY --chown=catuser:catuser main.py .
COPY --chown=catuser:catuser pyproject.toml .
COPY --chown=catuser:catuser MANIFEST.in .
COPY --chown=catuser:catuser requirements.txt .
COPY --chown=catuser:catuser LICENSE.md .
COPY --chown=catuser:catuser README.md .

# Copy startup script
COPY --chown=catuser:catuser startup.sh .
RUN chmod +x /app/startup.sh

# Create necessary directories with correct permissions
RUN mkdir -p /app/data /app/data/reference /app/exports /app/logs && \
    chown -R catuser:catuser /app

# Switch to non-root user
USER catuser

# Add local Python packages to PATH
ENV PATH=/home/catuser/.local/bin:$PATH

# Expose the application port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=5 \
    CMD curl -f http://localhost:8000/health || exit 1

# Run the application via startup script (handles bootstrap)
CMD ["/bin/bash", "/app/startup.sh"]
