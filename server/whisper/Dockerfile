FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/whisper/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY server/whisper ./server/whisper
RUN useradd --create-home --uid 10001 whisper \
    && mkdir -p /app/.data/whisper-models \
    && chown -R whisper:whisper /app/.data
USER whisper
WORKDIR /app/server/whisper
EXPOSE 3104
CMD ["uvicorn", "local-server:app", "--host", "0.0.0.0", "--port", "3104"]
