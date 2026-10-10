# Attacked.ai API: the container Cloud Run runs (deploy/gcp/cloudbuild.yaml builds it).
#
#   docker build -t attacked-api api/
#   docker run -p 8080:8080 --env-file api/.env attacked-api
#
# Cloud Run sends traffic to $PORT (8080). One uvicorn worker per container:
# Cloud Run scales by adding containers, not processes. Secrets arrive as env
# vars mounted from Secret Manager; nothing secret is baked into the image.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8080

WORKDIR /srv/api

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app

# Run as an unprivileged user.
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin api
USER api

EXPOSE 8080
# --proxy-headers: Cloud Run and Firebase Hosting sit in front and set
# X-Forwarded-For / -Proto, which the API uses for rate limits and Secure cookies.
CMD exec uvicorn app.main:app --host 0.0.0.0 --port "$PORT" --proxy-headers --forwarded-allow-ips="*" --no-server-header
