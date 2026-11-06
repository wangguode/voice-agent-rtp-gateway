FROM python:3.12-slim

WORKDIR /app
COPY pyproject.toml README.md .env.example ./
COPY src ./src

RUN pip install --no-cache-dir -e .

EXPOSE 8765
CMD ["wg-voice", "serve", "--host", "0.0.0.0", "--port", "8765"]
