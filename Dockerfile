FROM python:3.12-slim

WORKDIR /app

# Cria diretório persistente para o banco SQLite
RUN mkdir -p /app/data

COPY index.html styles.css db.js app.js server.py /app/

ENV PORT=8080
ENV HOST=0.0.0.0
ENV DB_PATH=/app/data/database.db

EXPOSE 8080

CMD ["python3", "server.py"]
