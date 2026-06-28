FROM nvidia/cuda:12.4.1-cudnn-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    git \
    python3 \
    python3-pip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN python3 -m pip install --no-cache-dir --upgrade pip \
  && python3 -m pip install --no-cache-dir -r requirements.txt

COPY server.py .

ENV LOCAL_STT_HOST=0.0.0.0
ENV LOCAL_STT_PORT=8011
ENV LOCAL_STT_MODEL=OzLabs/Caspi-1.7B
ENV LOCAL_STT_LANGUAGE=Hebrew
ENV LOCAL_STT_GPU_MEMORY_UTILIZATION=0.9
ENV LOCAL_STT_CONFIRMATION_ENABLED=true
ENV LOCAL_STT_ROLLING_BUFFER_SECONDS=20
ENV LOCAL_STT_MAX_NEW_TOKENS=32
ENV LOCAL_STT_UNFIXED_CHUNK_NUM=2
ENV LOCAL_STT_UNFIXED_TOKEN_NUM=5
ENV LOCAL_STT_CHUNK_SIZE_SEC=2.0

EXPOSE 8011

CMD ["python3", "server.py"]
