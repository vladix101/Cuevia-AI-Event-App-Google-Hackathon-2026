# Cuevia private AI service. Build from ai/:  docker build -t cuevia-ai .
FROM python:3.12-slim

# ffmpeg lets /transcribe accept webm/ogg/mp3 chunks; PCM WAV works without it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY cuevia_ai ./cuevia_ai

RUN useradd --create-home --uid 10001 cuevia
USER cuevia

ENV AI_BIND_HOST=0.0.0.0 \
    PYTHONUNBUFFERED=1
EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8001/internal/v1/health', timeout=4)"
CMD ["python", "-m", "cuevia_ai.main"]
