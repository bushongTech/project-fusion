FROM python:3.12-slim

WORKDIR /app
ENV PYTHONBUFFERED=1
COPY multi_translator_sim.py .

RUN pip install --no-cache-dir aio_pika

CMD ["python", "multi_translator_sim.py"]