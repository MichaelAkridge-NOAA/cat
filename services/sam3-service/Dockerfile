# CAT SAM3 segmentation microservice.
#
# GPU-accelerated FastAPI service wrapping segment-geospatial's SamGeo3
# for text/point/box/tiled segmentation of coral orthomosaic COGs.
# Runs alongside (not inside) the main cat-app container.

# pytorch/pytorch:*-cuda12.6-cudnn9-runtime ships Python 3.11, but SAM3's
# stated minimum is Python >= 3.12 -- build on a plain CUDA/cuDNN base and
# install Python 3.12 + torch ourselves instead of fighting the pytorch
# image's fixed conda Python version.
FROM nvidia/cuda:12.6.3-cudnn-runtime-ubuntu22.04

# gdal-bin/software-properties-common pull in tzdata as a dependency, whose
# postinst script prompts interactively for a timezone/geographic area
# unless the frontend is forced non-interactive -- without this the build
# just hangs waiting for input that never comes.
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

# rasterio/GDAL dependencies, git (needed to pip-install the sam3 package
# straight from its GitHub repo), curl (health checks/debugging), and
# Python 3.12 (via deadsnakes -- Ubuntu 22.04's default is 3.10).
RUN apt-get update && apt-get install -y --no-install-recommends \
    software-properties-common \
    && add-apt-repository -y ppa:deadsnakes/ppa \
    && apt-get update && apt-get install -y --no-install-recommends \
    python3.12 \
    python3.12-venv \
    python3.12-dev \
    gdal-bin \
    libgdal-dev \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN curl -sS https://bootstrap.pypa.io/get-pip.py | python3.12 && \
    ln -sf /usr/bin/python3.12 /usr/local/bin/python && \
    ln -sf /usr/bin/python3.12 /usr/local/bin/python3

# Fail the build early/loudly if this ever regresses, rather than
# discovering an incompatible interpreter at runtime.
RUN python -c "import sys; assert sys.version_info >= (3, 12), f'SAM3 requires Python >= 3.12, found {sys.version}'"

WORKDIR /app

# torch isn't in requirements.txt (it came from the old pytorch/pytorch
# base image); install the CUDA 12.6 wheel explicitly, in its own layer so
# a requirements.txt-only change below doesn't force re-downloading it.
RUN python -m pip install --no-cache-dir torch==2.7.0 --index-url https://download.pytorch.org/whl/cu126

COPY requirements.txt .
RUN python -m pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8100

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
